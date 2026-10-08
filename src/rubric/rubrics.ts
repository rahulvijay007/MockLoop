import type { InterviewType } from "../domain";

/**
 * Scoring rubrics. Each answer is scored 1–5 on every dimension of its
 * interview type (or null when a dimension genuinely does not apply).
 *
 * Dimension ids are shared across types where the skill is the same
 * ("communication", "tradeoffs"), so a weakness found in a system design
 * session carries over to a later technical session.
 */

export interface RubricDimension {
  id: string;
  label: string;
  /** What a 5 looks like. Fed verbatim to the scorer prompt. */
  description: string;
  weight: number;
}

export interface Rubric {
  type: InterviewType;
  version: number;
  dimensions: readonly RubricDimension[];
}

export const RUBRICS: Record<InterviewType, Rubric> = {
  behavioral: {
    type: "behavioral",
    version: 1,
    dimensions: [
      {
        id: "structure",
        label: "Structure (STAR)",
        description: "Clear Situation, Task, Action, Result; the listener never loses the thread.",
        weight: 0.2,
      },
      {
        id: "ownership",
        label: "Ownership",
        description:
          "Says 'I' for their own actions, explains their specific decisions and accountability.",
        weight: 0.2,
      },
      {
        id: "impact",
        label: "Impact & metrics",
        description: "Concrete, quantified outcomes and why they mattered to the business or team.",
        weight: 0.25,
      },
      {
        id: "reflection",
        label: "Reflection",
        description: "Names what they learned or would do differently, without being prompted.",
        weight: 0.15,
      },
      {
        id: "communication",
        label: "Communication",
        description: "Concise, specific, appropriate level of detail for the audience.",
        weight: 0.2,
      },
    ],
  },
  technical: {
    type: "technical",
    version: 1,
    dimensions: [
      {
        id: "correctness",
        label: "Correctness",
        description: "Technically accurate statements; no significant errors or misconceptions.",
        weight: 0.3,
      },
      {
        id: "depth",
        label: "Depth",
        description: "Explains how and why things work underneath, not just what to use.",
        weight: 0.25,
      },
      {
        id: "tradeoffs",
        label: "Trade-offs",
        description:
          "Weighs alternatives explicitly, with costs, failure modes and when each wins.",
        weight: 0.2,
      },
      {
        id: "problem_solving",
        label: "Problem solving",
        description: "Breaks the problem down, states assumptions, checks edge cases.",
        weight: 0.1,
      },
      {
        id: "communication",
        label: "Communication",
        description: "Concise, specific, appropriate level of detail for the audience.",
        weight: 0.15,
      },
    ],
  },
  system_design: {
    type: "system_design",
    version: 1,
    dimensions: [
      {
        id: "requirements",
        label: "Requirements",
        description:
          "Clarifies functional and non-functional requirements and scale before designing.",
        weight: 0.15,
      },
      {
        id: "architecture",
        label: "Architecture",
        description: "Coherent components, data model and data flow that meet the requirements.",
        weight: 0.25,
      },
      {
        id: "scalability",
        label: "Scalability & reliability",
        description:
          "Identifies bottlenecks, partitioning, caching, failure handling with numbers.",
        weight: 0.2,
      },
      {
        id: "tradeoffs",
        label: "Trade-offs",
        description:
          "Weighs alternatives explicitly, with costs, failure modes and when each wins.",
        weight: 0.25,
      },
      {
        id: "communication",
        label: "Communication",
        description: "Concise, specific, appropriate level of detail for the audience.",
        weight: 0.15,
      },
    ],
  },
};

const LABELS = new Map(
  Object.values(RUBRICS).flatMap((r) => r.dimensions.map((d) => [d.id, d.label] as const)),
);

export function dimensionLabel(id: string): string {
  return LABELS.get(id) ?? id;
}
