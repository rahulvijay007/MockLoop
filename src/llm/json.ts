import { z } from "zod";
import type { ChatMessage, LlmClient } from "./client";
import { jsonRepairPrompt } from "../prompts/json-repair.v1";

/**
 * Structured output with validation and exactly one repair retry.
 *
 * 1. Ask for JSON using Workers AI JSON mode (schema-constrained decoding).
 * 2. Extract + parse + validate with zod. JSON mode is not a guarantee
 *    (truncation at max_tokens, out-of-range numbers, model errors), so we
 *    never trust it blindly.
 * 3. On failure, send the bad output and the exact validation errors back to
 *    the model once, with a dedicated repair prompt.
 * 4. If that also fails, throw LlmOutputError. Callers decide what failure
 *    means: the live interview falls back to a deterministic plan; a
 *    Workflow step throws so the step is retried with backoff.
 */

export class LlmOutputError extends Error {
  override name = "LlmOutputError";
  constructor(
    message: string,
    readonly raw: string,
    readonly issues: string,
  ) {
    super(message);
  }
}

export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Pull the most plausible JSON object out of model text: strips markdown
 * fences and surrounding prose by taking the first balanced {...} block.
 */
export function extractJsonCandidate(text: string): string | null {
  const unfenced = text.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < unfenced.length; i++) {
    const ch = unfenced[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return unfenced.slice(start, i + 1);
  }
  return null; // unbalanced: most likely truncated at max_tokens
}

export function parseAndValidate<T>(text: string, schema: z.ZodType<T>): ParseResult<T> {
  const candidate = extractJsonCandidate(text);
  if (candidate === null) return { ok: false, error: "no complete JSON object found in output" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  const result = schema.safeParse(parsed);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: z.prettifyError(result.error) };
}

/** JSON Schema for Workers AI JSON mode, derived from the zod schema (single source of truth). */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return rest;
}

export interface GenerateJsonOptions<T> {
  llm: LlmClient;
  schema: z.ZodType<T>;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
}

export interface GenerateJsonResult<T> {
  data: T;
  repaired: boolean;
}

export async function generateJson<T>(
  opts: GenerateJsonOptions<T>,
): Promise<GenerateJsonResult<T>> {
  const jsonSchema = toJsonSchema(opts.schema);
  const temperature = opts.temperature ?? 0;

  // Transport/capacity errors propagate unchanged: they are not "malformed
  // output" and the caller's retry policy (Workflow step retries) or fallback
  // (live interview) is the right place to handle them.
  const raw = await opts.llm.complete({
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    temperature,
    jsonSchema,
  });
  const first = parseAndValidate(raw, opts.schema);
  if (first.ok) return { data: first.data, repaired: false };

  // Repair continues the same conversation, so the model still has the task
  // context, sees its own bad output, and gets the exact validation errors.
  const repairRaw = await opts.llm.complete({
    messages: [
      ...opts.messages,
      { role: "assistant", content: raw.slice(0, 4000) },
      jsonRepairPrompt.build({ jsonSchema, error: first.error }),
    ],
    maxTokens: opts.maxTokens,
    temperature: 0,
    jsonSchema,
  });
  const second = parseAndValidate(repairRaw, opts.schema);
  if (second.ok) return { data: second.data, repaired: true };
  throw new LlmOutputError(
    "model output failed validation after one repair attempt",
    repairRaw,
    second.error,
  );
}
