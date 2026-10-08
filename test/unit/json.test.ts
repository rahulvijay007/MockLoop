import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { CompletionRequest, LlmClient } from "../../src/llm/client";
import {
  LlmOutputError,
  extractJsonCandidate,
  generateJson,
  parseAndValidate,
  toJsonSchema,
} from "../../src/llm/json";

const Schema = z.object({ score: z.number().min(1).max(5), note: z.string() });

/** LlmClient that replays scripted outputs and records every request. */
function scripted(...outputs: (string | Error)[]) {
  const requests: CompletionRequest[] = [];
  const llm: LlmClient = {
    model: "test",
    complete(req) {
      requests.push(req);
      const next = outputs.shift();
      if (next === undefined) return Promise.reject(new Error("no more scripted outputs"));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    stream() {
      throw new Error("not used");
    },
  };
  return { llm, requests };
}

describe("extractJsonCandidate", () => {
  it("returns plain JSON unchanged", () => {
    expect(extractJsonCandidate('{"a":1}')).toBe('{"a":1}');
  });
  it("strips markdown fences and surrounding prose", () => {
    expect(extractJsonCandidate('Sure!\n```json\n{"a": {"b": 2}}\n```\nHope that helps')).toBe(
      '{"a": {"b": 2}}',
    );
  });
  it("is not fooled by braces inside strings", () => {
    expect(extractJsonCandidate('{"note":"use } and { freely","x":1} trailing')).toBe(
      '{"note":"use } and { freely","x":1}',
    );
  });
  it("returns null for output truncated at max_tokens", () => {
    expect(extractJsonCandidate('{"score": 4, "note": "cut off')).toBeNull();
  });
});

describe("parseAndValidate", () => {
  it("accepts valid output", () => {
    expect(parseAndValidate('{"score":4,"note":"ok"}', Schema)).toEqual({
      ok: true,
      data: { score: 4, note: "ok" },
    });
  });
  it("reports schema violations including the field name", () => {
    const r = parseAndValidate('{"score":9,"note":"ok"}', Schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/score/);
  });
  it("reports invalid JSON", () => {
    expect(parseAndValidate("{score: 4}", Schema)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/invalid JSON/) as unknown,
    });
  });
});

describe("generateJson", () => {
  it("returns first-attempt output without a repair call, using JSON mode", async () => {
    const { llm, requests } = scripted('{"score":3,"note":"fine"}');
    const result = await generateJson({ llm, schema: Schema, messages: [], maxTokens: 100 });
    expect(result).toEqual({ data: { score: 3, note: "fine" }, repaired: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.jsonSchema).toMatchObject({ type: "object" });
  });

  it("repairs once: the repair turn keeps the task, the bad output and the exact errors", async () => {
    const { llm, requests } = scripted('{"score":9,"note":"x"}', '{"score":5,"note":"x"}');
    const messages = [{ role: "user" as const, content: "score this" }];
    const result = await generateJson({ llm, schema: Schema, messages, maxTokens: 100 });
    expect(result).toEqual({ data: { score: 5, note: "x" }, repaired: true });
    const repair = requests[1]?.messages ?? [];
    expect(repair[0]).toEqual(messages[0]);
    expect(repair[1]).toEqual({ role: "assistant", content: '{"score":9,"note":"x"}' });
    expect(repair[2]?.content).toMatch(/could not be used/);
    expect(repair[2]?.content).toMatch(/score/);
  });

  it("throws LlmOutputError after exactly one failed repair", async () => {
    const { llm, requests } = scripted("not json", "still not json");
    await expect(
      generateJson({ llm, schema: Schema, messages: [], maxTokens: 100 }),
    ).rejects.toBeInstanceOf(LlmOutputError);
    expect(requests).toHaveLength(2);
  });

  it("propagates transport errors without attempting a repair", async () => {
    const { llm, requests } = scripted(new Error("503 capacity"));
    await expect(
      generateJson({ llm, schema: Schema, messages: [], maxTokens: 100 }),
    ).rejects.toThrow("503 capacity");
    expect(requests).toHaveLength(1);
  });
});

describe("toJsonSchema", () => {
  it("derives the JSON-mode schema from zod and drops $schema", () => {
    const s = toJsonSchema(Schema);
    expect(s.$schema).toBeUndefined();
    expect(s).toMatchObject({ type: "object", required: ["score", "note"] });
  });
});
