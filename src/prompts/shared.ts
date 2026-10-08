import type { InterviewType, Seniority, SessionConfig } from "../domain";

/** Fragments shared by several prompts. Changing one is a prompt-version bump for its users. */

export const TYPE_LABEL: Record<InterviewType, string> = {
  behavioral: "behavioral",
  technical: "technical",
  system_design: "system design",
};

export const SENIORITY_CALIBRATION: Record<Seniority, string> = {
  junior:
    "Junior: fundamentals and learning ability. Expect guided problem solving and small-scope ownership.",
  mid: "Mid-level: independent ownership of features end to end, sound fundamentals, some trade-off awareness.",
  senior:
    "Senior: handles ambiguity, owns systems, explains deep trade-offs, influences beyond their own team.",
  staff:
    "Staff: org-level technical strategy, multi-system design, long-term trade-offs, influencing without authority.",
};

export const DIFFICULTY_LABEL: Record<number, string> = {
  1: "warm-up",
  2: "foundational",
  3: "solid working knowledge",
  4: "advanced",
  5: "expert, edge cases and failure modes",
};

export function describeCandidate(config: SessionConfig): string {
  return `${config.seniority} ${config.role}`;
}

/**
 * Candidate text is untrusted. It is always wrapped in tags the system prompt
 * declares as data, and any copy of those tags inside the text is neutralised
 * so an answer cannot "close" its own block and smuggle in instructions.
 */
export function wrapCandidate(text: string): string {
  const cleaned = text.replace(/<\/?\s*candidate_answer\s*>/gi, "");
  return `<candidate_answer>\n${cleaned}\n</candidate_answer>`;
}
