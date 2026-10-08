import { describe, expect, it } from "vitest";
import { aggregateScores, type QuestionScore } from "../../src/rubric/aggregate";
import { RUBRICS } from "../../src/rubric/rubrics";

const technical = RUBRICS.technical;

function q(
  index: number,
  scores: Record<string, number | null>,
  gaps: string[] = [],
): QuestionScore {
  return {
    index,
    questionId: `q${index}`,
    scores,
    evidence: `evidence ${index}`,
    strengths: [],
    gaps,
  };
}

const all = (v: number | null) => Object.fromEntries(technical.dimensions.map((d) => [d.id, v]));

describe("rubric weights", () => {
  it.each(Object.values(RUBRICS))("$type weights sum to 1", (rubric) => {
    const sum = rubric.dimensions.reduce((a, d) => a + d.weight, 0);
    expect(sum).toBeCloseTo(1, 10);
  });
});

describe("aggregateScores", () => {
  it("averages each dimension across answers and weights the overall score", () => {
    const result = aggregateScores(technical, [q(0, all(4)), q(1, all(2))]);
    for (const d of result.dimensions) expect(d.score).toBe(3);
    expect(result.overall).toBe(3);
  });

  it("applies rubric weights (correctness 0.3 outweighs communication 0.15)", () => {
    const scores = { correctness: 5, depth: 3, tradeoffs: 3, problem_solving: 3, communication: 1 };
    const result = aggregateScores(technical, [q(0, scores)]);
    // 5*.3 + 3*.25 + 3*.2 + 3*.1 + 1*.15 = 3.3
    expect(result.overall).toBe(3.3);
  });

  it("ignores null (not applicable) and renormalises weights over scored dimensions", () => {
    const scores = {
      correctness: 4,
      depth: 4,
      tradeoffs: null,
      problem_solving: null,
      communication: 4,
    };
    const result = aggregateScores(technical, [q(0, scores)]);
    expect(result.overall).toBe(4);
    expect(result.dimensions.find((d) => d.id === "tradeoffs")).toMatchObject({
      score: null,
      samples: 0,
    });
  });

  it("clamps out-of-range scores into 1..5", () => {
    const result = aggregateScores(technical, [q(0, { ...all(3), correctness: 9, depth: -2 })]);
    expect(result.dimensions.find((d) => d.id === "correctness")?.score).toBe(5);
    expect(result.dimensions.find((d) => d.id === "depth")?.score).toBe(1);
  });

  it("flags weak areas (< 3) weakest first, with evidence from the worst answer's gaps", () => {
    const result = aggregateScores(technical, [
      q(0, { ...all(4), tradeoffs: 1 }, ["No alternatives considered"]),
      q(1, { ...all(4), tradeoffs: 2, depth: 1 }, ["Stayed surface level"]),
    ]);
    expect(result.weakAreas.map((w) => w.id)).toEqual(["tradeoffs", "depth"]);
    expect(result.weakAreas[0]).toMatchObject({
      score: 1.5,
      evidence: "No alternatives considered",
    });
    expect(result.strengths).toEqual(expect.arrayContaining(["correctness", "communication"]));
  });

  it("refuses to aggregate nothing", () => {
    expect(() => aggregateScores(technical, [])).toThrow(/no scored answers/);
    expect(() => aggregateScores(technical, [q(0, all(null))])).toThrow(/no rubric dimension/);
  });
});
