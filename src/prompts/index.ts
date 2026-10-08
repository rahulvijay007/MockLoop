/**
 * Prompt registry. Every prompt lives in its own versioned file; bumping a
 * prompt means adding `<name>.v2.ts` and switching the import here, so old
 * reports remain attributable to the exact prompt that produced them
 * (reports.prompt_versions_json records PROMPT_VERSIONS).
 */

export * as interviewer from "./interviewer.v1";
export * as turnAnalysis from "./turn-analysis.v1";
export * as scoreAnswer from "./score-answer.v1";
export * as improvementPlan from "./improvement-plan.v1";
export { jsonRepairPrompt } from "./json-repair.v1";

import * as interviewerV from "./interviewer.v1";
import * as turnAnalysisV from "./turn-analysis.v1";
import * as scoreAnswerV from "./score-answer.v1";
import * as improvementPlanV from "./improvement-plan.v1";
import * as jsonRepairV from "./json-repair.v1";

export const PROMPT_VERSIONS: Record<string, number> = Object.fromEntries(
  [interviewerV, turnAnalysisV, scoreAnswerV, improvementPlanV, jsonRepairV].map((p) => [
    p.id,
    p.version,
  ]),
);
