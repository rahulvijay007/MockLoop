import type { Rubric } from "./rubrics";

/**
 * Pure, deterministic aggregation of per-question scores against a rubric.
 * Runs as its own Workflow step, but has no I/O so it is trivially unit-tested.
 */

/** A dimension scoring below this is a weak area; at or above STRENGTH_THRESHOLD a strength. */
export const WEAK_THRESHOLD = 3;
export const STRENGTH_THRESHOLD = 4;

export interface QuestionScore {
  index: number;
  questionId: string;
  /** 1–5 per rubric dimension id; null = not applicable to this answer. */
  scores: Record<string, number | null>;
  evidence: string;
  strengths: string[];
  gaps: string[];
}

export interface DimensionResult {
  id: string;
  score: number | null;
  weight: number;
  /** How many answers contributed a score to this dimension. */
  samples: number;
}

export interface Aggregate {
  overall: number;
  dimensions: DimensionResult[];
  /** Weakest first. */
  weakAreas: { id: string; score: number; evidence: string }[];
  strengths: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function aggregateScores(rubric: Rubric, questionScores: QuestionScore[]): Aggregate {
  if (questionScores.length === 0) {
    throw new Error("cannot aggregate an interview with no scored answers");
  }

  const dimensions: DimensionResult[] = rubric.dimensions.map((d) => {
    const values = questionScores
      .map((q) => q.scores[d.id])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
      .map((v) => Math.min(5, Math.max(1, v)));
    const score = values.length ? round2(values.reduce((a, b) => a + b, 0) / values.length) : null;
    return { id: d.id, score, weight: d.weight, samples: values.length };
  });

  // Renormalise weights over the dimensions that actually received scores, so
  // a dimension that never applied doesn't drag the overall score toward 0.
  const scored = dimensions.filter(
    (d): d is DimensionResult & { score: number } => d.score !== null,
  );
  if (scored.length === 0) {
    throw new Error("no rubric dimension received a score");
  }
  const weightSum = scored.reduce((a, d) => a + d.weight, 0);
  const overall = round2(scored.reduce((a, d) => a + d.score * d.weight, 0) / weightSum);

  const weakAreas = scored
    .filter((d) => d.score < WEAK_THRESHOLD)
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
    .map((d) => ({ id: d.id, score: d.score, evidence: worstEvidence(d.id, questionScores) }));

  const strengths = scored.filter((d) => d.score >= STRENGTH_THRESHOLD).map((d) => d.id);

  return { overall, dimensions, weakAreas, strengths };
}

/** Evidence from the answer that scored lowest on this dimension. */
function worstEvidence(dimensionId: string, questionScores: QuestionScore[]): string {
  let worst: QuestionScore | undefined;
  let worstScore = Infinity;
  for (const q of questionScores) {
    const s = q.scores[dimensionId];
    if (typeof s === "number" && s < worstScore) {
      worst = q;
      worstScore = s;
    }
  }
  const gap = worst?.gaps[0];
  return (gap ?? worst?.evidence ?? "").slice(0, 280);
}
