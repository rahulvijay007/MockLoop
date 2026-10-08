import type { InterviewType, SessionConfig, WeakArea } from "../domain";
import type { ImprovementPlan } from "../prompts/improvement-plan.v1";
import type { Aggregate, QuestionScore } from "../rubric/aggregate";
import { dimensionLabel } from "../rubric/rubrics";

/**
 * D1 access for long-lived memory: finished reports and the per-user
 * weak-area profile. All writes are idempotent upserts keyed by session id,
 * so the Workflow's persist step can be retried safely.
 */

/** Only the most recent N evaluated sessions count towards the profile. */
export const PROFILE_WINDOW_SESSIONS = 5;
export const PROFILE_TOP_N = 3;

export async function getWeakAreaProfile(
  db: D1Database,
  userId: string,
  limit = PROFILE_TOP_N,
): Promise<WeakArea[]> {
  // "Recurring" = flagged in the most sessions within the recent window;
  // ties broken by the lowest average score. Evidence is the latest quote.
  const { results } = await db
    .prepare(
      `WITH recent AS (
         SELECT session_id FROM reports WHERE user_id = ?1
         ORDER BY created_at DESC LIMIT ?2
       )
       SELECT w.area AS area,
              AVG(w.score) AS avg_score,
              COUNT(*) AS sessions,
              (SELECT w2.evidence FROM weak_area_observations w2
                WHERE w2.user_id = ?1 AND w2.area = w.area
                ORDER BY w2.created_at DESC LIMIT 1) AS evidence
       FROM weak_area_observations w
       WHERE w.user_id = ?1 AND w.session_id IN (SELECT session_id FROM recent)
       GROUP BY w.area
       ORDER BY sessions DESC, avg_score ASC, area ASC
       LIMIT ?3`,
    )
    .bind(userId, PROFILE_WINDOW_SESSIONS, limit)
    .all<{ area: string; avg_score: number; sessions: number; evidence: string | null }>();

  return results.map((r) => ({
    area: r.area,
    label: dimensionLabel(r.area),
    avgScore: Math.round(r.avg_score * 100) / 100,
    sessions: r.sessions,
    evidence: r.evidence ?? "",
  }));
}

export interface ReportRecord {
  sessionId: string;
  userId: string;
  config: SessionConfig;
  aggregate: Aggregate;
  questionScores: QuestionScore[];
  plan: ImprovementPlan;
  modelId: string;
  promptVersions: Record<string, number>;
  createdAt: number;
}

export async function persistReport(db: D1Database, r: ReportRecord): Promise<void> {
  const upsertReport = db
    .prepare(
      `INSERT INTO reports (session_id, user_id, role, seniority, interview_type, overall_score,
         dimension_scores_json, question_scores_json, plan_json, model_id, prompt_versions_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT (session_id) DO UPDATE SET
         overall_score = excluded.overall_score,
         dimension_scores_json = excluded.dimension_scores_json,
         question_scores_json = excluded.question_scores_json,
         plan_json = excluded.plan_json,
         model_id = excluded.model_id,
         prompt_versions_json = excluded.prompt_versions_json`,
    )
    .bind(
      r.sessionId,
      r.userId,
      r.config.role,
      r.config.seniority,
      r.config.type,
      r.aggregate.overall,
      JSON.stringify(r.aggregate.dimensions),
      JSON.stringify(r.questionScores),
      JSON.stringify(r.plan),
      r.modelId,
      JSON.stringify(r.promptVersions),
      r.createdAt,
    );

  // Replace this session's observations wholesale so a retry with different
  // weak areas can never leave stale rows behind.
  const clearObservations = db
    .prepare(`DELETE FROM weak_area_observations WHERE user_id = ?1 AND session_id = ?2`)
    .bind(r.userId, r.sessionId);

  const insertObservations = r.aggregate.weakAreas.map((w) =>
    db
      .prepare(
        `INSERT INTO weak_area_observations (user_id, session_id, area, score, evidence, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(r.userId, r.sessionId, w.id, w.score, w.evidence, r.createdAt),
  );

  // D1 batches run as a single transaction.
  await db.batch([upsertReport, clearObservations, ...insertObservations]);
}

export interface ReportView {
  sessionId: string;
  role: string;
  seniority: string;
  interviewType: InterviewType;
  overallScore: number;
  dimensions: Aggregate["dimensions"];
  questionScores: QuestionScore[];
  plan: ImprovementPlan;
  createdAt: number;
}

interface ReportRow {
  session_id: string;
  role: string;
  seniority: string;
  interview_type: InterviewType;
  overall_score: number;
  dimension_scores_json: string;
  question_scores_json: string;
  plan_json: string;
  created_at: number;
}

export async function getReport(
  db: D1Database,
  userId: string,
  sessionId: string,
): Promise<ReportView | null> {
  const row = await db
    .prepare(`SELECT * FROM reports WHERE session_id = ?1 AND user_id = ?2`)
    .bind(sessionId, userId)
    .first<ReportRow>();
  if (!row) return null;
  return {
    sessionId: row.session_id,
    role: row.role,
    seniority: row.seniority,
    interviewType: row.interview_type,
    overallScore: row.overall_score,
    dimensions: JSON.parse(row.dimension_scores_json) as Aggregate["dimensions"],
    questionScores: JSON.parse(row.question_scores_json) as QuestionScore[],
    plan: JSON.parse(row.plan_json) as ImprovementPlan,
    createdAt: row.created_at,
  };
}

export async function listReports(
  db: D1Database,
  userId: string,
  limit = 10,
): Promise<
  {
    sessionId: string;
    role: string;
    interviewType: string;
    overallScore: number;
    createdAt: number;
  }[]
> {
  const { results } = await db
    .prepare(
      `SELECT session_id, role, interview_type, overall_score, created_at FROM reports
       WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2`,
    )
    .bind(userId, limit)
    .all<{
      session_id: string;
      role: string;
      interview_type: string;
      overall_score: number;
      created_at: number;
    }>();
  return results.map((r) => ({
    sessionId: r.session_id,
    role: r.role,
    interviewType: r.interview_type,
    overallScore: r.overall_score,
    createdAt: r.created_at,
  }));
}
