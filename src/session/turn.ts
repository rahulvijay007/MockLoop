import type { TurnPlan } from "../prompts/interviewer.v1";
import type { TurnAnalysis } from "../prompts/turn-analysis.v1";

/**
 * Deterministic guards around the model's turn proposal. The LLM suggests;
 * this code decides. Keeps turn caps, follow-up depth and difficulty bounds
 * enforceable and testable regardless of what the model outputs, and gives
 * a sane fallback when the analysis call fails entirely.
 */

export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 5;
export const MAX_FOLLOWUPS_PER_TOPIC = 2;

export interface TurnDecisionInput {
  /** null when the turn-analysis call failed or produced unusable output. */
  analysis: TurnAnalysis | null;
  difficulty: number;
  followUpsOnTopic: number;
  /** Candidate answers so far, including the one just received. */
  turnCount: number;
  maxTurns: number;
}

export interface TurnDecision {
  plan: TurnPlan;
  difficulty: number;
}

export function clampDifficulty(n: number): number {
  return Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, Math.round(n)));
}

export function decideNextTurn(input: TurnDecisionInput): TurnDecision {
  const { analysis, followUpsOnTopic, turnCount, maxTurns } = input;
  const difficulty = clampDifficulty(input.difficulty + (analysis?.difficulty_delta ?? 0));

  if (turnCount >= maxTurns) return { plan: { action: "close" }, difficulty };

  if (!analysis) return { plan: { action: "next", topic: null }, difficulty };

  const focus = analysis.followup_focus?.trim();
  if (analysis.action === "followup" && focus && followUpsOnTopic < MAX_FOLLOWUPS_PER_TOPIC) {
    return { plan: { action: "followup", focus }, difficulty };
  }

  return { plan: { action: "next", topic: analysis.next_topic?.trim() || null }, difficulty };
}
