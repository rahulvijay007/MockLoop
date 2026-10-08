// Scripted stand-in for the Workers AI binding, injected in tests as an RPC
// service binding named AI (see vitest.config.ts). It recognises which
// MockLoop prompt it received from the system prompt and returns
// deterministic, schema-valid output, steered by markers in the candidate's
// answer text:
//
//   STRONG / WEAK      → turn analysis difficulty +1 / -1, scores 5 / 2
//   FOLLOWUP           → turn analysis asks for a follow-up
//   MALFORMED          → scorer returns broken JSON first, valid JSON on the repair turn
//   ANALYSIS_DOWN      → turn-analysis call throws (tests the live fallback).
//                        Note: local workerd logs a spurious "code had hung"
//                        message when an RPC entrypoint throws; it is an
//                        artifact of this simulated outage, not of MockLoop.
//   STREAM_FAIL        → the interviewer stream errors once, then works (tests retry)

const failedStreams = new Set();

function lastUserText(messages) {
  return [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
}

function rubricDims(text) {
  return [...text.matchAll(/^- ([a-z_]+): /gm)].map((m) => m[1]);
}

function sseStream(tokens, failAfter) {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (failAfter !== undefined && i === failAfter) {
        controller.error(new Error("simulated stream failure"));
        return;
      }
      if (i < tokens.length) {
        // Deliberately split one event across two chunks to exercise the SSE parser.
        const line = `data: ${JSON.stringify({ response: tokens[i++] })}\n\n`;
        const cut = Math.floor(line.length / 2);
        controller.enqueue(enc.encode(line.slice(0, cut)));
        controller.enqueue(enc.encode(line.slice(cut)));
        return;
      }
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

import { WorkerEntrypoint } from "cloudflare:workers";

export default class FakeAi extends WorkerEntrypoint {
  async run(_model, inputs) {
    const messages = inputs.messages ?? [];
    const system = messages[0]?.content ?? "";
    const user = lastUserText(messages);
    const transcriptText = messages.map((m) => m.content).join("\n");
    const isRepair = messages.some((m) => m.role === "assistant") && /could not be used/.test(user);

    if (inputs.stream) {
      const closing = /The interview is over/.test(system);
      const followup = /follow-up question/.test(system);
      const text = closing
        ? "Thank you for your time today. Your written evaluation is being prepared."
        : followup
          ? "Interesting. Can you go one level deeper on that point?"
          : "Thanks. Tell me about a system you designed and the trade-offs you made?";
      const tokens = text.split(/(?<= )/);
      const key = transcriptText;
      if (/STREAM_FAIL/.test(transcriptText) && !failedStreams.has(key)) {
        failedStreams.add(key);
        return sseStream(tokens, 3);
      }
      return sseStream(tokens);
    }

    if (/silent note-taker/.test(system)) {
      if (/ANALYSIS_DOWN/.test(user)) throw new Error("simulated Workers AI 503");
      const strong = /STRONG/.test(user);
      const weak = /WEAK/.test(user);
      const wantsFollowup = /FOLLOWUP/.test(user);
      return {
        response: {
          topic: "system design trade-offs",
          answer_quality: strong ? "strong" : weak ? "weak" : "adequate",
          note: strong
            ? "Specific and quantified."
            : weak
              ? "Vague, no specifics."
              : "Reasonable answer.",
          action: wantsFollowup ? "followup" : "next",
          followup_focus: wantsFollowup ? "the failure modes they mentioned" : null,
          next_topic: wantsFollowup ? null : "caching strategy",
          difficulty_delta: strong ? 1 : weak ? -1 : 0,
        },
      };
    }

    if (/calibrated interview assessor/.test(system)) {
      const answerText =
        (/<candidate_answer>([\s\S]*?)<\/candidate_answer>/.exec(transcriptText) ?? [])[1] ?? "";
      if (/MALFORMED/.test(answerText) && !isRepair) {
        return { response: 'Sure! Here are the scores: {"scores": {"correctness": 9' };
      }
      const firstUser = messages.find((m) => m.role === "user")?.content ?? "";
      const dims = rubricDims(firstUser);
      const value = /STRONG/.test(answerText) ? 5 : /WEAK/.test(answerText) ? 2 : 3;
      return {
        response: {
          scores: Object.fromEntries(dims.map((d) => [d, value])),
          evidence: `Scored ${value} based on the answer.`,
          strengths: value >= 4 ? ["Specific"] : [],
          gaps: value <= 2 ? ["Lacked specifics and trade-offs"] : [],
        },
      };
    }

    if (/interview coach/.test(system)) {
      const area = (/^- ([a-z_]+) \(/m.exec(user) ?? [])[1] ?? "communication";
      return {
        response: {
          summary: "Solid foundation; the biggest gap is depth on trade-offs.",
          priorities: [
            {
              area,
              title: "Make trade-offs explicit",
              why: "Answers named one option without comparing alternatives.",
              drills: ["For each design choice, state one alternative and when it would win."],
            },
          ],
          practice_questions: [
            "How would you shard this database?",
            "When would you not use a cache?",
          ],
        },
      };
    }

    throw new Error(`fake AI: unrecognised prompt: ${system.slice(0, 80)}`);
  }
}
