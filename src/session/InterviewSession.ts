import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import type { Exchange, SessionConfig, Transcript, TranscriptMessage, WeakArea } from "../domain";
import { workersAiClient, type LlmClient } from "../llm/client";
import { generateJson } from "../llm/json";
import { INTERVIEWER_MAX_TOKENS, isRateLimited, readLimits } from "../limits";
import { interviewer, turnAnalysis } from "../prompts";
import type { TurnPlan } from "../prompts/interviewer.v1";
import type { TurnAnalysis } from "../prompts/turn-analysis.v1";
import {
  ClientMessageSchema,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from "./protocol";
import { decideNextTurn } from "./turn";

/**
 * One Durable Object per interview session (Agents SDK, SQLite-backed).
 *
 * Owns everything about a live interview: config, adaptive difficulty, the
 * full transcript, question tree and the interviewer's running notes. Because
 * a single DO instance serialises all events for a session, there are no
 * cross-request races on turn order, and a reconnecting client is simply
 * sent the stored transcript.
 *
 * Small, client-visible fields live in Agent state (auto-synced to every
 * connected socket as `cf_agent_state`); the growing transcript lives in
 * SQLite tables and is sent as an explicit `snapshot` on connect.
 */

export type SessionStatus = "new" | "active" | "ending" | "evaluating" | "done" | "failed";

export interface EvaluationState {
  instanceId: string;
  progress: string | null;
  overallScore: number | null;
  error: string | null;
}

export interface SessionState {
  sessionId: string | null;
  userId: string | null;
  config: SessionConfig | null;
  status: SessionStatus;
  difficulty: number;
  /** Candidate answers received. */
  turnCount: number;
  maxTurns: number;
  maxAnswerChars: number;
  /** Weak areas from previous sessions (read from D1 at session creation). */
  focusAreas: WeakArea[];
  /** True while an interviewer message is being generated. */
  generating: boolean;
  /** The plan of the interviewer message that is due; kept until it streams fully, enabling retry. */
  pendingPlan: TurnPlan | null;
  evaluation: EvaluationState | null;
  createdAt: number;
}

export interface InitSessionInput {
  sessionId: string;
  userId: string;
  config: SessionConfig;
  focusAreas: WeakArea[];
}

export interface EvaluationParams {
  sessionId: string;
  userId: string;
}

interface MessageRow {
  seq: number;
  speaker: "interviewer" | "candidate";
  content: string;
  question_id: string | null;
  incomplete: number;
  created_at: number;
}

interface QuestionRow {
  id: string;
  idx: number;
  topic: string | null;
  difficulty: number;
  parent_id: string | null;
  root_id: string;
}

/** Flush streamed tokens to SQLite every N tokens (durability vs. write count). */
const FLUSH_EVERY_TOKENS = 24;
const EVALUATION_WORKFLOW = "EVALUATION_WORKFLOW";

export class InterviewSession extends Agent<Env, SessionState> {
  override initialState: SessionState = {
    sessionId: null,
    userId: null,
    config: null,
    status: "new",
    difficulty: 2,
    turnCount: 0,
    maxTurns: 12,
    maxAnswerChars: 2000,
    focusAreas: [],
    generating: false,
    pendingPlan: null,
    evaluation: null,
    createdAt: 0,
  };

  /** In-memory copy of the message currently streaming, so snapshots are exact mid-stream. */
  private live: { seq: number; content: string } | null = null;

  /** Overridable in tests. */
  protected llm(): LlmClient {
    return workersAiClient(this.env.AI, this.env.MODEL_ID);
  }

  override onStart(): void {
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      speaker TEXT NOT NULL CHECK (speaker IN ('interviewer', 'candidate')),
      content TEXT NOT NULL,
      question_id TEXT,
      incomplete INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      idx INTEGER NOT NULL,
      topic TEXT,
      difficulty INTEGER NOT NULL,
      parent_id TEXT,
      root_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id TEXT NOT NULL,
      quality TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`;

    // If the object was evicted or crashed mid-generation, nothing is
    // generating any more. The incomplete message stays flagged and
    // pendingPlan is kept, so the client can offer "retry".
    if (this.state.generating) {
      this.setState({ ...this.state, generating: false });
    }
  }

  /** Only server code may change state; clients receive it read-only. */
  override validateStateChange(_next: SessionState, source: Connection | "server"): void {
    if (source !== "server") throw new Error("session state is server-owned");
  }

  // ───────────────────────────── RPC (Worker / Workflow) ─────────────────────────────

  /** Called once by POST /api/sessions. Idempotent: a second call never overwrites. */
  async init(input: InitSessionInput): Promise<{ created: boolean }> {
    if (this.state.status !== "new") return { created: false };
    const limits = readLimits(this.env);
    this.setState({
      ...this.state,
      sessionId: input.sessionId,
      userId: input.userId,
      config: input.config,
      focusAreas: input.focusAreas,
      status: "active",
      difficulty: input.config.seniority === "junior" ? 2 : 3,
      maxTurns: limits.maxTurns,
      maxAnswerChars: limits.maxAnswerChars,
      pendingPlan: { action: "open" },
      createdAt: Date.now(),
    });
    return { created: true };
  }

  /** Read by the evaluation Workflow's first step. */
  async getTranscript(): Promise<Transcript> {
    const { sessionId, userId, config } = this.state;
    if (!sessionId || !userId || !config) throw new Error("session not initialised");
    return {
      sessionId,
      userId,
      config,
      exchanges: this.exchanges(),
      focusAreas: this.state.focusAreas,
    };
  }

  // ───────────────────────────── WebSocket lifecycle ─────────────────────────────

  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const uid = new URL(ctx.request.url).searchParams.get("uid");
    if (this.state.status === "new") {
      connection.close(4404, "unknown session");
      return;
    }
    if (!uid || uid !== this.state.userId) {
      connection.close(4403, "not your session");
      return;
    }

    this.send(connection, { type: "snapshot", messages: this.transcript() });

    // First connection after creation: generate the opening question.
    if (
      this.state.status === "active" &&
      this.state.pendingPlan?.action === "open" &&
      !this.state.generating
    ) {
      await this.keepAliveWhile(() => this.speak({ action: "open" }));
    }
  }

  override async onMessage(connection: Connection, raw: WSMessage): Promise<void> {
    const msg = parseClientMessage(raw);
    if ("code" in msg) {
      this.fail(connection, msg);
      return;
    }
    let rejection: Rejection | null;
    switch (msg.type) {
      case "answer":
        rejection = await this.handleAnswer(msg.text);
        break;
      case "end":
        rejection = await this.handleEnd();
        break;
      case "retry":
        rejection = await this.handleRetry();
        break;
      case "retry_evaluation":
        rejection = await this.handleRetryEvaluation();
        break;
    }
    if (rejection) this.fail(connection, rejection);
  }

  // ───────────────────────────── Turn handling ─────────────────────────────
  // Handlers return a Rejection (sent only to the requesting socket) or null.

  private async handleAnswer(text: string): Promise<Rejection | null> {
    const s = this.state;
    const answer = text.trim();
    if (s.status !== "active") return reject("not_active", "the interview is not active");
    if (s.generating || s.pendingPlan) {
      return reject("busy", "wait for the interviewer's question first");
    }
    if (answer.length === 0) return reject("empty_answer", "answer is empty");
    if (answer.length > s.maxAnswerChars) {
      return reject("answer_too_long", `answers are limited to ${s.maxAnswerChars} characters`);
    }
    if (s.turnCount >= s.maxTurns) return reject("turn_cap", "turn limit reached");
    if (await isRateLimited(this.env.MESSAGE_RATE_LIMITER, `msg:${s.userId ?? "anon"}`)) {
      return reject("rate_limited", "slow down a little and try again");
    }

    const question = this.currentQuestion();
    if (!question) return reject("busy", "no question has been asked yet");

    const message = this.insertMessage("candidate", answer, question.id, false);
    this.broadcastMessage({ type: "message", message });
    this.setState({ ...this.state, turnCount: s.turnCount + 1, generating: true });

    try {
      const analysis = await this.analyse(question, answer);
      const decision = decideNextTurn({
        analysis,
        difficulty: this.state.difficulty,
        followUpsOnTopic: this.followUpsOnTopic(question),
        turnCount: this.state.turnCount,
        maxTurns: this.state.maxTurns,
      });
      this.setState({ ...this.state, difficulty: decision.difficulty, pendingPlan: decision.plan });
    } finally {
      this.setState({ ...this.state, generating: false });
    }

    const plan = this.state.pendingPlan;
    if (plan) await this.speak(plan);
    return null;
  }

  private async handleEnd(): Promise<Rejection | null> {
    const s = this.state;
    if (s.status !== "active") return reject("not_active", "the interview is not active");
    if (s.generating) return reject("busy", "wait for the interviewer to finish");
    if (s.turnCount === 0) {
      // Nothing to evaluate; finish without starting a Workflow.
      this.setState({ ...s, status: "done", pendingPlan: null });
      return null;
    }
    await this.speak({ action: "close" });
    return null;
  }

  private async handleRetry(): Promise<Rejection | null> {
    const plan = this.state.pendingPlan;
    if (this.state.generating) return reject("busy", "already generating");
    if (!plan) return reject("nothing_to_retry", "nothing to retry");
    await this.speak(plan);
    return null;
  }

  private async handleRetryEvaluation(): Promise<Rejection | null> {
    const ev = this.state.evaluation;
    if (this.state.status !== "failed" || !ev) {
      return reject("nothing_to_retry", "evaluation has not failed");
    }
    await this.restartWorkflow(ev.instanceId);
    this.setState({
      ...this.state,
      status: "evaluating",
      evaluation: { ...ev, error: null, progress: "Restarting evaluation" },
    });
    return null;
  }

  /**
   * Turn analysis (JSON). Failure here must never block the interview, so any
   * error degrades to `null`, which the deterministic guards turn into
   * "ask the next question at the same difficulty".
   */
  private async analyse(question: QuestionRow, answer: string): Promise<TurnAnalysis | null> {
    const config = this.requireConfig();
    try {
      const { data } = await generateJson({
        llm: this.llm(),
        schema: turnAnalysis.TurnAnalysisSchema,
        messages: turnAnalysis.build({
          config,
          difficulty: this.state.difficulty,
          question: this.questionText(question.id),
          answer,
          followUpsOnTopic: this.followUpsOnTopic(question),
          coveredTopics: this.coveredTopics(),
        }),
        maxTokens: 400,
        temperature: 0,
      });
      const now = Date.now();
      this.sql`INSERT INTO notes (question_id, quality, note, created_at)
               VALUES (${question.id}, ${data.answer_quality}, ${data.note}, ${now})`;
      this.sql`UPDATE questions SET topic = ${data.topic} WHERE id = ${question.id}`;
      return data;
    } catch (err) {
      console.error("turn analysis failed; using fallback plan", err);
      return null;
    }
  }

  /**
   * Generate one interviewer message for `plan` and stream it to every
   * connected socket. The message row is created up front (incomplete) and
   * flushed periodically, so a crash leaves a recoverable partial message.
   */
  private async speak(plan: TurnPlan): Promise<void> {
    const config = this.requireConfig();
    this.setState({
      ...this.state,
      generating: true,
      pendingPlan: plan,
      status: plan.action === "close" ? "ending" : this.state.status,
    });

    // A retry replaces the previous failed attempt rather than stacking a duplicate.
    this.discardIncompleteInterviewerMessage();

    const questionId = plan.action === "close" ? null : this.createQuestion(plan);
    const messages = interviewer.build({
      config,
      difficulty: this.state.difficulty,
      focusAreas: this.state.focusAreas,
      coveredTopics: this.coveredTopics(),
      history: this.transcript(),
      plan,
    });

    const row = this.insertMessage("interviewer", "", questionId, true);
    this.live = { seq: row.seq, content: "" };
    this.broadcastMessage({ type: "message_start", seq: row.seq, questionId });

    let tokens = 0;
    let failed = false;
    try {
      for await (const token of this.llm().stream({
        messages,
        maxTokens: INTERVIEWER_MAX_TOKENS,
        temperature: 0.7,
      })) {
        this.live.content += token;
        this.broadcastMessage({ type: "token", seq: row.seq, text: token });
        if (++tokens % FLUSH_EVERY_TOKENS === 0) {
          this.sql`UPDATE messages SET content = ${this.live.content} WHERE seq = ${row.seq}`;
        }
      }
      if (this.live.content.trim().length === 0) throw new Error("empty interviewer response");
    } catch (err) {
      failed = true;
      console.error("interviewer stream failed", err);
    }

    const content = this.live.content;
    this.live = null;
    this
      .sql`UPDATE messages SET content = ${content}, incomplete = ${failed ? 1 : 0} WHERE seq = ${row.seq}`;
    this.broadcastMessage({ type: "message_end", seq: row.seq, interrupted: failed });

    if (failed) {
      this.setState({ ...this.state, generating: false });
      this.broadcastMessage({
        type: "error",
        code: "llm_unavailable",
        message: "The interviewer could not respond. Use retry to try again.",
      });
      return;
    }

    this.setState({ ...this.state, generating: false, pendingPlan: null });
    if (plan.action === "close") await this.startEvaluation();
  }

  // ───────────────────────────── Evaluation Workflow ─────────────────────────────

  private async startEvaluation(): Promise<void> {
    const { sessionId, userId, evaluation } = this.state;
    if (evaluation || !sessionId || !userId) return; // already started: idempotent
    const params: EvaluationParams = { sessionId, userId };
    // Deterministic instance id: a duplicate "end" can never start a second evaluation.
    const instanceId = await this.runWorkflow(EVALUATION_WORKFLOW, params, {
      id: `eval-${sessionId}`,
      metadata: { userId },
    });
    this.setState({
      ...this.state,
      status: "evaluating",
      evaluation: { instanceId, progress: "Queued", overallScore: null, error: null },
    });
  }

  override async onWorkflowProgress(_name: string, _id: string, progress: unknown): Promise<void> {
    const ev = this.state.evaluation;
    const message = (progress as { message?: unknown } | null)?.message;
    if (ev && typeof message === "string") {
      this.setState({ ...this.state, evaluation: { ...ev, progress: message } });
    }
  }

  override async onWorkflowComplete(_name: string, _id: string, result?: unknown): Promise<void> {
    const ev = this.state.evaluation;
    if (!ev) return;
    const overall = (result as { overallScore?: unknown } | undefined)?.overallScore;
    this.setState({
      ...this.state,
      status: "done",
      evaluation: {
        ...ev,
        progress: "Report ready",
        overallScore: typeof overall === "number" ? overall : null,
        error: null,
      },
    });
  }

  override async onWorkflowError(_name: string, _id: string, error: string): Promise<void> {
    const ev = this.state.evaluation;
    if (!ev) return;
    console.error("evaluation workflow failed", error);
    this.setState({
      ...this.state,
      status: "failed",
      evaluation: { ...ev, progress: null, error: "Evaluation failed. You can retry it." },
    });
  }

  // ───────────────────────────── Storage helpers ─────────────────────────────

  private requireConfig(): SessionConfig {
    const config = this.state.config;
    if (!config) throw new Error("session not initialised");
    return config;
  }

  private insertMessage(
    speaker: "interviewer" | "candidate",
    content: string,
    questionId: string | null,
    incomplete: boolean,
  ): TranscriptMessage {
    const now = Date.now();
    const [row] = this.sql<MessageRow>`
      INSERT INTO messages (speaker, content, question_id, incomplete, created_at)
      VALUES (${speaker}, ${content}, ${questionId}, ${incomplete ? 1 : 0}, ${now})
      RETURNING *`;
    if (!row) throw new Error("failed to insert message");
    return toMessage(row);
  }

  private discardIncompleteInterviewerMessage(): void {
    const rows = this.sql<{ seq: number; question_id: string | null }>`
      SELECT seq, question_id FROM messages
      WHERE speaker = 'interviewer' AND incomplete = 1`;
    for (const r of rows) {
      this.sql`DELETE FROM messages WHERE seq = ${r.seq}`;
      if (r.question_id) this.sql`DELETE FROM questions WHERE id = ${r.question_id}`;
    }
  }

  /** Full transcript; the streaming message (if any) reflects every token sent so far. */
  private transcript(): TranscriptMessage[] {
    const rows = this.sql<MessageRow>`SELECT * FROM messages ORDER BY seq`;
    return rows.map((r) => {
      const m = toMessage(r);
      return this.live && this.live.seq === m.seq ? { ...m, content: this.live.content } : m;
    });
  }

  private currentQuestion(): QuestionRow | null {
    const [q] = this.sql<QuestionRow>`SELECT * FROM questions ORDER BY idx DESC LIMIT 1`;
    return q ?? null;
  }

  private createQuestion(plan: Exclude<TurnPlan, { action: "close" }>): string {
    const prev = this.currentQuestion();
    const id = crypto.randomUUID();
    const isFollowUp = plan.action === "followup" && prev !== null;
    const parentId = isFollowUp ? prev.id : null;
    const rootId = isFollowUp ? prev.root_id : id;
    const topic = plan.action === "next" ? plan.topic : isFollowUp ? prev.topic : null;
    const idx = (prev?.idx ?? -1) + 1;
    this.sql`INSERT INTO questions (id, idx, topic, difficulty, parent_id, root_id, created_at)
             VALUES (${id}, ${idx}, ${topic}, ${this.state.difficulty}, ${parentId}, ${rootId}, ${Date.now()})`;
    return id;
  }

  private followUpsOnTopic(q: QuestionRow): number {
    const [row] = this.sql<{
      n: number;
    }>`SELECT COUNT(*) AS n FROM questions WHERE root_id = ${q.root_id}`;
    return Math.max(0, (row?.n ?? 1) - 1);
  }

  private coveredTopics(): string[] {
    const rows = this.sql<{ topic: string }>`
      SELECT DISTINCT topic FROM questions WHERE topic IS NOT NULL AND parent_id IS NULL ORDER BY idx`;
    return rows.map((r) => r.topic);
  }

  private questionText(questionId: string): string {
    const [row] = this.sql<{ content: string }>`
      SELECT content FROM messages WHERE question_id = ${questionId} AND speaker = 'interviewer'
      ORDER BY seq LIMIT 1`;
    return row?.content ?? "";
  }

  /** Question/answer pairs for scoring. Unanswered or incomplete questions are skipped. */
  private exchanges(): Exchange[] {
    const rows = this.sql<{
      id: string;
      topic: string | null;
      difficulty: number;
      parent_id: string | null;
      question: string | null;
      answer: string | null;
    }>`
      SELECT q.id, q.topic, q.difficulty, q.parent_id,
        (SELECT content FROM messages m WHERE m.question_id = q.id AND m.speaker = 'interviewer'
           AND m.incomplete = 0 ORDER BY seq LIMIT 1) AS question,
        (SELECT group_concat(content, char(10)) FROM messages m WHERE m.question_id = q.id
           AND m.speaker = 'candidate') AS answer
      FROM questions q ORDER BY q.idx`;
    return rows
      .filter(
        (r): r is typeof r & { question: string; answer: string } => !!r.question && !!r.answer,
      )
      .map((r, index) => ({
        index,
        questionId: r.id,
        question: r.question,
        topic: r.topic ?? "general",
        difficulty: r.difficulty,
        isFollowUp: r.parent_id !== null,
        answer: r.answer,
      }));
  }

  // ───────────────────────────── Messaging helpers ─────────────────────────────

  private send(connection: Connection, msg: ServerMessage): void {
    connection.send(JSON.stringify(msg));
  }

  private broadcastMessage(msg: ServerMessage): void {
    this.broadcast(JSON.stringify(msg));
  }

  private fail(connection: Connection, { code, message }: Rejection): void {
    this.send(connection, { type: "error", code, message });
  }
}

interface Rejection {
  code: ErrorCode;
  message: string;
}

function reject(code: ErrorCode, message: string): Rejection {
  return { code, message };
}

/** Validate an inbound frame against the protocol schema. */
function parseClientMessage(raw: WSMessage): ClientMessage | Rejection {
  if (typeof raw !== "string") return reject("invalid_message", "text frames only");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return reject("invalid_message", "malformed JSON");
  }
  const parsed = ClientMessageSchema.safeParse(json);
  return parsed.success ? parsed.data : reject("invalid_message", "unknown message");
}

function toMessage(r: MessageRow): TranscriptMessage {
  return {
    seq: r.seq,
    speaker: r.speaker,
    content: r.content,
    questionId: r.question_id,
    incomplete: r.incomplete === 1,
    createdAt: r.created_at,
  };
}
