import { z } from "zod";
import type { TranscriptMessage } from "../domain";

/**
 * WebSocket protocol between the browser and the InterviewSession Agent.
 * Client → server messages are validated with zod; anything else is rejected.
 * (The Agents SDK additionally sends its own `cf_agent_*` frames, e.g.
 * `cf_agent_state` with the synced SessionState.)
 */

export const ClientMessageSchema = z.discriminatedUnion("type", [
  // Length is checked against MAX_ANSWER_CHARS in the DO; this bound only stops absurd frames.
  z.object({ type: z.literal("answer"), text: z.string().max(20_000) }),
  z.object({ type: z.literal("end") }),
  /** Regenerate the interviewer message after a dropped/failed stream. */
  z.object({ type: z.literal("retry") }),
  /** Restart a failed evaluation Workflow. */
  z.object({ type: z.literal("retry_evaluation") }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ErrorCode =
  | "invalid_message"
  | "empty_answer"
  | "answer_too_long"
  | "busy"
  | "turn_cap"
  | "rate_limited"
  | "not_active"
  | "nothing_to_retry"
  | "llm_unavailable";

export type ServerMessage =
  /** Full transcript, sent on every (re)connect so the client can rebuild exactly. */
  | { type: "snapshot"; messages: TranscriptMessage[] }
  | { type: "message"; message: TranscriptMessage }
  | { type: "message_start"; seq: number; questionId: string | null }
  | { type: "token"; seq: number; text: string }
  | { type: "message_end"; seq: number; interrupted: boolean }
  | { type: "error"; code: ErrorCode; message: string };
