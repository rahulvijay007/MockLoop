import { describe, expect, it } from "vitest";
import type { TurnAnalysis } from "../../src/prompts/turn-analysis.v1";
import { MAX_FOLLOWUPS_PER_TOPIC, decideNextTurn } from "../../src/session/turn";

const analysis = (over: Partial<TurnAnalysis> = {}): TurnAnalysis => ({
  topic: "caching",
  answer_quality: "adequate",
  note: "ok",
  action: "next",
  followup_focus: null,
  next_topic: "queues",
  difficulty_delta: 0,
  ...over,
});

const base = { difficulty: 3, followUpsOnTopic: 0, turnCount: 1, maxTurns: 12 };

describe("decideNextTurn", () => {
  it("follows the model's follow-up proposal within the depth limit", () => {
    const d = decideNextTurn({
      ...base,
      analysis: analysis({ action: "followup", followup_focus: "eviction" }),
    });
    expect(d.plan).toEqual({ action: "followup", focus: "eviction" });
  });

  it(`forces a new topic after ${String(MAX_FOLLOWUPS_PER_TOPIC)} follow-ups`, () => {
    const d = decideNextTurn({
      ...base,
      followUpsOnTopic: MAX_FOLLOWUPS_PER_TOPIC,
      analysis: analysis({ action: "followup", followup_focus: "eviction" }),
    });
    expect(d.plan).toEqual({ action: "next", topic: "queues" });
  });

  it("treats a follow-up without a focus as moving on", () => {
    const d = decideNextTurn({
      ...base,
      analysis: analysis({ action: "followup", followup_focus: "  " }),
    });
    expect(d.plan.action).toBe("next");
  });

  it("adapts difficulty and clamps it to 1..5", () => {
    const up = analysis({ difficulty_delta: 1 });
    const down = analysis({ difficulty_delta: -1 });
    expect(decideNextTurn({ ...base, analysis: up }).difficulty).toBe(4);
    expect(decideNextTurn({ ...base, difficulty: 5, analysis: up }).difficulty).toBe(5);
    expect(decideNextTurn({ ...base, difficulty: 1, analysis: down }).difficulty).toBe(1);
  });

  it("closes the interview at the turn cap regardless of the model", () => {
    const d = decideNextTurn({
      ...base,
      turnCount: 12,
      analysis: analysis({ action: "followup", followup_focus: "x" }),
    });
    expect(d.plan).toEqual({ action: "close" });
  });

  it("falls back to a neutral next question when analysis failed", () => {
    expect(decideNextTurn({ ...base, analysis: null })).toEqual({
      plan: { action: "next", topic: null },
      difficulty: 3,
    });
  });
});
