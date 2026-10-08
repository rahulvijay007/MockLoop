import { z } from "zod";
import type { SessionConfig, WeakArea } from "../domain";
import type { ChatMessage } from "../llm/client";
import type { Aggregate, QuestionScore } from "../rubric/aggregate";
import { dimensionLabel, type Rubric } from "../rubric/rubrics";
import { TYPE_LABEL, describeCandidate } from "./shared";

/**
 * improvement-plan@v1: turns the aggregated scores and per-answer gaps into
 * a short, actionable plan. It only sees evidence produced by the scorer,
 * never the raw transcript, which keeps it grounded and the prompt small.
 */

export const id = "improvement-plan";
export const version = 1;

export function planSchema(rubric: Rubric) {
  const ids = rubric.dimensions.map((d) => d.id) as [string, ...string[]];
  return z.object({
    summary: z.string().min(1).max(800),
    priorities: z
      .array(
        z.object({
          area: z.enum(ids),
          title: z.string().min(1).max(120),
          why: z.string().min(1).max(400),
          drills: z.array(z.string().min(1).max(300)).min(1).max(3),
        }),
      )
      .min(1)
      .max(3),
    practice_questions: z.array(z.string().min(1).max(300)).min(2).max(5),
  });
}
export type ImprovementPlan = z.infer<ReturnType<typeof planSchema>>;

export interface PlanInput {
  config: SessionConfig;
  rubric: Rubric;
  aggregate: Aggregate;
  questionScores: QuestionScore[];
  /** Weak areas from previous sessions, to comment on progress or regression. */
  priorWeakAreas: WeakArea[];
}

export const SYSTEM = `You are an interview coach writing a concise improvement plan after a mock interview.
Ground every statement ONLY in the scores and evidence provided. Do not invent events from the interview.
- summary: 2 to 4 sentences: overall level, the clearest strength, and the most important gap. If prior weak areas are given, say whether each improved, held or regressed this session.
- priorities: 1 to 3 items, most important first, each tied to one rubric dimension id. Prefer the lowest-scoring dimensions.
- drills: concrete practice actions the candidate can do this week (e.g. "Rewrite your last two stories with a quantified result").
- practice_questions: interview questions that would exercise the priority areas next time.
Respond with a single JSON object only.`;

export function build(input: PlanInput): ChatMessage[] {
  const { config, rubric, aggregate, questionScores, priorWeakAreas } = input;
  const dimLines = aggregate.dimensions.map(
    (d) =>
      `- ${d.id} (${dimensionLabel(d.id)}): ${d.score === null ? "not assessed" : `${d.score}/5`}`,
  );
  const gapLines = questionScores.flatMap((q) => q.gaps.map((g) => `- Q${q.index + 1}: ${g}`));
  const strengthLines = questionScores.flatMap((q) =>
    q.strengths.map((s) => `- Q${q.index + 1}: ${s}`),
  );
  const prior = priorWeakAreas.length
    ? priorWeakAreas.map((w) => `- ${w.area} (${w.label}): previously ${w.avgScore.toFixed(1)}/5`)
    : ["- none (first session or no recurring weaknesses)"];

  const user = [
    `Interview: ${TYPE_LABEL[config.type]} for a ${describeCandidate(config)}. Rubric v${rubric.version}.`,
    `Overall score: ${aggregate.overall}/5.`,
    "",
    "Dimension scores:",
    ...dimLines,
    "",
    "Gaps observed:",
    ...(gapLines.length ? gapLines : ["- none recorded"]),
    "",
    "Strengths observed:",
    ...(strengthLines.length ? strengthLines : ["- none recorded"]),
    "",
    "Prior recurring weak areas:",
    ...prior,
  ].join("\n");

  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}
