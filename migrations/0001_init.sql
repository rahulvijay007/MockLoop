-- MockLoop D1 schema: finished reports and the per-user weak-area profile.
-- Live session state never lands here; it lives in the session Durable Object.

-- One row per evaluated interview. Written by the evaluation Workflow's
-- persist step with an upsert, so a retried step cannot create duplicates.
CREATE TABLE IF NOT EXISTS reports (
  session_id            TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  role                  TEXT NOT NULL,
  seniority             TEXT NOT NULL,
  interview_type        TEXT NOT NULL CHECK (interview_type IN ('behavioral', 'technical', 'system_design')),
  overall_score         REAL NOT NULL,          -- 1.0 – 5.0
  dimension_scores_json TEXT NOT NULL,          -- { [dimension]: { score, weight } }
  question_scores_json  TEXT NOT NULL,          -- per-question scores + evidence
  plan_json             TEXT NOT NULL,          -- improvement plan
  model_id              TEXT NOT NULL,
  prompt_versions_json  TEXT NOT NULL,          -- which prompt versions produced this report
  created_at            INTEGER NOT NULL        -- unix ms
);

CREATE INDEX IF NOT EXISTS idx_reports_user_created ON reports (user_id, created_at DESC);

-- One row per (user, session, weak area). The composite primary key makes the
-- persist step idempotent: re-running it for the same session is a no-op.
-- The profile the interviewer reads is derived from these rows by query.
CREATE TABLE IF NOT EXISTS weak_area_observations (
  user_id     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  area        TEXT NOT NULL,                   -- rubric dimension id, e.g. 'tradeoffs'
  score       REAL NOT NULL,                   -- the dimension score that flagged it
  evidence    TEXT NOT NULL,                   -- short quote / rationale
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id, area)
);

CREATE INDEX IF NOT EXISTS idx_weak_user_created ON weak_area_observations (user_id, created_at DESC);
