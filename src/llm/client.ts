/**
 * A deliberately small LLM interface. Production code talks to Workers AI
 * through the `AI` binding; the eval script talks to the same model over the
 * Workers AI REST API; unit tests pass a fake. Prompts and validation are
 * shared by all three, so the eval measures exactly what production runs.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  /** JSON Schema for Workers AI JSON mode. Omit for free text. */
  jsonSchema?: Record<string, unknown>;
}

export interface LlmClient {
  readonly model: string;
  /** Non-streaming completion. Returns the raw text (or JSON-stringified object). */
  complete(req: CompletionRequest): Promise<string>;
  /** Streaming completion yielding text deltas. */
  stream(req: Omit<CompletionRequest, "jsonSchema">): AsyncIterable<string>;
}

type ModelId = Cloudflare.Env["MODEL_ID"];

/** LlmClient backed by the Workers AI binding. */
export function workersAiClient(ai: Ai, model: ModelId): LlmClient {
  return {
    model,
    async complete(req) {
      const result: unknown = await ai.run(model, {
        messages: req.messages,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        ...(req.jsonSchema
          ? { response_format: { type: "json_schema" as const, json_schema: req.jsonSchema } }
          : {}),
      });
      return responseText(result);
    },
    async *stream(req) {
      const result: unknown = await ai.run(model, {
        messages: req.messages,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        stream: true,
      });
      if (!(result instanceof ReadableStream)) {
        // Some error paths return a JSON body instead of a stream; surface the text.
        yield responseText(result);
        return;
      }
      yield* parseSseTokens(result as ReadableStream<Uint8Array>);
    },
  };
}

/**
 * Workers AI returns `{ response: string }`, but in JSON mode `response` can
 * already be a parsed object. Normalise both to a string for the validator.
 */
export function responseText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "response" in result) {
    const r = result.response;
    if (typeof r === "string") return r;
    if (r !== null && r !== undefined) return JSON.stringify(r);
  }
  throw new Error("Workers AI returned no response text");
}

/**
 * Parse a Workers AI server-sent-event stream into text deltas.
 * Handles events split across chunk boundaries, the `[DONE]` sentinel, and
 * both the native (`response`) and OpenAI-compatible (`choices[0].delta.content`) shapes.
 */
export async function* parseSseTokens(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        const token = parseSseLine(line);
        if (token === DONE) return;
        if (token) yield token;
      }
    }
    const token = parseSseLine(buffer.trim());
    if (token && token !== DONE) yield token;
  } finally {
    reader.releaseLock();
  }
}

const DONE = Symbol("done");

function parseSseLine(line: string): string | typeof DONE | null {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (data === "[DONE]") return DONE;
  try {
    const event = JSON.parse(data) as {
      response?: unknown;
      choices?: { delta?: { content?: unknown } }[];
    };
    const text = event.response ?? event.choices?.[0]?.delta?.content;
    return typeof text === "string" && text.length > 0 ? text : null;
  } catch {
    return null; // keep-alives / partial garbage are ignored rather than killing the stream
  }
}
