/**
 * Prints every product prompt, fully rendered for a sample interview, so
 * PROMPTS.md can show the exact text the model receives. Run:
 *   npm run prompts:render
 */
import type { Exchange, SessionConfig, TranscriptMessage, WeakArea } from "../src/domain";
import type { ChatMessage } from "../src/llm/client";
import { toJsonSchema } from "../src/llm/json";
import {
  improvementPlan,
  interviewer,
  jsonRepairPrompt,
  scoreAnswer,
  turnAnalysis,
} from "../src/prompts";
import { aggregateScores, type QuestionScore } from "../src/rubric/aggregate";
import { RUBRICS } from "../src/rubric/rubrics";

const config: SessionConfig = { role: "Backend Engineer", seniority: "senior", type: "technical" };
const rubric = RUBRICS.technical;
const focusAreas: WeakArea[] = [
  {
    area: "tradeoffs",
    label: "Trade-offs",
    avgScore: 2.3,
    sessions: 2,
    evidence: "Named one option only",
  },
];
const question = "How would you add caching to a slow product API, and what can go wrong?";
const answer = "I'd put Redis in front of the database with a TTL and invalidate on writes.";
const history: TranscriptMessage[] = [
  {
    seq: 1,
    speaker: "interviewer",
    content: `Hi, thanks for joining. ${question}`,
    questionId: "q1",
    incomplete: false,
    createdAt: 0,
  },
  {
    seq: 2,
    speaker: "candidate",
    content: answer,
    questionId: "q1",
    incomplete: false,
    createdAt: 0,
  },
];
const exchange: Exchange = {
  index: 0,
  questionId: "q1",
  question,
  topic: "caching",
  difficulty: 3,
  isFollowUp: false,
  answer,
};
const qs: QuestionScore[] = [
  {
    index: 0,
    questionId: "q1",
    scores: { correctness: 4, depth: 3, tradeoffs: 2, problem_solving: 3, communication: 4 },
    evidence: "Mentions TTL and invalidation but no failure modes.",
    strengths: ["Correct cache-aside pattern"],
    gaps: ["No discussion of cache stampede or outage fallback"],
  },
];

function print(title: string, messages: ChatMessage[]) {
  console.log(`\n===== ${title} =====`);
  for (const m of messages) console.log(`--- [${m.role}]\n${m.content}`);
}

print(
  "interviewer@v1 (plan: open)",
  interviewer.build({
    config,
    difficulty: 3,
    focusAreas,
    coveredTopics: [],
    history: [],
    plan: { action: "open" },
  }),
);
console.log("\n----- interviewer@v1: task line per plan -----");
for (const plan of [
  { action: "followup" as const, focus: "what happens when the cache is down" },
  { action: "next" as const, topic: "message queues" },
  { action: "next" as const, topic: null },
  { action: "close" as const },
]) {
  const sys = interviewer.buildSystem({
    config,
    difficulty: 3,
    focusAreas: [],
    coveredTopics: [],
    plan,
  });
  console.log(sys.slice(sys.indexOf("Your task for this message:")));
}
print(
  "interviewer@v1 (plan: followup, with history)",
  interviewer.build({
    config,
    difficulty: 4,
    focusAreas,
    coveredTopics: ["caching"],
    history,
    plan: { action: "followup", focus: "what happens when the cache is down" },
  }),
);
print(
  "turn-analysis@v1",
  turnAnalysis.build({
    config,
    difficulty: 3,
    question,
    answer,
    followUpsOnTopic: 0,
    coveredTopics: ["caching"],
  }),
);
console.log("\nJSON schema:", JSON.stringify(toJsonSchema(turnAnalysis.TurnAnalysisSchema)));
print("score-answer@v1", scoreAnswer.build(config, rubric, exchange));
console.log("\nJSON schema:", JSON.stringify(toJsonSchema(scoreAnswer.scoreSchema(rubric))));
print(
  "improvement-plan@v1",
  improvementPlan.build({
    config,
    rubric,
    aggregate: aggregateScores(rubric, qs),
    questionScores: qs,
    priorWeakAreas: focusAreas,
  }),
);
console.log("\nJSON schema:", JSON.stringify(toJsonSchema(improvementPlan.planSchema(rubric))));
print("json-repair@v1 (appended after the model's bad reply)", [
  jsonRepairPrompt.build({
    jsonSchema: { type: "object" },
    error: "✖ Too big: expected number to be <=5\n  → at scores.depth",
  }),
]);
