// @ts-check
/**
 * MockLoop browser client. Vanilla JS (no build step), type-checked by
 * `tsc -p tsconfig.client.json` via JSDoc.
 *
 * Talks to:
 *   POST /api/sessions, GET /api/profile, GET /api/sessions/:id/report  (HTTP)
 *   /agents/interview-session/:id?uid=...                            (WebSocket)
 *
 * The server is the source of truth: on every (re)connect it sends a full
 * `snapshot` of the transcript, and the Agents SDK pushes `cf_agent_state`.
 * The client only renders; it never reconstructs state on its own.
 */

/**
 * @typedef {{ seq: number, speaker: "interviewer" | "candidate", content: string,
 *   questionId: string | null, incomplete: boolean, createdAt: number }} Message
 * @typedef {{ area: string, label: string, avgScore: number, sessions: number, evidence: string }} WeakArea
 * @typedef {{ instanceId: string, progress: string | null, overallScore: number | null, error: string | null }} Evaluation
 * @typedef {{ sessionId: string | null, config: { role: string, seniority: string, type: string } | null,
 *   status: "new" | "active" | "ending" | "evaluating" | "done" | "failed", difficulty: number,
 *   turnCount: number, maxTurns: number, maxAnswerChars: number, focusAreas: WeakArea[],
 *   generating: boolean, pendingPlan: unknown, evaluation: Evaluation | null }} SessionState
 * @typedef {{ id: string, score: number | null, weight: number, samples: number }} Dimension
 * @typedef {{ index: number, scores: Record<string, number | null>, evidence: string,
 *   strengths: string[], gaps: string[] }} QuestionScore
 * @typedef {{ summary: string, priorities: { area: string, title: string, why: string, drills: string[] }[],
 *   practice_questions: string[] }} Plan
 * @typedef {{ sessionId: string, role: string, seniority: string, interviewType: string,
 *   overallScore: number, dimensions: Dimension[], questionScores: QuestionScore[], plan: Plan,
 *   createdAt: number }} ReportView
 */

const TYPE_LABELS = /** @type {Record<string, string>} */ ({
  behavioral: "Behavioral",
  technical: "Technical",
  system_design: "System design",
});

const DIMENSION_LABELS = /** @type {Record<string, string>} */ ({
  structure: "Structure (STAR)",
  ownership: "Ownership",
  impact: "Impact & metrics",
  reflection: "Reflection",
  communication: "Communication",
  correctness: "Correctness",
  depth: "Depth",
  tradeoffs: "Trade-offs",
  problem_solving: "Problem solving",
  requirements: "Requirements",
  architecture: "Architecture",
  scalability: "Scalability & reliability",
});

// ───────────────────────────── DOM helpers ─────────────────────────────

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @returns {T}
 */
function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return /** @type {T} */ (el);
}

/**
 * Create an element with text content (never innerHTML: all model and user text is untrusted).
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @param {string} message */
function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(Number(t.dataset.timer));
  t.dataset.timer = String(setTimeout(() => (t.hidden = true), 4000));
}

/** @param {"setup-view" | "interview-view" | "report-view"} id */
function showView(id) {
  for (const v of document.querySelectorAll(".view"))
    /** @type {HTMLElement} */ (v).hidden = v.id !== id;
}

// ───────────────────────────── Identity ─────────────────────────────

/** Anonymous per-browser id. Not authentication; see README "Known shortcuts". */
function getUserId() {
  const KEY = "mockloop:user";
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return crypto.randomUUID(); // storage blocked: works for this tab only
  }
}
const userId = getUserId();

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function api(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", "x-mockloop-user": userId, ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body;
}

// ───────────────────────────── Routing ─────────────────────────────

function route() {
  stopSession();
  const params = new URLSearchParams(location.hash.slice(1));
  const session = params.get("session");
  const report = params.get("report");
  if (session) startSession(session);
  else if (report) void showReport(report);
  else void showSetup();
}
window.addEventListener("hashchange", route);

// ───────────────────────────── Setup + profile ─────────────────────────────

async function showSetup() {
  showView("setup-view");
  $("conn").hidden = true;
  try {
    /** @type {{ weakAreas: WeakArea[], reports: { sessionId: string, role: string, interviewType: string, overallScore: number, createdAt: number }[] }} */
    const profile = await api("/api/profile");
    const list = $("weak-areas");
    list.replaceChildren();
    for (const w of profile.weakAreas) {
      const li = el("li");
      li.append(
        el("strong", "", w.label),
        el("span", "score-pill", `${w.avgScore.toFixed(1)}/5 · ${w.sessions}×`),
      );
      if (w.evidence) li.append(el("div", "muted", w.evidence));
      list.append(li);
    }
    $("profile-empty").hidden = profile.weakAreas.length > 0;

    const history = $("history");
    history.replaceChildren();
    for (const r of profile.reports) {
      const a = el(
        "a",
        "",
        `${r.role} · ${TYPE_LABELS[r.interviewType] ?? r.interviewType} · ${r.overallScore.toFixed(1)}/5`,
      );
      /** @type {HTMLAnchorElement} */ (a).href = `#report=${r.sessionId}`;
      const li = el("li");
      li.append(a, el("span", "muted", ` ${new Date(r.createdAt).toLocaleDateString()}`));
      history.append(li);
    }
    $("history-title").hidden = profile.reports.length === 0;
  } catch (e) {
    console.warn("profile unavailable", e);
  }
}

$("setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = /** @type {HTMLFormElement} */ (event.currentTarget);
  const data = Object.fromEntries(new FormData(form));
  const btn = /** @type {HTMLButtonElement} */ ($("start-btn"));
  const err = $("setup-error");
  btn.disabled = true;
  err.hidden = true;
  try {
    /** @type {{ sessionId: string }} */
    const { sessionId } = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify(data),
    });
    location.hash = `session=${sessionId}`;
  } catch (e) {
    err.textContent = /** @type {Error} */ (e).message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// ───────────────────────────── Live session ─────────────────────────────

/** @type {{ id: string, ws: WebSocket | null, attempts: number, closed: boolean, timer: number | undefined } | null} */
let session = null;
/** @type {Map<number, Message>} */
let messages = new Map();
/** @type {SessionState | null} */
let state = null;
let needsRetry = false;

/** @param {string} id */
function startSession(id) {
  showView("interview-view");
  messages = new Map();
  state = null;
  needsRetry = false;
  renderTranscript();
  session = { id, ws: null, attempts: 0, closed: false, timer: undefined };
  connect();
}

function stopSession() {
  if (!session) return;
  session.closed = true;
  clearTimeout(session.timer);
  session.ws?.close(1000, "navigated away");
  session = null;
  stopListening();
  speechSynthesis?.cancel?.();
}

function connect() {
  const s = session;
  if (!s) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(
    `${proto}//${location.host}/agents/interview-session/${s.id}?uid=${userId}`,
  );
  s.ws = ws;
  setConn("connecting", s.attempts ? "Reconnecting…" : "Connecting…");

  ws.addEventListener("open", () => {
    s.attempts = 0;
    setConn("open", "Connected");
  });
  ws.addEventListener("message", (e) => handleServerMessage(String(e.data)));
  ws.addEventListener("close", (e) => {
    if (s.closed || session !== s) return;
    if (e.code === 4403 || e.code === 4404) {
      setConn("closed", "Session unavailable");
      toast(
        e.code === 4404
          ? "That session does not exist."
          : "That session belongs to another browser.",
      );
      return;
    }
    // Exponential backoff; on reconnect the server resends the full transcript.
    const delay = Math.min(10_000, 500 * 2 ** s.attempts++);
    setConn("closed", `Disconnected, retrying in ${Math.round(delay / 1000)}s`);
    s.timer = setTimeout(connect, delay);
  });
}

/**
 * @param {"connecting" | "open" | "closed"} st
 * @param {string} label
 */
function setConn(st, label) {
  const c = $("conn");
  c.hidden = false;
  c.dataset.state = st;
  $("conn-label").textContent = label;
}

/** @param {string} raw */
function handleServerMessage(raw) {
  /** @type {any} */
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.type) {
    case "cf_agent_state":
      state = /** @type {SessionState} */ (msg.state);
      renderState();
      return;
    case "snapshot":
      messages = new Map(/** @type {Message[]} */ (msg.messages).map((m) => [m.seq, m]));
      needsRetry =
        [...messages.values()].some((m) => m.speaker === "interviewer" && m.incomplete) &&
        !state?.generating;
      renderTranscript();
      renderState();
      return;
    case "message":
      messages.set(msg.message.seq, msg.message);
      renderTranscript();
      return;
    case "message_start":
      // A retry replaces a failed attempt: drop any incomplete interviewer message.
      for (const [seq, m] of messages)
        if (m.speaker === "interviewer" && m.incomplete) messages.delete(seq);
      messages.set(msg.seq, {
        seq: msg.seq,
        speaker: "interviewer",
        content: "",
        questionId: msg.questionId,
        incomplete: true,
        createdAt: Date.now(),
      });
      needsRetry = false;
      renderTranscript();
      renderState();
      return;
    case "token": {
      const m = messages.get(msg.seq);
      if (m) {
        m.content += msg.text;
        renderStreamingToken(m);
      }
      return;
    }
    case "message_end": {
      const m = messages.get(msg.seq);
      if (m) {
        m.incomplete = msg.interrupted;
        if (!msg.interrupted) speak(m.content);
      }
      needsRetry = msg.interrupted;
      renderTranscript();
      renderState();
      return;
    }
    case "error":
      if (msg.code === "llm_unavailable") needsRetry = true;
      toast(msg.message);
      renderState();
      return;
  }
}

/** @param {object} msg */
function send(msg) {
  if (session?.ws?.readyState !== WebSocket.OPEN) {
    toast("Not connected yet, please wait a moment.");
    return false;
  }
  session.ws.send(JSON.stringify(msg));
  return true;
}

function renderTranscript() {
  const box = $("transcript");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.replaceChildren();
  for (const m of [...messages.values()].sort((a, b) => a.seq - b.seq)) {
    box.append(renderMessage(m));
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/** @param {Message} m */
function renderMessage(m) {
  const streaming = m.speaker === "interviewer" && m.incomplete && state?.generating;
  const cls = ["msg", m.speaker];
  if (streaming) cls.push("streaming");
  else if (m.incomplete) cls.push("interrupted");
  const node = el("div", cls.join(" "));
  node.dataset.seq = String(m.seq);
  node.append(
    el("span", "who", m.speaker === "interviewer" ? "Interviewer" : "You"),
    el("span", "body", m.content),
  );
  return node;
}

/** Append-only fast path for streaming tokens (avoids re-rendering the transcript per token). */
/** @param {Message} m */
function renderStreamingToken(m) {
  const box = $("transcript");
  const node = box.querySelector(`[data-seq="${m.seq}"] .body`);
  if (!node) return renderTranscript();
  node.textContent = m.content;
  node.parentElement?.classList.add("streaming");
  box.scrollTop = box.scrollHeight;
}

function renderState() {
  if (!state || !state.config) return;
  const { config, status, generating } = state;
  $("session-title").textContent = `${config.role}`;
  $("session-meta").textContent =
    `${TYPE_LABELS[config.type] ?? config.type} · ${config.seniority}`;
  $("chip-difficulty").textContent = `Difficulty ${state.difficulty}/5`;
  $("chip-turns").textContent = `${state.turnCount} / ${state.maxTurns} answers`;

  const focus = $("focus-note");
  focus.hidden = state.focusAreas.length === 0;
  focus.textContent = `Targeting your recurring focus areas: ${state.focusAreas.map((w) => w.label).join(", ")}`;

  const active = status === "active";
  const answer = /** @type {HTMLTextAreaElement} */ ($("answer"));
  const sendBtn = /** @type {HTMLButtonElement} */ ($("send-btn"));
  const endBtn = /** @type {HTMLButtonElement} */ ($("end-btn"));
  const retryBtn = $("retry-btn");
  $("composer").hidden = !(active || status === "ending");
  answer.disabled = !active;
  sendBtn.disabled = !active || generating || needsRetry || !!state.pendingPlan;
  endBtn.disabled = !active || generating;
  retryBtn.hidden = !(needsRetry && !generating);
  updateCounter();

  const evalPanel = $("eval-panel");
  const ev = state.evaluation;
  evalPanel.hidden = !(status === "evaluating" || status === "failed");
  $("eval-progress").textContent =
    status === "failed" ? (ev?.error ?? "Evaluation failed.") : (ev?.progress ?? "Evaluating…");
  $("retry-eval-btn").hidden = status !== "failed";
  /** @type {HTMLElement} */ (evalPanel.querySelector(".spinner")).hidden = status === "failed";

  if (status === "done" && session) {
    if (ev) location.hash = `report=${session.id}`;
    else {
      toast("Interview ended. There were no answers to evaluate.");
      location.hash = "";
    }
  }
}

function updateCounter() {
  const answer = /** @type {HTMLTextAreaElement} */ ($("answer"));
  const max = state?.maxAnswerChars ?? 2000;
  const counter = $("counter");
  counter.textContent = `${answer.value.length} / ${max}`;
  counter.classList.toggle("over", answer.value.length > max);
}

$("answer").addEventListener("input", updateCounter);
$("answer").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    /** @type {HTMLFormElement} */ ($("composer")).requestSubmit();
  }
});

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const answer = /** @type {HTMLTextAreaElement} */ ($("answer"));
  const text = answer.value.trim();
  if (!text) return;
  if (state && text.length > state.maxAnswerChars) {
    toast(`Answers are limited to ${state.maxAnswerChars} characters.`);
    return;
  }
  stopListening();
  if (send({ type: "answer", text })) {
    answer.value = "";
    updateCounter();
  }
});

$("end-btn").addEventListener("click", () => send({ type: "end" }));
$("retry-btn").addEventListener("click", () => send({ type: "retry" }));
$("retry-eval-btn").addEventListener("click", () => send({ type: "retry_evaluation" }));

// ───────────────────────────── Report ─────────────────────────────

/** @param {string} sessionId */
async function showReport(sessionId) {
  showView("report-view");
  $("conn").hidden = true;
  $("report-summary").textContent = "Loading…";
  /** @type {ReportView} */
  let report;
  try {
    report = await api(`/api/sessions/${sessionId}/report`);
  } catch (e) {
    $("report-summary").textContent = /** @type {Error} */ (e).message;
    return;
  }
  $("report-meta").textContent =
    `${report.role} · ${TYPE_LABELS[report.interviewType] ?? report.interviewType} · ${report.seniority} · ${new Date(report.createdAt).toLocaleString()}`;
  const score = $("report-score");
  score.replaceChildren(String(report.overallScore.toFixed(1)), el("small", "", " / 5"));
  $("report-summary").textContent = report.plan.summary;

  const bars = $("report-dimensions");
  bars.replaceChildren();
  for (const d of report.dimensions) {
    const li = el("li");
    const label = el("div", "label");
    label.append(
      el("span", "", DIMENSION_LABELS[d.id] ?? d.id),
      el("span", "muted", d.score === null ? "n/a" : `${d.score.toFixed(1)}`),
    );
    const track = el("div", "track");
    const fill = el("div", `fill${d.score !== null && d.score < 3 ? " weak" : ""}`);
    fill.style.width = `${((d.score ?? 0) / 5) * 100}%`;
    track.append(fill);
    li.append(label, track);
    bars.append(li);
  }

  const pri = $("report-priorities");
  pri.replaceChildren();
  for (const p of report.plan.priorities) {
    const li = el("li");
    li.append(el("strong", "", p.title), el("div", "", p.why));
    const drills = el("ul");
    for (const d of p.drills) drills.append(el("li", "", d));
    li.append(drills);
    pri.append(li);
  }

  const practice = $("report-practice");
  practice.replaceChildren(...report.plan.practice_questions.map((q) => el("li", "", q)));

  const qs = $("report-questions");
  qs.replaceChildren();
  for (const q of report.questionScores) {
    const details = /** @type {HTMLDetailsElement} */ (el("details", "qa"));
    const applicable = Object.values(q.scores).filter((v) => typeof v === "number");
    const avg = applicable.length
      ? applicable.reduce((a, b) => a + (b ?? 0), 0) / applicable.length
      : 0;
    details.append(
      el("summary", "", `Answer ${q.index + 1} · ${avg.toFixed(1)}/5`),
      el("p", "", q.evidence),
    );
    if (q.strengths.length) details.append(el("p", "", `Strengths: ${q.strengths.join("; ")}`));
    if (q.gaps.length) details.append(el("p", "", `Gaps: ${q.gaps.join("; ")}`));
    qs.append(details);
  }
}

// ───────────────────────────── Voice (optional, feature-detected) ─────────────────────────────
// Browser Web Speech API only: speech never leaves the browser's own speech
// service, and the text path stays the primary input. Hidden when unsupported.

/** @type {any} */
const SpeechRecognitionCtor =
  /** @type {any} */ (window).SpeechRecognition ??
  /** @type {any} */ (window).webkitSpeechRecognition;
const ttsSupported = "speechSynthesis" in window;
/** @type {any} */
let recognition = null;

if (SpeechRecognitionCtor || ttsSupported) {
  $("voice").hidden = false;
  if (!SpeechRecognitionCtor) $("mic-btn").hidden = true;
  if (!ttsSupported) /** @type {HTMLElement} */ ($("tts-toggle").parentElement).hidden = true;
  try {
    /** @type {HTMLInputElement} */ ($("tts-toggle")).checked =
      localStorage.getItem("mockloop:tts") === "1";
  } catch {
    /* storage unavailable */
  }
}

$("tts-toggle").addEventListener("change", (e) => {
  const on = /** @type {HTMLInputElement} */ (e.target).checked;
  try {
    localStorage.setItem("mockloop:tts", on ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
  if (!on) speechSynthesis.cancel();
});

/** @param {string} text */
function speak(text) {
  if (!ttsSupported || !(/** @type {HTMLInputElement} */ ($("tts-toggle")).checked)) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

$("mic-btn").addEventListener("click", () => (recognition ? stopListening() : startListening()));

function startListening() {
  if (!SpeechRecognitionCtor) return;
  if (ttsSupported) speechSynthesis.cancel();
  const answer = /** @type {HTMLTextAreaElement} */ ($("answer"));
  const base = answer.value ? `${answer.value.trimEnd()} ` : "";
  let finalText = "";
  recognition = new SpeechRecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";
  /** @param {any} event */
  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    answer.value = base + finalText + interim;
    updateCounter();
  };
  /** @param {any} event */
  recognition.onerror = (event) => {
    if (event.error !== "no-speech" && event.error !== "aborted")
      toast(`Dictation stopped: ${event.error}`);
    stopListening();
  };
  recognition.onend = () => stopListening();
  recognition.start();
  $("mic-btn").setAttribute("aria-pressed", "true");
  $("mic-btn").textContent = "■ Stop";
}

function stopListening() {
  if (!recognition) return;
  const r = recognition;
  recognition = null;
  r.onend = null;
  try {
    r.stop();
  } catch {
    /* already stopped */
  }
  $("mic-btn").setAttribute("aria-pressed", "false");
  $("mic-btn").textContent = "🎙 Dictate";
}

route();

export {};
