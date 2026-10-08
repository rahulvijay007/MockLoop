import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";
import type { SessionConfig, Transcript } from "../domain";
import { scoreExchange, writeImprovementPlan } from "../evaluation/steps";
import { workersAiClient } from "../llm/client";
import { persistReport } from "../memory/profile";
import { PROMPT_VERSIONS } from "../prompts";
import type { ImprovementPlan } from "../prompts/improvement-plan.v1";
import { aggregateScores, type Aggregate, type QuestionScore } from "../rubric/aggregate";
import { RUBRICS } from "../rubric/rubrics";
import type { EvaluationParams, InterviewSession } from "../session/InterviewSession";

/**
 * Post-interview evaluation, as a durable Cloudflare Workflow:
 *
 *   load-transcript → score-answer-1..N → aggregate → improvement-plan → persist-report
 *
 * Every step's return value is checkpointed by the Workflows engine, so a
 * retry or a restart after a crash resumes from the first unfinished step
 * and never re-scores (or re-bills) an answer that was already scored.
 * Each step is idempotent: reads are pure, LLM steps have no side effects,
 * and the only write (persist-report) is an upsert keyed by session id.
 */

/** LLM steps: transient Workers AI errors and twice-malformed output both retry with backoff. */
const LLM_STEP = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

const IO_STEP = {
  retries: { limit: 5, delay: "2 seconds", backoff: "exponential" },
  timeout: "30 seconds",
} as const;

export interface EvaluationResult {
  sessionId: string;
  overallScore: number;
  weakAreas: string[];
}

export class EvaluationWorkflow extends AgentWorkflow<InterviewSession, EvaluationParams> {
  override async run(
    event: AgentWorkflowEvent<EvaluationParams>,
    step: AgentWorkflowStep,
  ): Promise<EvaluationResult> {
    const { sessionId, userId } = event.payload;
    const llm = workersAiClient(this.env.AI, this.env.MODEL_ID);

    // 1. Snapshot the transcript from the session Durable Object (RPC). The
    //    checkpointed copy is what every later step sees, even on retry.
    const transcript = await step.do("load-transcript", IO_STEP, async () => {
      const t: Transcript = await this.agent.getTranscript();
      if (t.sessionId !== sessionId || t.userId !== userId) {
        throw new NonRetryableError("transcript does not belong to this evaluation");
      }
      if (t.exchanges.length === 0) {
        throw new NonRetryableError("no answered questions to evaluate");
      }
      return t;
    });

    const config: SessionConfig = transcript.config;
    const rubric = RUBRICS[config.type];
    const total = transcript.exchanges.length;

    // 2. Score each answer in its own step: one failure retries one answer.
    const questionScores: QuestionScore[] = [];
    for (const exchange of transcript.exchanges) {
      await this.reportProgress({ message: `Scoring answer ${exchange.index + 1} of ${total}` });
      const score = await step.do(`score-answer-${exchange.index + 1}`, LLM_STEP, () =>
        scoreExchange(llm, config, exchange),
      );
      questionScores.push(score);
    }

    // 3. Deterministic aggregation against the rubric weights.
    await this.reportProgress({ message: "Aggregating rubric scores" });
    const aggregate: Aggregate = await step.do("aggregate", async () => {
      try {
        return aggregateScores(rubric, questionScores);
      } catch (e) {
        // Same input, same result: retrying cannot help.
        throw new NonRetryableError((e as Error).message);
      }
    });

    // 4. Improvement plan grounded in the scorer's evidence.
    await this.reportProgress({ message: "Writing your improvement plan" });
    const plan: ImprovementPlan = await step.do("improvement-plan", LLM_STEP, () =>
      writeImprovementPlan(llm, config, aggregate, questionScores, transcript.focusAreas),
    );

    // 5. Persist report + weak areas to D1 (single transactional batch, upsert).
    await this.reportProgress({ message: "Saving report" });
    await step.do("persist-report", IO_STEP, async () => {
      await persistReport(this.env.DB, {
        sessionId,
        userId,
        config,
        aggregate,
        questionScores,
        plan,
        modelId: this.env.MODEL_ID,
        promptVersions: PROMPT_VERSIONS,
        createdAt: Date.parse(event.timestamp.toString()) || Date.now(),
      });
    });

    const result: EvaluationResult = {
      sessionId,
      overallScore: aggregate.overall,
      weakAreas: aggregate.weakAreas.map((w) => w.id),
    };
    await step.reportComplete(result);
    return result;
  }
}
