// ─────────────────────────────────────────────────────────────────────────────
// Lokaal — Agent Swarm live demo server (Microsoft Build AI Hackathon)
//
// A small, self-contained Node HTTP server that drives the project's real
// 4-agent swarm (Planner → Researcher → Executor → Critic) and the
// continuous-chat AI assistant against real Azure AI Foundry inference + real
// Supabase/Foursquare data, streaming every agent step to the browser over SSE.
//
// Security model (so no unwanted access can be made):
//   • A login (microsoft / microsoft) is checked server-side with a constant-
//     time compare. The same credential is also visible in the client JS (an
//     intentional, shared demo credential) — but it is the SERVER that enforces
//     it. A successful login mints an HMAC-signed, expiring session token.
//   • EVERY /api/* route except /api/login requires a valid token. Without one
//     you get 401 — the swarm, the assistant, and the demo user are unreachable.
//   • Static files are served only from demo/public with path-traversal guards.
//   • No CORS headers are emitted → browsers block cross-origin API calls.
//   • Failed logins are rate-limited per IP.
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from "dotenv";
dotenv.config();

import http from "node:http";
import { createHmac, randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const PORT = Number(process.env.DEMO_PORT) || 4505;
const HOST = process.env.DEMO_HOST || "0.0.0.0";

// Demo credential. Intentionally simple + shared; the server still enforces it.
const DEMO_USER = process.env.DEMO_LOGIN_USER || "microsoft";
const DEMO_PASS = process.env.DEMO_LOGIN_PASS || "microsoft";

// Session token signing secret. Persisted to disk so server restarts don't
// invalidate already-issued tokens (which would bounce a logged-in user back to
// the login screen). Pin explicitly with DEMO_SESSION_SECRET to share across
// instances.
function loadOrCreateSecret(): string {
  if (process.env.DEMO_SESSION_SECRET) return process.env.DEMO_SESSION_SECRET;
  const f = path.join(__dirname, ".session_secret");
  try {
    const existing = readFileSync(f, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* not created yet */
  }
  const s = randomBytes(32).toString("hex");
  try {
    writeFileSync(f, s, { mode: 0o600 });
  } catch {
    /* read-only fs (e.g. container) — fall back to in-memory secret */
  }
  return s;
}
const SESSION_SECRET = loadOrCreateSecret();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// ─── Lazy library imports (after dotenv so config.ts sees the env) ────────────

type Libs = {
  runSwarm: typeof import("../lib/agentSwarm.js").runSwarm;
  SwarmAbortError: typeof import("../lib/agentSwarm.js").SwarmAbortError;
  chatWithAssistant: typeof import("../lib/aiClient.js").chatWithAssistant;
  findAcceptedConnections: typeof import("../lib/connectionContext.js").findAcceptedConnections;
  searchNearbyPlaces: typeof import("../lib/foursquareClient.js").searchNearbyPlaces;
  supabase: typeof import("../lib/supabase.js").supabase;
  config: typeof import("../config.js").config;
  cellToLatLngSafe: typeof import("../shared/h3.js").cellToLatLngSafe;
  agentLLMClient: typeof import("../lib/azureClient.js").agentLLMClient;
};

let libs: Libs;
async function loadLibs(): Promise<Libs> {
  if (libs) return libs;
  const [swarm, ai, conn, fsq, sb, cfg, h3, az] = await Promise.all([
    import("../lib/agentSwarm.js"),
    import("../lib/aiClient.js"),
    import("../lib/connectionContext.js"),
    import("../lib/foursquareClient.js"),
    import("../lib/supabase.js"),
    import("../config.js"),
    import("../shared/h3.js"),
    import("../lib/azureClient.js"),
  ]);
  libs = {
    runSwarm: swarm.runSwarm,
    SwarmAbortError: swarm.SwarmAbortError,
    chatWithAssistant: ai.chatWithAssistant,
    findAcceptedConnections: conn.findAcceptedConnections,
    searchNearbyPlaces: fsq.searchNearbyPlaces,
    supabase: sb.supabase,
    config: cfg.config,
    cellToLatLngSafe: h3.cellToLatLngSafe,
    agentLLMClient: az.agentLLMClient,
  };
  return libs;
}

// ─── Auth: HMAC-signed session tokens ─────────────────────────────────────────

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signSession(): string {
  const payload = b64url(Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, jti: randomUUID() })));
  const sig = b64url(createHmac("sha256", SESSION_SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}

function verifySession(token: string | null | undefined): boolean {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = b64url(createHmac("sha256", SESSION_SECRET).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    return typeof data.exp === "number" && data.exp > Date.now();
  } catch {
    return false;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still burn a compare to avoid a length-based timing signal.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function checkCredentials(username: unknown, password: unknown): boolean {
  if (typeof username !== "string" || typeof password !== "string") return false;
  // Evaluate both halves regardless of the first result (no short-circuit).
  const u = constantTimeEqual(username, DEMO_USER);
  const p = constantTimeEqual(password, DEMO_PASS);
  return u && p;
}

// Per-IP failed-login throttle.
const loginAttempts = new Map<string, { count: number; first: number }>();
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX = 8;
function loginRateLimited(ip: string): boolean {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now - rec.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 0, first: now });
    return false;
  }
  return rec.count >= LOGIN_MAX;
}
function recordLoginFailure(ip: string): void {
  const rec = loginAttempts.get(ip);
  if (rec) rec.count += 1;
}

function bearer(req: http.IncomingMessage): string | null {
  const h = req.headers["authorization"];
  if (typeof h === "string" && h.startsWith("Bearer ")) return h.slice(7).trim();
  // EventSource cannot set headers, so SSE GETs may pass the token as a query.
  const url = new URL(req.url || "/", "http://localhost");
  return url.searchParams.get("token");
}

function isAuthed(req: http.IncomingMessage): boolean {
  return verifySession(bearer(req));
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", ...SECURITY_HEADERS });
  res.end(body);
}

function clientIp(req: http.IncomingMessage): string {
  return req.socket.remoteAddress || "unknown";
}

async function readJsonBody(req: http.IncomingMessage, limitBytes = 16_384): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

// SSE framing helpers.
function sseInit(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...SECURITY_HEADERS,
  });
  // Initial comment flushes headers through any proxy.
  res.write(": connected\n\n");
}
function sseSend(res: http.ServerResponse, obj: unknown): void {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// ─── Demo user selection (server-side; never leaves first name) ───────────────

type DemoUser = {
  id: string;
  firstName: string;
  bio: string | null;
  interests: string[];
  coords: { lat: number; lng: number } | null;
};
let cachedDemoUser: DemoUser | null = null;

type UserRow = {
  id: string;
  first_name: string | null;
  bio: string | null;
  interests: string[] | null;
  h3_cell: string | null;
};

function toDemoUser(u: UserRow, cellToLatLngSafe: Libs["cellToLatLngSafe"]): DemoUser {
  return {
    id: u.id,
    firstName: (u.first_name ?? "there").trim() || "there",
    bio: u.bio ?? null,
    interests: Array.isArray(u.interests) ? u.interests : [],
    coords: u.h3_cell ? cellToLatLngSafe(u.h3_cell) : null,
  };
}

async function getDemoUser(): Promise<DemoUser> {
  if (cachedDemoUser) return cachedDemoUser;
  const { supabase, cellToLatLngSafe, searchNearbyPlaces, config } = await loadLibs();

  // Explicit pin always wins.
  const pinnedId = process.env.DEMO_USER_ID;
  if (pinnedId) {
    const { data } = await supabase
      .from("users")
      .select("id, first_name, bio, interests, h3_cell")
      .eq("id", pinnedId)
      .limit(1);
    const row = ((data ?? []) as UserRow[])[0];
    if (row) {
      cachedDemoUser = toDemoUser(row, cellToLatLngSafe);
      console.log(`  Demo user pinned via DEMO_USER_ID → ${cachedDemoUser.firstName}`);
      return cachedDemoUser;
    }
    console.warn("  DEMO_USER_ID set but not found; falling back to auto-select.");
  }

  const { data: conns } = await supabase
    .from("connections")
    .select("requester_id, addressee_id")
    .eq("status", "accepted");

  const degree = new Map<string, number>();
  for (const c of (conns ?? []) as Array<{ requester_id: string; addressee_id: string }>) {
    for (const id of [c.requester_id, c.addressee_id]) degree.set(id, (degree.get(id) ?? 0) + 1);
  }

  const ids = [...degree.keys()];
  let scored: UserRow[] = [];
  if (ids.length > 0) {
    const { data: users } = await supabase
      .from("users")
      .select("id, first_name, bio, interests, h3_cell")
      .in("id", ids);
    scored = ((users ?? []) as UserRow[])
      .map((u) => ({
        u,
        score:
          (degree.get(u.id) ?? 0) * 10 +
          ((u.interests ?? []).length > 0 ? 5 : 0) +
          (u.h3_cell ? 3 : 0),
      }))
      .sort((a, b) => b.score - a.score)
      .map((s) => s.u);
  }

  // Prefer the well-connected user whose location has the DENSEST venue
  // coverage, so the meetup swarm (which searches midpoints between the user and
  // each connection) has real venues to ground on. Resolution-4 H3 centroids can
  // land in venue-sparse areas, so we probe Foursquare for the top candidates
  // (cheap, one-time, cached) and pick the maximum-coverage one.
  let chosen: UserRow | null = scored[0] ?? null;
  if (config.foursquareApiKey && scored.length > 0) {
    let best: { u: UserRow; venues: number } | null = null;
    await Promise.all(
      scored.slice(0, 12).map(async (u) => {
        if (!u.h3_cell) return;
        const coords = cellToLatLngSafe(u.h3_cell);
        if (!coords) return;
        try {
          const places = await searchNearbyPlaces(config.foursquareApiKey, coords.lat, coords.lng, "restaurant", 8000);
          if (!best || places.length > best.venues) best = { u, venues: places.length };
        } catch {
          /* ignore probe failure */
        }
      })
    );
    if (best && (best as { venues: number }).venues > 0) {
      chosen = (best as { u: UserRow }).u;
      console.log(
        `  Demo user auto-selected by venue density → ${((best as { u: UserRow }).u.first_name ?? "user").trim()} (${(best as { venues: number }).venues} nearby venues)`
      );
    } else {
      console.warn("  No connected user has Foursquare venue coverage; meetup suggestions may be sparse.");
    }
  }

  if (!chosen) {
    const { data: anyUsers } = await supabase
      .from("users")
      .select("id, first_name, bio, interests, h3_cell")
      .limit(1);
    chosen = ((anyUsers ?? []) as UserRow[])[0] ?? null;
  }
  if (!chosen) throw new Error("No demo user available in Supabase");

  cachedDemoUser = toDemoUser(chosen, cellToLatLngSafe);
  return cachedDemoUser;
}

// ─── Active runs (for explicit Stop) ──────────────────────────────────────────

const activeRuns = new Map<string, AbortController>();

// ─── Assistant sessions (in-memory; isolated from prod assistant_messages) ────

type ChatTurn = { role: "user" | "assistant"; content: string };
type Session = { history: ChatTurn[]; remembered: unknown[] };
const sessions = new Map<string, Session>();
function sessionFor(token: string): Session {
  const key = createHash("sha256").update(token).digest("hex");
  let s = sessions.get(key);
  if (!s) {
    s = { history: [], remembered: [] };
    sessions.set(key, s);
  }
  return s;
}
function resetSession(token: string): void {
  const key = createHash("sha256").update(token).digest("hex");
  sessions.set(key, { history: [], remembered: [] });
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleLogin(req: http.ServerResponse, request: http.IncomingMessage): Promise<void> {
  const ip = clientIp(request);
  if (loginRateLimited(ip)) {
    return sendJson(req, 429, { success: false, error: "too_many_attempts" });
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return sendJson(req, 400, { success: false, error: "invalid_request" });
  }
  if (!checkCredentials(body.username, body.password)) {
    recordLoginFailure(ip);
    return sendJson(req, 401, { success: false, error: "invalid_credentials" });
  }
  return sendJson(req, 200, { success: true, token: signSession(), expiresInMs: SESSION_TTL_MS });
}

async function handleSession(res: http.ServerResponse): Promise<void> {
  try {
    const { agentLLMClient, config } = await loadLibs();
    const user = await getDemoUser();
    sendJson(res, 200, {
      success: true,
      user: { firstName: user.firstName, interestCount: user.interests.length, hasLocation: !!user.coords },
      provider: agentLLMClient.provider,
      deployment: config.azureOpenAIDeployment,
    });
  } catch (err) {
    sendJson(res, 500, { success: false, error: String(err) });
  }
}

async function handleSwarmStream(
  res: http.ServerResponse,
  request: http.IncomingMessage,
  taskType: "meetup" | "connections"
): Promise<void> {
  const { runSwarm, SwarmAbortError, config, agentLLMClient } = await loadLibs();
  sseInit(res);
  const streamId = randomUUID();
  const controller = new AbortController();
  activeRuns.set(streamId, controller);

  request.on("close", () => {
    controller.abort();
    activeRuns.delete(streamId);
  });

  sseSend(res, { type: "run_started", streamId, taskType });

  try {
    const user = await getDemoUser();
    sseSend(res, {
      type: "agent",
      agent: "planner",
      message: `Demo user "${user.firstName}" · LLM provider=${agentLLMClient.provider} (${config.azureOpenAIDeployment})`,
    });
    await runSwarm({
      userId: user.id,
      taskType,
      foursquareApiKey: config.foursquareApiKey,
      hooks: {
        emit: (e) => sseSend(res, e),
        signal: controller.signal,
      },
    });
  } catch (err) {
    if (!(err instanceof SwarmAbortError)) {
      sseSend(res, { type: "error", message: String(err) });
    }
  } finally {
    activeRuns.delete(streamId);
    sseSend(res, { type: "done" });
    if (!res.writableEnded) res.end();
  }
}

async function handleStop(res: http.ServerResponse, request: http.IncomingMessage): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return sendJson(res, 400, { success: false, error: "invalid_request" });
  }
  const streamId = typeof body.streamId === "string" ? body.streamId : "";
  const controller = activeRuns.get(streamId);
  if (controller) {
    controller.abort();
    activeRuns.delete(streamId);
    return sendJson(res, 200, { success: true, stopped: true });
  }
  return sendJson(res, 200, { success: true, stopped: false });
}

async function handleAssistantStream(res: http.ServerResponse, request: http.IncomingMessage): Promise<void> {
  const { chatWithAssistant, findAcceptedConnections, supabase, config, agentLLMClient } = await loadLibs();
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return sendJson(res, 400, { success: false, error: "invalid_request" });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > 500) {
    return sendJson(res, 400, { success: false, error: "invalid_message" });
  }
  const token = bearer(request)!; // guaranteed by auth gate
  const session = sessionFor(token);

  sseInit(res);
  request.on("close", () => {
    if (!res.writableEnded) res.end();
  });

  try {
    const user = await getDemoUser();
    sseSend(res, { type: "user_echo", text: message });
    sseSend(res, {
      type: "agent",
      agent: "planner",
      message: `Assistant turn · provider=${agentLLMClient.provider} (${config.azureOpenAIDeployment})`,
    });

    const userContext = {
      firstName: user.firstName,
      bio: user.bio,
      interests: user.interests,
      language: "en",
      coords: user.coords,
    };

    const { reply, cards, rememberedConnections } = await chatWithAssistant(
      session.history,
      message,
      userContext,
      config.foursquareApiKey,
      null,
      {
        rememberedConnections: session.remembered as never,
        resolveConnections: (ref) => findAcceptedConnections(supabase, user.id, ref),
      },
      (step) => {
        if (step.type === "card") sseSend(res, { type: "card", card: step.card });
        else if (step.type === "token") sseSend(res, { type: "reply_delta", delta: step.delta });
        else sseSend(res, { type: "agent", agent: step.agent, message: step.message });
      }
    );

    session.history.push({ role: "user", content: message }, { role: "assistant", content: reply });
    if (session.history.length > 20) session.history = session.history.slice(-20);
    session.remembered = rememberedConnections;

    sseSend(res, { type: "reply", text: reply, cards });
  } catch (err) {
    sseSend(res, { type: "error", message: String(err) });
  } finally {
    sseSend(res, { type: "done" });
    if (!res.writableEnded) res.end();
  }
}

async function handleAssistantReset(res: http.ServerResponse, request: http.IncomingMessage): Promise<void> {
  const token = bearer(request)!;
  resetSession(token);
  sendJson(res, 200, { success: true });
}

// ─── Static file serving (path-traversal safe) ────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".json": "application/json",
};

async function serveStatic(res: http.ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.replace(/^\/+/, ""));
  const resolved = path.resolve(PUBLIC_DIR, rel);
  // Containment check — block traversal outside PUBLIC_DIR.
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain", ...SECURITY_HEADERS });
    res.end("Forbidden");
    return;
  }
  try {
    const data = await readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      // Always serve the freshest demo assets (avoids stale cached HTML/JS/CSS).
      "Cache-Control": "no-store, must-revalidate",
      ...SECURITY_HEADERS,
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain", ...SECURITY_HEADERS });
    res.end("Not found");
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;

    // Public auth endpoint.
    if (pathname === "/api/login" && method === "POST") {
      return await handleLogin(res, req);
    }

    // All other /api/* routes require a valid session token.
    if (pathname.startsWith("/api/")) {
      if (!isAuthed(req)) {
        return sendJson(res, 401, { success: false, error: "unauthorized" });
      }
      if (pathname === "/api/session" && method === "GET") return await handleSession(res);
      if (pathname === "/api/swarm/connections/stream" && method === "GET")
        return await handleSwarmStream(res, req, "connections");
      if (pathname === "/api/swarm/meetup/stream" && method === "GET")
        return await handleSwarmStream(res, req, "meetup");
      if (pathname === "/api/swarm/stop" && method === "POST") return await handleStop(res, req);
      if (pathname === "/api/assistant/stream" && method === "POST")
        return await handleAssistantStream(res, req);
      if (pathname === "/api/assistant/reset" && method === "POST")
        return await handleAssistantReset(res, req);
      return sendJson(res, 404, { success: false, error: "not_found" });
    }

    // Static assets (login page + SPA).
    if (method === "GET" || method === "HEAD") {
      return await serveStatic(res, pathname);
    }

    sendJson(res, 405, { success: false, error: "method_not_allowed" });
  } catch (err) {
    sendJson(res, 500, { success: false, error: String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Lokaal swarm demo → http://localhost:${PORT}`);
  console.log(`  Login: ${DEMO_USER} / ${DEMO_PASS}  (enforced server-side)`);
  console.log(`  Binding ${HOST}:${PORT} — expose via tunnel/reverse-proxy for a live link.\n`);
});
