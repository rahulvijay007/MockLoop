import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import type { SessionConfig, TranscriptMessage, WeakArea } from "../../src/domain";
import type { SessionState } from "../../src/session/InterviewSession";

export const ORIGIN = "https://mockloop.test";

export const technicalConfig: SessionConfig = {
  role: "Backend Engineer",
  seniority: "senior",
  type: "technical",
};

export function newUserId(): string {
  return crypto.randomUUID();
}

function randomIp(): string {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return `10.${String(b[1])}.${String(b[2])}.${String(b[3])}`;
}

export async function api(path: string, userId: string | null, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (userId) headers.set("x-mockloop-user", userId);
  // Each test gets its own client IP so the per-IP session rate limit does not
  // couple unrelated tests (the limiter itself is exercised explicitly).
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", randomIp());
  return exports.default.fetch(`${ORIGIN}${path}`, { ...init, headers });
}

export async function createSession(
  userId: string,
  config: SessionConfig = technicalConfig,
): Promise<{ sessionId: string; focusAreas: WeakArea[] }> {
  const res = await api("/api/sessions", userId, { method: "POST", body: JSON.stringify(config) });
  expect(res.status).toBe(201);
  return res.json();
}

// Loose by design: tests assert on the fields they care about.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Frame = Record<string, any> & { type: string };

/** A test WebSocket client that records every frame and lets tests await specific ones. */
export class TestSocket {
  readonly frames: Frame[] = [];
  closeCode: number | null = null;
  private waiters: { from: number; pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] =
    [];
  private closeWaiters: ((code: number) => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const frame = JSON.parse(String(e.data)) as Frame;
      this.frames.push(frame);
      const index = this.frames.length - 1;
      this.waiters = this.waiters.filter((w) => {
        if (index >= w.from && w.pred(frame)) {
          w.resolve(frame);
          return false;
        }
        return true;
      });
    });
    ws.addEventListener("close", (e) => {
      this.closeCode = e.code;
      for (const r of this.closeWaiters) r(e.code);
    });
  }

  /** Current position in the frame log; pass to `next()` to only match later frames. */
  get mark(): number {
    return this.frames.length;
  }

  next(pred: (f: Frame) => boolean, from = 0, timeoutMs = 5000): Promise<Frame> {
    const existing = this.frames.slice(from).find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `timed out waiting for frame; got: ${this.frames.map((f) => f.type).join(",")}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({
        from,
        pred,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  nextType(type: string, from = 0): Promise<Frame> {
    return this.next((f) => f.type === type, from);
  }

  /** Wait until a synced Agent state matches. */
  async state(pred: (s: SessionState) => boolean, from = 0): Promise<SessionState> {
    const f = await this.next(
      (x) => x.type === "cf_agent_state" && pred(x.state as SessionState),
      from,
    );
    return f.state as SessionState;
  }

  closed(): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((r) => this.closeWaiters.push(r));
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Send an answer and wait for the interviewer's complete reply. */
  async answer(text: string): Promise<{ reply: Frame; end: Frame }> {
    const from = this.mark;
    this.send({ type: "answer", text });
    const start = await this.next((f) => f.type === "message_start", from);
    const end = await this.next((f) => f.type === "message_end" && f.seq === start.seq, from);
    return { reply: start, end };
  }

  close(): void {
    this.ws.close(1000, "test done");
  }
}

export async function connect(sessionId: string, userId: string): Promise<TestSocket> {
  const res = await exports.default.fetch(
    `${ORIGIN}/agents/interview-session/${sessionId}?uid=${userId}`,
    { headers: { Upgrade: "websocket" } },
  );
  const ws = res.webSocket;
  if (!ws) throw new Error(`expected a WebSocket upgrade, got HTTP ${res.status}`);
  ws.accept();
  return new TestSocket(ws);
}

/** Connect and wait for the opening question to finish streaming. */
export async function startInterview(userId = newUserId(), config = technicalConfig) {
  const { sessionId, focusAreas } = await createSession(userId, config);
  const socket = await connect(sessionId, userId);
  const start = await socket.nextType("message_start");
  await socket.next((f) => f.type === "message_end" && f.seq === start.seq);
  return { sessionId, userId, socket, focusAreas };
}

/** Reconnect and return the snapshot the server sends. */
export async function snapshot(sessionId: string, userId: string): Promise<TranscriptMessage[]> {
  const s = await connect(sessionId, userId);
  const snap = await s.nextType("snapshot");
  s.close();
  return snap.messages as TranscriptMessage[];
}
