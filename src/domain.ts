import { z } from "zod";

/** Shared domain types and the input schemas that guard every trust boundary. */

export const INTERVIEW_TYPES = ["behavioral", "technical", "system_design"] as const;
export const SENIORITIES = ["junior", "mid", "senior", "staff"] as const;

export type InterviewType = (typeof INTERVIEW_TYPES)[number];
export type Seniority = (typeof SENIORITIES)[number];

export const SessionConfigSchema = z.object({
  role: z
    .string()
    .trim()
    .min(2)
    .max(80)
    // Role is interpolated into prompts; keep it to plain job-title characters.
    .regex(/^[\p{L}\p{N} .,&/+#()-]+$/u, "role contains unsupported characters"),
  seniority: z.enum(SENIORITIES),
  type: z.enum(INTERVIEW_TYPES),
});
export type SessionConfig = z.infer<typeof SessionConfigSchema>;

/** Anonymous browser-generated id; see README "Known shortcuts" (no real auth). */
export const UserIdSchema = z.uuid();

/** A weak area as read from the D1 profile and injected into the interviewer prompt. */
export interface WeakArea {
  area: string;
  label: string;
  avgScore: number;
  sessions: number;
  evidence: string;
}

export type Speaker = "interviewer" | "candidate";

export interface TranscriptMessage {
  seq: number;
  speaker: Speaker;
  content: string;
  questionId: string | null;
  /** True while tokens are still streaming, or if the stream was cut off. */
  incomplete: boolean;
  createdAt: number;
}

/** One interviewer question paired with the candidate's answer: the unit of scoring. */
export interface Exchange {
  index: number;
  questionId: string;
  question: string;
  topic: string;
  difficulty: number;
  isFollowUp: boolean;
  answer: string;
}

export interface Transcript {
  sessionId: string;
  userId: string;
  config: SessionConfig;
  exchanges: Exchange[];
  /** Weak areas from earlier sessions, snapshotted when this session was created. */
  focusAreas: WeakArea[];
}
