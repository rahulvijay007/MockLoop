/**
 * Scorer eval: runs the hand-written weak / average / strong answers in
 * scripts/eval-cases.ts through the production scoring path
 * (src/evaluation/steps.ts → score-answer prompt → JSON validation/repair →
 * rubric aggregation) against the real model on Workers AI, several times
 * each, and reports:
 *
 *   - ordering: does each question score weak < average < strong
 *     (on the mean, and in what fraction of individual runs)?
 *   - stability: how much does each answer's score move across runs?
 *
 * It reports what it measures. It does not claim the scores are "accurate"; a
 * correct ordering on 4 hand-picked questions is a sanity check, not validation.
 *
 * Usage:  npm run eval -- [--runs 3]
 * Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI: Read),
 * from the environment or from .dev.vars.
 */
import fs from "node:fs";
import path from "node:path";
import type { Exchange } from "../src/domain";
import { scoreExchange } from "../src/evaluation/steps";
import { responseText, type CompletionRequest, type LlmClient } from "../src/llm/client";
import { aggregateScores } from "../src/rubric/aggregate";
import { RUBRICS } from "../src/rubric/rubrics";
import { EVAL_QUESTIONS, type Level } from "./eval-cases";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const LEVELS: Level[] = ["weak", "average", "strong"];

function loadCredentials(): { accountId: string; token: string } {
  const vars: Record<string, string> = {};
  const devVars = path.resolve(".dev.vars");
  if (fs.existsSync(devVars)) {
    for (const line of fs.readFileSync(devVars, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line);
      if (m?.[1] && m[2] !== undefined) vars[m[1]] = m[2];
    }
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? vars.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN ?? vars.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token || accountId.startsWith("your-")) {
    console.error(
      "Missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN. Copy .dev.vars.example to .dev.vars and fill them in.",
    );
    process.exit(2);
  }
  return { accountId, token };
}

/** LlmClient over the Workers AI REST API: same model, same request shape as the binding. */
function restClient(accountId: string, token: string): LlmClient & { calls: number } {
  const client = {
    model: MODEL,
    calls: 0,
    async complete(req: CompletionRequest): Promise<string> {
      client.calls++;
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            messages: req.messages,
            max_tokens: req.maxTokens,
            temperature: req.temperature,
            ...(req.jsonSchema
              ? { response_format: { type: "json_schema", json_schema: req.jsonSchema } }
              : {}),
          }),
        },
      );
      const body = await res.json<{ success?: boolean; result?: unknown; errors?: unknown }>();
      if (!res.ok || body.success === false) {
        throw new Error(`Workers AI ${String(res.status)}: ${JSON.stringify(body.errors)}`);
      }
      return responseText(body.result);
    },
    stream(): AsyncIterable<string> {
      throw new Error("streaming is not used by the scorer eval");
    },
  };
  return client;
}

function parseRuns(): number {
  const i = process.argv.indexOf("--runs");
  const n = i >= 0 ? Number(process.argv[i + 1]) : 3;
  return Number.isInteger(n) && n > 0 && n <= 10 ? n : 3;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stdev = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const f2 = (n: number) => n.toFixed(2);

interface CaseResult {
  question: string;
  level: Level;
  scores: number[];
  failures: number;
}

async function main() {
  const { accountId, token } = loadCredentials();
  const runs = parseRuns();
  const llm = restClient(accountId, token);
  const results: CaseResult[] = [];
  const started = Date.now();

  console.log(
    `Scorer eval: ${String(EVAL_QUESTIONS.length * LEVELS.length)} answers × ${String(runs)} runs, model ${MODEL}\n`,
  );

  for (const q of EVAL_QUESTIONS) {
    const rubric = RUBRICS[q.config.type];
    for (const level of LEVELS) {
      const exchange: Exchange = {
        index: 0,
        questionId: q.id,
        question: q.question,
        topic: q.id,
        difficulty: 3,
        isFollowUp: false,
        answer: q.answers[level],
      };
      const r: CaseResult = { question: q.id, level, scores: [], failures: 0 };
      for (let run = 0; run < runs; run++) {
        try {
          const score = await scoreExchange(llm, q.config, exchange);
          r.scores.push(aggregateScores(rubric, [score]).overall);
        } catch (e) {
          r.failures++;
          console.warn(`  ${q.id}/${level} run ${String(run + 1)} failed: ${(e as Error).message}`);
        }
      }
      results.push(r);
      const summary = r.scores.length
        ? `mean ${f2(mean(r.scores))}  sd ${f2(stdev(r.scores))}  runs [${r.scores.map(f2).join(", ")}]`
        : "no successful runs";
      console.log(
        `${q.id.padEnd(18)} ${level.padEnd(8)} ${summary}${r.failures ? `  failures ${String(r.failures)}` : ""}`,
      );
    }
  }

  // Ordering per question: on means, and per run index.
  console.log("\nOrdering (weak < average < strong):");
  let meanOrdered = 0;
  let runPairsOrdered = 0;
  let runPairsTotal = 0;
  for (const q of EVAL_QUESTIONS) {
    const byLevel = Object.fromEntries(
      LEVELS.map((l) => [
        l,
        results.find((r) => r.question === q.id && r.level === l)?.scores ?? [],
      ]),
    ) as Record<Level, number[]>;
    const ok =
      byLevel.weak.length > 0 &&
      byLevel.average.length > 0 &&
      byLevel.strong.length > 0 &&
      mean(byLevel.weak) < mean(byLevel.average) &&
      mean(byLevel.average) < mean(byLevel.strong);
    if (ok) meanOrdered++;
    const n = Math.min(byLevel.weak.length, byLevel.average.length, byLevel.strong.length);
    let perRun = 0;
    for (let i = 0; i < n; i++) {
      const w = byLevel.weak[i] ?? 0;
      const a = byLevel.average[i] ?? 0;
      const s = byLevel.strong[i] ?? 0;
      if (w < a && a < s) perRun++;
    }
    runPairsOrdered += perRun;
    runPairsTotal += n;
    console.log(
      `  ${q.id.padEnd(18)} means ${ok ? "ordered" : "NOT ordered"}; strictly ordered in ${String(perRun)}/${String(n)} runs`,
    );
  }

  const sds = results.filter((r) => r.scores.length > 1).map((r) => stdev(r.scores));
  const spreads = results
    .filter((r) => r.scores.length > 0)
    .map((r) => Math.max(...r.scores) - Math.min(...r.scores));
  const failures = results.reduce((a, r) => a + r.failures, 0);
  const totalRuns = results.length * runs;

  const summary = {
    model: MODEL,
    runsPerAnswer: runs,
    answers: results.length,
    questionsOrderedOnMean: `${String(meanOrdered)}/${String(EVAL_QUESTIONS.length)}`,
    runsStrictlyOrdered: `${String(runPairsOrdered)}/${String(runPairsTotal)}`,
    meanStdev: sds.length ? Number(f2(mean(sds))) : null,
    maxSpread: spreads.length ? Number(f2(Math.max(...spreads))) : null,
    failedScoringRuns: `${String(failures)}/${String(totalRuns)}`,
    llmCalls: llm.calls,
    repairCalls: llm.calls - (totalRuns - failures),
    durationSec: Math.round((Date.now() - started) / 1000),
  };
  console.log("\nSummary:", JSON.stringify(summary, null, 2));

  const outDir = path.resolve("eval-results");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `scorer-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
  console.log(`\nWrote ${file}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
