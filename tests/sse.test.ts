import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import type { SseRouteDeps } from "../routes/sse.js";
import type { MessagingRouteDeps } from "../routes/messaging.js";
import type { ConversationRow, MessageRow } from "../lib/messaging.js";

class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "test-key";

// ─── SSE stream parser ────────────────────────────────────────────────────────

type SseEvent = { event: string; data: unknown; id?: string };

function parseSseStream(res: http.IncomingMessage): {
  next: (timeoutMs?: number) => Promise<SseEvent>;
  close: () => void;
} {
  let buf = "";
  const queue: SseEvent[] = [];
  const waiters: Array<(e: SseEvent) => void> = [];

  res.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!block.trim() || block.trimStart().startsWith(":")) continue;

      let event = "message";
      let data = "";
      let id: string | undefined;
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data = line.slice(5).trim();
        else if (line.startsWith("id:")) id = line.slice(3).trim();
      }

      let parsed: unknown = data;
      try { parsed = JSON.parse(data); } catch { /* keep as string */ }

      const ev: SseEvent = { event, data: parsed };
      if (id) ev.id = id;

      if (waiters.length > 0) {
        waiters.shift()!(ev);
      } else {
        queue.push(ev);
      }
    }
  });

  return {
    next(timeoutMs = 3000): Promise<SseEvent> {
      return new Promise((resolve, reject) => {
        if (queue.length > 0) { resolve(queue.shift()!); return; }
        let settled = false;
        const waiter = (e: SseEvent) => { if (!settled) { settled = true; resolve(e); } };
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            const i = waiters.indexOf(waiter);
            if (i !== -1) waiters.splice(i, 1);
            reject(new Error("SSE timeout: no event within " + timeoutMs + "ms"));
          }
        }, timeoutMs);
        waiters.push((e) => { clearTimeout(timer); waiter(e); });
      });
    },
    close() { res.destroy(); },
  };
}

// ─── SSE connection helper ────────────────────────────────────────────────────

function connectSse(
  port: number,
  token: string,
): Promise<ReturnType<typeof parseSseStream>> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `http://127.0.0.1:${port}/messaging/stream`,
      { headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE connect failed: HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        resolve(parseSseStream(res));
      },
    );
    req.on("error", reject);
  });
}

async function checkSseStatus(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `http://127.0.0.1:${port}/messaging/stream`,
      (res) => { resolve(res.statusCode ?? 0); res.resume(); },
    );
    req.on("error", reject);
  });
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeConversation(senderId: string, recipientId: string): ConversationRow {
  const [p1, p2] = senderId < recipientId
    ? [senderId, recipientId]
    : [recipientId, senderId];
  return {
    id: randomUUID(),
    participant_one: p1,
    participant_two: p2,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    initiator_user_id: null,
  };
}

function makeMessage(senderId: string, convId: string): MessageRow {
  return {
    id: randomUUID(),
    conversation_id: convId,
    sender_id: senderId,
    envelope: new Uint8Array([1, 2, 3, 4, 5]),
    attachment_url: null,
    attachment_type: null,
    created_at: new Date().toISOString(),
    bootstrap_json: null,
  };
}

// ─── App factory ─────────────────────────────────────────────────────────────

async function buildApp(
  senderId: string,
  recipientId: string,
  opts: {
    publishNewMessage?: (publishCalled: { value: boolean }) => MessagingRouteDeps["publishNewMessage"];
    sseDepsOverrides?: Partial<SseRouteDeps>;
  } = {},
): Promise<{ app: ReturnType<typeof Fastify>; port: number; publishCalled: { value: boolean } }> {
  const { createSseRoutes } = await import("../routes/sse.js");
  const { createMessagingRoutes } = await import("../routes/messaging.js");

  const publishCalled = { value: false };
  const conv = makeConversation(senderId, recipientId);
  const msg = makeMessage(senderId, conv.id);

  const app = Fastify({ logger: false });
  app.decorateRequest("t", null as any);
  app.addHook("onRequest", async (req) => { req.t = ((k: string) => k) as any; });

  await app.register(createSseRoutes({
    verifyAccessToken: (header) => {
      if (header?.includes("sender-token"))
        return { sub: senderId, phone: "", type: "access" as const, iat: 0, exp: 0 };
      if (header?.includes("recipient-token"))
        return { sub: recipientId, phone: "", type: "access" as const, iat: 0, exp: 0 };
      throw new AuthError("Unauthorized", 401);
    },
    AuthError,
    getMessagesSinceCursor: async function* () {},
    supabase: {} as any,
    ...opts.sseDepsOverrides,
  }));

  await app.register(createMessagingRoutes({
    supabase: {} as any,
    verifyAccessToken: () => ({ sub: senderId, phone: "", type: "access" as const, iat: 0, exp: 0 }),
    AuthError,
    findConnectionBetweenUsers: async () => ({ row: null, error: null }),
    isPairBlocked: () => false,
    findOrCreateConversation: async () => ({ conversation: conv, error: null, created: false }),
    insertMessage: async () => ({ message: msg, error: null }),
    getConversationMessages: async () => ({ messages: [], error: null }),
    verifyConversationParticipant: async () => ({
      isParticipant: true,
      isBlocked: false,
      conversation: conv,
      error: null,
    }),
    getOtherParticipant: (_conv, currentUserId) => {
      if (_conv.participant_one === currentUserId) return _conv.participant_two;
      if (_conv.participant_two === currentUserId) return _conv.participant_one;
      return null;
    },
    publishNewMessage: async () => {
      publishCalled.value = true;
      return true;
    },
  }));

  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  return { app, port, publishCalled };
}

function makeEnvelope() {
  return {
    header: { dhPublicKey: Buffer.alloc(32, 0x01).toString("base64"), n: 0, pn: 0 },
    ciphertext: Buffer.from([4, 5, 6]).toString("base64"),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

test("SSE: sends connected event on open", async () => {
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const { app, port } = await buildApp(senderId, recipientId);

  try {
    const stream = await connectSse(port, "recipient-token");
    const ev = await stream.next();
    assert.equal(ev.event, "connected");
    assert.deepEqual((ev.data as any).userId, recipientId);
    stream.close();
  } finally {
    await app.close();
  }
});

test("SSE: delivers message event in real-time to live recipient", async () => {
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const { app, port } = await buildApp(senderId, recipientId);

  try {
    const stream = await connectSse(port, "recipient-token");
    // consume the connected event
    await stream.next();

    // send a message as the sender
    const res = await app.inject({
      method: "POST",
      url: "/messaging/conversations/test-conv-id/messages",
      headers: { authorization: "Bearer sender-token" },
      payload: { envelope: makeEnvelope() },
    });
    assert.equal(res.statusCode, 201);

    const ev = await stream.next();
    assert.equal(ev.event, "message");
    const data = ev.data as any;
    assert.equal(data.type, "new_message");
    assert.equal(data.senderId, senderId);
    assert.ok(typeof data.messageId === "string");
    assert.ok(typeof data.envelope === "string"); // base64
    stream.close();
  } finally {
    await app.close();
  }
});

test("SSE: does not call publishNewMessage when SSE delivery succeeds", async () => {
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const { app, port, publishCalled } = await buildApp(senderId, recipientId);

  try {
    const stream = await connectSse(port, "recipient-token");
    await stream.next(); // consume connected

    await app.inject({
      method: "POST",
      url: "/messaging/conversations/test-conv-id/messages",
      headers: { authorization: "Bearer sender-token" },
      payload: { envelope: makeEnvelope() },
    });

    // drain the message event to ensure handler completed
    await stream.next();

    assert.equal(publishCalled.value, false);
    stream.close();
  } finally {
    await app.close();
  }
});

test("SSE: falls back to publishNewMessage when recipient has no SSE connection", async () => {
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const { app, publishCalled } = await buildApp(senderId, recipientId);

  try {
    // no SSE connection opened for recipient
    const res = await app.inject({
      method: "POST",
      url: "/messaging/conversations/test-conv-id/messages",
      headers: { authorization: "Bearer sender-token" },
      payload: { envelope: makeEnvelope() },
    });

    assert.equal(res.statusCode, 201);
    assert.equal(publishCalled.value, true);
  } finally {
    await app.close();
  }
});

test("SSE: rejects connection without Authorization header", async () => {
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const { app, port } = await buildApp(senderId, recipientId);

  try {
    const status = await checkSseStatus(port);
    assert.equal(status, 401);
  } finally {
    await app.close();
  }
});

test("SSE: dead stream causes fallback to publishNewMessage", async () => {
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const { app, port, publishCalled } = await buildApp(senderId, recipientId);

  try {
    const stream = await connectSse(port, "recipient-token");
    await stream.next(); // consume connected
    stream.close();     // destroy the socket

    // Give the server a moment to register the closed socket
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const res = await app.inject({
      method: "POST",
      url: "/messaging/conversations/test-conv-id/messages",
      headers: { authorization: "Bearer sender-token" },
      payload: { envelope: makeEnvelope() },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(publishCalled.value, true);
  } finally {
    await app.close();
  }
});
