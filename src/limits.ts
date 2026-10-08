/** Abuse controls shared by the Worker router and the session Durable Object. */

export interface Limits {
  maxAnswerChars: number;
  maxTurns: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function readLimits(env: Pick<Cloudflare.Env, "MAX_ANSWER_CHARS" | "MAX_TURNS">): Limits {
  return {
    maxAnswerChars: positiveInt(env.MAX_ANSWER_CHARS, 2000),
    maxTurns: positiveInt(env.MAX_TURNS, 12),
  };
}

/** Max interviewer tokens per message; the prompt asks for < 90 words. */
export const INTERVIEWER_MAX_TOKENS = 320;
/** Max HTTP JSON body accepted by the API. */
export const MAX_BODY_BYTES = 4096;

/**
 * Workers Rate Limiting binding. Keys are scoped per purpose; the binding is
 * eventually consistent per location, which is the right trade-off for basic
 * abuse control (it is not a billing-grade quota).
 */
export async function isRateLimited(limiter: RateLimit, key: string): Promise<boolean> {
  const { success } = await limiter.limit({ key });
  return !success;
}
