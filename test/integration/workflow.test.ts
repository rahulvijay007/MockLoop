import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { persistReport } from "../../src/memory/profile";
import { PROMPT_VERSIONS } from "../../src/prompts";
import type { ImprovementPlan } from "../../src/prompts/improvement-plan.v1";
import { aggregateScores } from "../../src/rubric/aggregate";
import { RUBRICS } from "../../src/rubric/rubrics";
import {
  api,
  connect,
  newUserId,
  startInterview,
  technicalConfig,
  type TestSocket,
} from "./helpers";

/**
 * Evaluation Workflow end to end: session DO → Workflow (fake AI) → D1 →
 * callback to the DO → next session reads the weak-area profile.
 */

async function finishInterview(socket: TestSocket, answers: string[]) {
  for (const a of answers) await socket.answer(a);
  const mark = socket.mark;
  socket.send({ type: "end" });
  // The interviewer streams a closing message, then the Workflow starts.
  await socket.next((f) => f.type === "message_end", mark);
  return socket.state((s) => s.status === "evaluating", mark);
}

describe("evaluation workflow", () => {
  it("scores every answer, persists a report and weak areas, and notifies the session", async () => {
    const introspector = await introspectWorkflow(env.EVALUATION_WORKFLOW);
    try {
      const { sessionId, userId, socket } = await startInterview();
      const evaluating = await finishInterview(socket, [
        "WEAK: I would just add more servers.",
        "WEAK: caching makes it faster.",
      ]);
      expect(evaluating.evaluation?.instanceId).toBe(`eval-${sessionId}`);

      const [instance] = await introspector.get();
      if (!instance) throw new Error("workflow instance was not created");
      await instance.waitForStatus("complete");

      // Each step ran and checkpointed its result.
      const transcript = (await instance.waitForStepResult({ name: "load-transcript" })) as {
        exchanges: unknown[];
      };
      expect(transcript.exchanges).toHaveLength(2);
      await instance.waitForStepResult({ name: "score-answer-1" });
      await instance.waitForStepResult({ name: "score-answer-2" });
      const aggregate = (await instance.waitForStepResult({ name: "aggregate" })) as {
        overall: number;
      };
      expect(aggregate.overall).toBe(2);
      expect(await instance.getOutput()).toMatchObject({ sessionId, overallScore: 2 });

      // The session DO got the completion callback and synced it to the client.
      const done = await socket.state((s) => s.status === "done");
      expect(done.evaluation?.overallScore).toBe(2);
      socket.close();

      // D1: report + one observation per weak dimension.
      const report = await env.DB.prepare("SELECT * FROM reports WHERE session_id = ?")
        .bind(sessionId)
        .first<{
          overall_score: number;
          prompt_versions_json: string;
        }>();
      expect(report?.overall_score).toBe(2);
      expect(JSON.parse(report?.prompt_versions_json ?? "{}")).toEqual(PROMPT_VERSIONS);
      const { results: weak } = await env.DB.prepare(
        "SELECT area FROM weak_area_observations WHERE session_id = ? ORDER BY area",
      )
        .bind(sessionId)
        .all<{ area: string }>();
      expect(weak.map((w) => w.area)).toEqual(RUBRICS.technical.dimensions.map((d) => d.id).sort());

      // Report API is scoped to its owner.
      const mine = await api(`/api/sessions/${sessionId}/report`, userId);
      expect(mine.status).toBe(200);
      const body = await mine.json<{ plan: ImprovementPlan }>();
      expect(body.plan.priorities.length).toBeGreaterThan(0);
      const theirs = await api(`/api/sessions/${sessionId}/report`, newUserId());
      expect(theirs.status).toBe(404);

      // Memory loop: the user's NEXT session is seeded with recurring weak areas.
      const res = await api("/api/sessions", userId, {
        method: "POST",
        body: JSON.stringify(technicalConfig),
      });
      const next = await res.json<{ sessionId: string; focusAreas: { area: string }[] }>();
      expect(next.focusAreas).toHaveLength(3);
      const nextSocket = await connect(next.sessionId, userId);
      const nextState = await nextSocket.state((s) => s.status === "active");
      expect(nextState.focusAreas.map((w) => w.area)).toEqual(next.focusAreas.map((w) => w.area));
      nextSocket.close();
    } finally {
      await introspector.dispose();
    }
  });

  it("repairs malformed scorer output inside the step", async () => {
    const introspector = await introspectWorkflow(env.EVALUATION_WORKFLOW);
    try {
      const { socket } = await startInterview();
      await finishInterview(socket, ["STRONG MALFORMED: a detailed answer"]);
      const [instance] = await introspector.get();
      if (!instance) throw new Error("workflow instance was not created");
      await instance.waitForStatus("complete");
      expect(await instance.getOutput()).toMatchObject({ overallScore: 5 });
      socket.close();
    } finally {
      await introspector.dispose();
    }
  });

  it("retries a failing scoring step and still completes", async () => {
    const introspector = await introspectWorkflow(env.EVALUATION_WORKFLOW);
    try {
      await introspector.modifyAll(async (m) => {
        await m.disableRetryDelays();
        await m.mockStepError({ name: "score-answer-1" }, new Error("Workers AI 503"), 2);
      });
      const { socket } = await startInterview();
      await finishInterview(socket, ["An average answer."]);
      const [instance] = await introspector.get();
      if (!instance) throw new Error("workflow instance was not created");
      await instance.waitForStatus("complete");
      await socket.state((s) => s.status === "done");
      socket.close();
    } finally {
      await introspector.dispose();
    }
  });

  it("surfaces a permanently failing evaluation to the session as retryable", async () => {
    const introspector = await introspectWorkflow(env.EVALUATION_WORKFLOW);
    try {
      await introspector.modifyAll(async (m) => {
        await m.disableRetryDelays();
        await m.mockStepError({ name: "improvement-plan" }, new Error("model unavailable"));
      });
      const { socket } = await startInterview();
      await finishInterview(socket, ["An average answer."]);
      const [instance] = await introspector.get();
      if (!instance) throw new Error("workflow instance was not created");
      await instance.waitForStatus("errored");
      const failed = await socket.state((s) => s.status === "failed");
      expect(failed.evaluation?.error).toMatch(/retry/i);
      socket.close();
    } finally {
      await introspector.dispose();
    }
  });
});

describe("persist step idempotency", () => {
  it("running persist twice for the same session leaves exactly one report and one set of weak areas", async () => {
    const rubric = RUBRICS.technical;
    const questionScores = [
      {
        index: 0,
        questionId: "q1",
        scores: { correctness: 2, depth: 2, tradeoffs: 4, problem_solving: 4, communication: 4 },
        evidence: "e",
        strengths: [],
        gaps: ["shallow"],
      },
    ];
    const record = {
      sessionId: crypto.randomUUID(),
      userId: newUserId(),
      config: technicalConfig,
      aggregate: aggregateScores(rubric, questionScores),
      questionScores,
      plan: { summary: "s", priorities: [], practice_questions: [] },
      modelId: env.MODEL_ID,
      promptVersions: PROMPT_VERSIONS,
      createdAt: Date.now(),
    };
    await persistReport(env.DB, record);
    await persistReport(env.DB, record);

    const reports = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE session_id = ?")
      .bind(record.sessionId)
      .first<{ n: number }>();
    const weak = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM weak_area_observations WHERE session_id = ?",
    )
      .bind(record.sessionId)
      .first<{ n: number }>();
    expect(reports?.n).toBe(1);
    expect(weak?.n).toBe(2); // correctness + depth
  });
});
