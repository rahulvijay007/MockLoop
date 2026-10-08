import { describe, expect, it } from "vitest";
import { parseSseTokens, responseText } from "../../src/llm/client";

function streamOf(...chunks: string[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out: string[] = [];
  for await (const t of parseSseTokens(stream)) out.push(t);
  return out;
}

describe("parseSseTokens", () => {
  it("parses native Workers AI events and stops at [DONE]", async () => {
    const tokens = await collect(
      streamOf(
        'data: {"response":"Hel"}\n\n',
        'data: {"response":"lo"}\n\n',
        "data: [DONE]\n\n",
        'data: {"response":"!"}\n\n',
      ),
    );
    expect(tokens).toEqual(["Hel", "lo"]);
  });

  it("reassembles events split across chunks", async () => {
    const tokens = await collect(
      streamOf('data: {"resp', 'onse":"a"}\n', '\ndata: {"response":"b"}\n\n'),
    );
    expect(tokens).toEqual(["a", "b"]);
  });

  it("supports the OpenAI-compatible delta shape and skips empty/usage/keep-alive events", async () => {
    const tokens = await collect(
      streamOf(
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
        'data: {"response":"","usage":{"total_tokens":5}}\n\n',
        ": keep-alive\n\n",
      ),
    );
    expect(tokens).toEqual(["x"]);
  });
});

describe("responseText", () => {
  it("normalises string and object responses", () => {
    expect(responseText({ response: "hi" })).toBe("hi");
    expect(responseText({ response: { a: 1 } })).toBe('{"a":1}');
    expect(() => responseText({})).toThrow();
  });
});
