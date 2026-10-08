import { getAgentByName, routeAgentRequest } from "agents";
import { SessionConfigSchema, UserIdSchema } from "./domain";
import { MAX_BODY_BYTES, isRateLimited } from "./limits";
import { getReport, getWeakAreaProfile, listReports } from "./memory/profile";

export { InterviewSession } from "./session/InterviewSession";
export { EvaluationWorkflow } from "./workflow/EvaluationWorkflow";

/**
 * Single Worker entry. Static assets (the chat UI) are served by the assets
 * layer before this code runs; only /api/* and /agents/* reach it.
 *
 *   POST /api/sessions                    create a session (reads weak-area profile from D1)
 *   GET  /api/sessions/:id/report         finished report from D1
 *   GET  /api/profile                     weak areas + recent reports
 *   GET  /agents/interview-session/:id    WebSocket to the session Durable Object
 */

const USER_HEADER = "x-mockloop-user";
const SESSION_PATH = /^\/agents\/interview-session\/([0-9a-f-]{36})$/;
const REPORT_PATH = /^\/api\/sessions\/([0-9a-f-]{36})\/report$/;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/agents/")) {
        // Only well-formed session ids reach a Durable Object; everything else
        // is rejected here so random paths cannot instantiate new objects.
        if (!SESSION_PATH.test(url.pathname)) return json({ error: "not found" }, 404);
        return (await routeAgentRequest(request, env)) ?? json({ error: "not found" }, 404);
      }

      if (url.pathname === "/api/sessions" && request.method === "POST") {
        return await createSession(request, env);
      }

      const reportMatch = REPORT_PATH.exec(url.pathname);
      if (reportMatch?.[1] && request.method === "GET") {
        const userId = requireUser(request);
        if (!userId) return json({ error: "missing or invalid user id" }, 401);
        const report = await getReport(env.DB, userId, reportMatch[1]);
        return report ? json(report) : json({ error: "report not ready" }, 404);
      }

      if (url.pathname === "/api/profile" && request.method === "GET") {
        const userId = requireUser(request);
        if (!userId) return json({ error: "missing or invalid user id" }, 401);
        const [weakAreas, reports] = await Promise.all([
          getWeakAreaProfile(env.DB, userId),
          listReports(env.DB, userId),
        ]);
        return json({ weakAreas, reports });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error("unhandled error", err);
      return json({ error: "internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function createSession(request: Request, env: Env): Promise<Response> {
  const userId = requireUser(request);
  if (!userId) return json({ error: "missing or invalid user id" }, 401);

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (
    (await isRateLimited(env.SESSION_RATE_LIMITER, `user:${userId}`)) ||
    (await isRateLimited(env.SESSION_RATE_LIMITER, `ip:${ip}`))
  ) {
    return json({ error: "too many sessions, try again in a minute" }, 429);
  }

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return json({ error: "body too large" }, 413);
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "body too large" }, 413);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const parsed = SessionConfigSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      { error: "invalid session config", issues: parsed.error.issues.map((i) => i.message) },
      400,
    );
  }

  // Memory: the new interviewer reads this user's recurring weak areas.
  const focusAreas = await getWeakAreaProfile(env.DB, userId);
  const sessionId = crypto.randomUUID();
  const session = await getAgentByName(env.INTERVIEW_SESSION, sessionId);
  await session.init({ sessionId, userId, config: parsed.data, focusAreas });

  return json({ sessionId, focusAreas }, 201);
}

function requireUser(request: Request): string | null {
  const parsed = UserIdSchema.safeParse(request.headers.get(USER_HEADER));
  return parsed.success ? parsed.data : null;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
