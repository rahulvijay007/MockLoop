import type { Exchange, SessionConfig, WeakArea } from "../domain";
import type { LlmClient } from "../llm/client";
import { generateJson } from "../llm/json";
import { improvementPlan, scoreAnswer } from "../prompts";
import type { ImprovementPlan } from "../prompts/improvement-plan.v1";
import type { Aggregate, QuestionScore } from "../rubric/aggregate";
import { RUBRICS } from "../rubric/rubrics";

/**
 * The LLM-backed evaluation operations, free of any Workers-only imports.
 * The Workflow wraps each call in a durable step; the eval script calls the
 * very same functions over the Workers AI REST API, so it measures exactly
 * what production runs.
 */

export async function scoreExchange(
  llm: LlmClient,
  config: SessionConfig,
  exchange: Exchange,
): Promise<QuestionScore> {
  const rubric = RUBRICS[config.type];
  const { data } = await generateJson({
    llm,
    schema: scoreAnswer.scoreSchema(rubric),
    messages: scoreAnswer.build(config, rubric, exchange),
    maxTokens: 600,
    temperature: 0,
  });
  return {
    index: exchange.index,
    questionId: exchange.questionId,
    scores: data.scores,
    evidence: data.evidence,
    strengths: data.strengths,
    gaps: data.gaps,
  };
}

export async function writeImprovementPlan(
  llm: LlmClient,
  config: SessionConfig,
  aggregate: Aggregate,
  questionScores: QuestionScore[],
  priorWeakAreas: WeakArea[],
): Promise<ImprovementPlan> {
  const rubric = RUBRICS[config.type];
  const { data } = await generateJson({
    llm,
    schema: improvementPlan.planSchema(rubric),
    messages: improvementPlan.build({ config, rubric, aggregate, questionScores, priorWeakAreas }),
    maxTokens: 900,
    temperature: 0.2,
  });
  return data;
}
