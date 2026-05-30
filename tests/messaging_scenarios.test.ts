// Server-side simulation of the key messaging scenarios:
//   1. A starts a conversation with B before B has uploaded a key bundle.
//   2. B's bundle is present but stale (legacy pq_signature sentinel).
//   3. A sends a message while B is OFFLINE (no SSE) -> RabbitMQ/APNs fallback.
//   4. A sends a message while B is ONLINE (live SSE) -> delivered over SSE, no fallback.
//   5. B reconnects with a cursor -> SSE replays PENDING messages first, in order,
//      before any newly-arriving live message.
//
// These exercise the REAL route handlers (routes/keys.ts, routes/messaging.ts,
// routes/sse.ts), the REAL lib/keys.getPrekeyBundle, and the REAL in-process SSE
// manager. Only the database is faked.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "test-key";

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import type { ConversationRow, MessageRow } from "../lib/messaging.js";

class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

// ─── SSE stream parser (copied minimal form from sse.test.ts) ───────────────────

type SseEvent = { event: string; data: any; id?: string };

function parseSseStream(res: http.IncomingMessage) {
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
      let parsed: any = data;
      try { parsed = JSON.parse(data); } catch { /* keep string */ }
      const ev: SseEvent = { event, data: parsed };
      if (id) ev.id = id;
      if (waiters.length > 0) waiters.shift()!(ev);
      else queue.push(ev);
    }
  });

  return {
    next(timeoutMs = 3000): Promise<SseEvent> {
      return new Promise((resolve, reject) => {
        if (queue.length > 0) { resolve(queue.shift()!); return; }
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) { settled = true; reject(new Error("SSE timeout")); }
        }, timeoutMs);
        waiters.push((e) => { if (!settled) { settled = true; clearTimeout(timer); resolve(e); } });
      });
    },
    close() { res.destroy(); },
  };
}

function connectSse(port: number, token: string, cursor?: string) {
  const path = cursor
    ? `/messaging/stream?cursor=${encodeURIComponent(cursor)}`
    : `/messaging/stream`;
  return new Promise<ReturnType<typeof parseSseStream>>((resolve, reject) => {
    const req = http.get(
      `http://127.0.0.1:${port}${path}`,
      { headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
        resolve(parseSseStream(res));
      },
    );
    req.on("error", reject);
  });
}

// ─── In-memory message store ────────────────────────────────────────────────────

interface StoredMsg extends MessageRow {}

function makeConversation(a: string, b: string): ConversationRow {
  const [p1, p2] = a < b ? [a, b] : [b, a];
  return {
    id: randomUUID(),
    participant_one: p1,
    participant_two: p2,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    initiator_user_id: null,
  };
}

const noopLog = { info() {}, error() {}, warn() {} } as any;

function makeEnvelope(n = 0) {
  return {
    header: { dhPublicKey: Buffer.from([1, 2, 3]).toString("base64"), n, pn: 0 },
    ciphertext: Buffer.from([4, 5, 6, n]).toString("base64"),
  };
}

// ─── App factory wiring real routes to the in-memory store ──────────────────────

async function buildApp(senderId: string, recipientId: string) {
  const { createSseRoutes } = await import("../routes/sse.js");
  const { createMessagingRoutes } = await import("../routes/messaging.js");

  const conv = makeConversation(senderId, recipientId);
  const store: StoredMsg[] = [];
  let seq = 0;
  let initiatorUserId: string | null = null; // canonical initiator (first sender wins)
  const publishCalls: string[] = [];

  const tokenToUser = (header?: string): string => {
    if (header?.includes("sender-token")) return senderId;
    if (header?.includes("recipient-token")) return recipientId;
    throw new AuthError("Unauthorized", 401);
  };

  const app = Fastify({ logger: false });
  app.decorateRequest("t", null as any);
  app.addHook("onRequest", async (req) => { req.t = ((k: string) => k) as any; });

  await app.register(createSseRoutes({
    verifyAccessToken: (h) => ({ sub: tokenToUser(h), phone: "", type: "access" as const, iat: 0, exp: 0 }),
    AuthError,
    supabase: {} as any,
    // Real generator semantics: yield messages strictly after the cursor, ASC.
    getMessagesSinceCursor: async function* (_sb, userId, cursor) {
      const pending = store
        .filter((m) => m.created_at > cursor && (conv.participant_one === userId || conv.participant_two === userId))
        .sort((x, y) => x.created_at.localeCompare(y.created_at));
      if (pending.length) yield pending;
    },
  }));

  // Minimal supabase stub: only the user_prekeys lookup the C4 sender-identity
  // check performs when a bootstrap is present.
  const supabaseStub = {
    from(table: string) {
      if (table === "user_prekeys") {
        return {
          select: () => ({
            eq: () => ({
              async maybeSingle() {
                return { data: { identity_key_public: SENDER_IK_B64 }, error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as any;

  await app.register(createMessagingRoutes({
    supabase: supabaseStub,
    verifyAccessToken: (h) => ({ sub: tokenToUser(h), phone: "", type: "access" as const, iat: 0, exp: 0 }),
    AuthError,
    findConnectionBetweenUsers: async () => ({ row: null, error: null }),
    isPairBlocked: () => false,
    findOrCreateConversation: async () => ({ conversation: conv, error: null, created: false }),
    insertMessage: async (_sb, conversationId, sId, envelope, attUrl, attType, bootstrapJson) => {
      // Monotonic ISO timestamps so ordering is deterministic in fast tests.
      const created = new Date(Date.now() + seq++).toISOString();
      const row: StoredMsg = {
        id: randomUUID(),
        conversation_id: conversationId,
        sender_id: sId,
        envelope: Buffer.from(JSON.stringify(envelope)),
        attachment_url: attUrl,
        attachment_type: attType,
        created_at: created,
        bootstrap_json: bootstrapJson,
      };
      store.push(row);
      if (initiatorUserId === null) initiatorUserId = sId; // first sender wins
      return { message: row, initiatorUserId, error: null };
    },
    getConversationMessages: async (_sb, _cid, cursor, limit) => {
      let msgs = [...store].sort((a, b) => b.created_at.localeCompare(a.created_at));
      if (cursor) msgs = msgs.filter((m) => m.created_at < cursor);
      return { messages: msgs.slice(0, limit), error: null };
    },
    getConversationBootstrap: async () => {
      const withBoot = [...store]
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .find((m) => m.bootstrap_json);
      return {
        bootstrap: withBoot?.bootstrap_json ?? null,
        senderId: withBoot?.sender_id ?? null,
        error: null,
      };
    },
    verifyConversationParticipant: async () => ({ isParticipant: true, isBlocked: false, conversation: conv, error: null }),
    getOtherParticipant: (c, cur) =>
      c.participant_one === cur ? c.participant_two : c.participant_one === undefined ? null : c.participant_two === cur ? c.participant_one : (c.participant_one === cur ? c.participant_two : c.participant_two === cur ? c.participant_one : null),
    publishNewMessage: async (event) => { publishCalls.push(event.messageId); return true; },
    usersWithUsableBundles: async () => new Set<string>(),
  }));

  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  return { app, port, conv, store, publishCalls };
}

async function sendMessage(app: any, convId: string, n = 0) {
  return app.inject({
    method: "POST",
    url: `/messaging/conversations/${convId}/messages`,
    headers: { authorization: "Bearer sender-token" },
    payload: { envelope: makeEnvelope(n) },
  });
}

const SENDER_IK_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

function makeBootstrap() {
  return {
    senderIdentityKey: SENDER_IK_B64,
    senderEphemeralKey: Buffer.from(new Uint8Array(32).fill(8)).toString("base64"),
    pqCiphertext: Buffer.from(new Uint8Array(1088).fill(9)).toString("base64"),
    signedPrekeyId: 1,
    pqSignedPrekeyId: 1,
  };
}

async function sendBootstrapMessage(app: any, convId: string, n = 0) {
  return app.inject({
    method: "POST",
    url: `/messaging/conversations/${convId}/messages`,
    headers: { authorization: "Bearer sender-token" },
    payload: { envelope: { ...makeEnvelope(n), bootstrap: makeBootstrap() } },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 1 & 2: key bundle availability (real lib/keys.getPrekeyBundle)
// ═══════════════════════════════════════════════════════════════════════════════

test("Scenario 1: A fetches B's bundle before B has uploaded -> not found", async () => {
  const { getPrekeyBundle } = await import("../lib/keys.js");

  const fakeSupabase = {
    from(table: string) {
      assert.equal(table, "user_prekeys");
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: null, error: { message: "no rows" } }),
          }),
        }),
      };
    },
  } as any;

  const { bundle, error } = await getPrekeyBundle(fakeSupabase, randomUUID());
  assert.equal(bundle, null);
  assert.ok(error, "should surface an error when the target has no prekeys");
});

test("Scenario 2: stale bundle (pq_signature sentinel) -> re-upload signal", async () => {
  const { getPrekeyBundle } = await import("../lib/keys.js");

  const fakeSupabase = {
    from() {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                identity_key_public: "ik",
                identity_signing_key_public: "isk",
                signed_prekey_public: "spk",
                signed_prekey_id: 1,
                pq_signed_prekey_public: "pqspk",
                pq_signed_prekey_id: 1,
                signature: "sig",
                pq_signature: "", // legacy sentinel
              },
              error: null,
            }),
          }),
        }),
      };
    },
  } as any;

  const { bundle, error } = await getPrekeyBundle(fakeSupabase, randomUUID());
  assert.equal(bundle, null);
  assert.ok(error instanceof Error && error.message.startsWith("PREKEY_BUNDLE_STALE"));
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 3: recipient OFFLINE -> RabbitMQ/APNs fallback
// ═══════════════════════════════════════════════════════════════════════════════

test("Scenario 3: send to OFFLINE recipient falls back to publishNewMessage", async () => {
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const { app, conv, publishCalls } = await buildApp(senderId, recipientId);
  try {
    const res = await sendMessage(app, conv.id, 0);
    assert.equal(res.statusCode, 201);
    assert.equal(publishCalls.length, 1, "offline recipient must trigger fallback publish");
  } finally {
    await app.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 4: recipient ONLINE (live SSE) -> delivered over SSE, no fallback
// ═══════════════════════════════════════════════════════════════════════════════

test("Scenario 4: send to ONLINE recipient delivers via SSE, no fallback publish", async () => {
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const { app, port, conv, publishCalls } = await buildApp(senderId, recipientId);
  try {
    const stream = await connectSse(port, "recipient-token");
    assert.equal((await stream.next()).event, "connected");

    const res = await sendMessage(app, conv.id, 0);
    assert.equal(res.statusCode, 201);

    const ev = await stream.next();
    assert.equal(ev.event, "message");
    assert.equal(ev.data.type, "new_message");
    assert.equal(ev.data.senderId, senderId);
    assert.equal(publishCalls.length, 0, "live SSE delivery must NOT fall back to publish");
    stream.close();
  } finally {
    await app.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 5: reconnect with cursor -> pending messages replayed first, in order,
// before any live message that arrives during/after catch-up.
// ═══════════════════════════════════════════════════════════════════════════════

test("Scenario 5: SSE catch-up replays pending messages first, in order", async () => {
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const { app, port, conv, store } = await buildApp(senderId, recipientId);
  try {
    // Recipient was offline: three messages accumulate.
    await sendMessage(app, conv.id, 1);
    await sendMessage(app, conv.id, 2);
    await sendMessage(app, conv.id, 3);
    assert.equal(store.length, 3);

    const cursorBeforeAll = new Date(0).toISOString();

    // Recipient reconnects with a cursor at the beginning of time.
    const stream = await connectSse(port, "recipient-token", cursorBeforeAll);
    assert.equal((await stream.next()).event, "connected");

    // The three pending messages must arrive first, oldest -> newest.
    const e1 = await stream.next();
    const e2 = await stream.next();
    const e3 = await stream.next();
    assert.equal(e1.data.messageId, store[0]!.id);
    assert.equal(e2.data.messageId, store[1]!.id);
    assert.equal(e3.data.messageId, store[2]!.id);

    stream.close();
  } finally {
    await app.close();
  }
});

test("Scenario 5b: a message sent during catch-up is delivered after pending ones", async () => {
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const { app, port, conv, store } = await buildApp(senderId, recipientId);
  try {
    await sendMessage(app, conv.id, 1);
    await sendMessage(app, conv.id, 2);
    const pendingIds = store.map((m) => m.id);

    const stream = await connectSse(port, "recipient-token", new Date(0).toISOString());
    assert.equal((await stream.next()).event, "connected");

    // While the recipient is catching up / live, sender sends a new message.
    await sendMessage(app, conv.id, 3);

    const got: string[] = [];
    got.push((await stream.next()).data.messageId);
    got.push((await stream.next()).data.messageId);
    got.push((await stream.next()).data.messageId);

    // First two must be the pending ones (in order); the live one comes last.
    assert.deepEqual(got.slice(0, 2), pendingIds);
    assert.equal(got[2], store[2]!.id);
    stream.close();
  } finally {
    await app.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bug 1 — role-conflict deadlock: server exposes a canonical initiator so both
// clients can deterministically pick initiator vs responder.
// ═══════════════════════════════════════════════════════════════════════════════

test("Bug1: send response carries the canonical initiatorUserId (first sender)", async () => {
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const { app, conv } = await buildApp(senderId, recipientId);
  try {
    const res = await sendMessage(app, conv.id, 0);
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.initiatorUserId, senderId);
    assert.equal(body.message.initiatorUserId, senderId);
  } finally {
    await app.close();
  }
});

test("Bug1: live SSE event carries initiatorUserId so the recipient can pick responder role", async () => {
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const { app, port, conv } = await buildApp(senderId, recipientId);
  try {
    const stream = await connectSse(port, "recipient-token");
    assert.equal((await stream.next()).event, "connected");

    await sendMessage(app, conv.id, 0);

    const ev = await stream.next();
    assert.equal(ev.event, "message");
    // The recipient (B) sees the first sender (A) as initiator → B must be responder.
    assert.equal(ev.data.initiatorUserId, senderId);
    assert.notEqual(ev.data.initiatorUserId, recipientId);
    stream.close();
  } finally {
    await app.close();
  }
});

test("Bug1: insertMessage records first sender as canonical initiator (set-once tie-breaker)", async () => {
  const { insertMessage } = await import("../lib/messaging.js");

  const userA = randomUUID();
  const userB = randomUUID();
  const conversationId = randomUUID();

  // Minimal in-memory Supabase fake for the conversations + messages tables.
  const convRow: { id: string; initiator_user_id: string | null; updated_at: string | null } = {
    id: conversationId,
    initiator_user_id: null,
    updated_at: null,
  };

  const fakeSupabase = {
    from(table: string) {
      if (table === "messages") {
        return {
          insert(values: any) {
            return {
              select() {
                return {
                  async single() {
                    return {
                      data: {
                        id: randomUUID(),
                        conversation_id: values.conversation_id,
                        sender_id: values.sender_id,
                        envelope: values.envelope,
                        attachment_url: values.attachment_url ?? null,
                        attachment_type: values.attachment_type ?? null,
                        created_at: new Date().toISOString(),
                        bootstrap_json: values.bootstrap_json ?? null,
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "conversations") {
        return {
          update(patch: any) {
            return {
              eq() {
                // `.is(...)` => set-once guarded update (initiator_user_id).
                // awaited directly => unguarded update (updated_at bump).
                return {
                  is(_col: string, _val: null) {
                    if (convRow.initiator_user_id === null && patch.initiator_user_id !== undefined) {
                      convRow.initiator_user_id = patch.initiator_user_id;
                    }
                    return Promise.resolve({ error: null });
                  },
                  then(resolve: (v: { error: null }) => void) {
                    if (patch.updated_at !== undefined) convRow.updated_at = patch.updated_at;
                    resolve({ error: null });
                  },
                };
              },
            };
          },
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    return { data: { initiator_user_id: convRow.initiator_user_id }, error: null };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as any;

  const env = { header: { dhPublicKey: new Uint8Array([1, 2, 3]), n: 0, pn: 0 }, ciphertext: new Uint8Array([4, 5, 6]) };

  // A sends first → becomes the canonical initiator.
  const r1 = await insertMessage(fakeSupabase, conversationId, userA, env as any, null, null, null, noopLog);
  assert.equal(r1.initiatorUserId, userA);

  // B sends later → must NOT overwrite the initiator; both see A.
  const r2 = await insertMessage(fakeSupabase, conversationId, userB, env as any, null, null, null, noopLog);
  assert.equal(r2.initiatorUserId, userA, "second sender must not steal the initiator role");
  assert.equal(convRow.initiator_user_id, userA);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bug 2 — bootstrap retrievable independent of message-history pagination.
// ═══════════════════════════════════════════════════════════════════════════════

test("Bug2: GET /bootstrap returns the handshake even after the n=0 message scrolls past the page", async () => {
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const { app, conv } = await buildApp(senderId, recipientId);
  try {
    // First (bootstrap) message, then many plain ones — far more than any page.
    const first = await sendBootstrapMessage(app, conv.id, 0);
    assert.equal(first.statusCode, 201);
    for (let i = 1; i <= 60; i++) {
      const r = await sendMessage(app, conv.id, i);
      assert.equal(r.statusCode, 201);
    }

    const res = await app.inject({
      method: "GET",
      url: `/messaging/conversations/${conv.id}/bootstrap`,
      headers: { authorization: "Bearer recipient-token" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.bootstrap.senderIdentityKey, SENDER_IK_B64);
    assert.equal(body.senderId, senderId);
    assert.equal(body.initiatorUserId, senderId);
  } finally {
    await app.close();
  }
});

test("Bug2: GET /bootstrap returns 404 when no bootstrap exists yet", async () => {
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const { app, conv } = await buildApp(senderId, recipientId);
  try {
    await sendMessage(app, conv.id, 0); // plain message, no bootstrap
    const res = await app.inject({
      method: "GET",
      url: `/messaging/conversations/${conv.id}/bootstrap`,
      headers: { authorization: "Bearer recipient-token" },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("Bug2: getConversationBootstrap picks the EARLIEST bootstrap-bearing message", async () => {
  const { getConversationBootstrap } = await import("../lib/messaging.js");

  let capturedAscending: boolean | undefined;
  let capturedNotNull = false;
  const fakeSupabase = {
    from(table: string) {
      assert.equal(table, "messages");
      return {
        select() {
          return {
            eq() {
              return {
                not(_col: string, _op: string, _val: null) {
                  capturedNotNull = true;
                  return {
                    order(_col2: string, opts: { ascending: boolean }) {
                      capturedAscending = opts.ascending;
                      return {
                        limit() {
                          return {
                            async maybeSingle() {
                              return {
                                data: {
                                  sender_id: "user-A",
                                  bootstrap_json: { senderIdentityKey: "ik", senderEphemeralKey: "ek", pqCiphertext: "ct", signedPrekeyId: 1, pqSignedPrekeyId: 1 },
                                  created_at: "2026-01-01T00:00:00.000Z",
                                },
                                error: null,
                              };
                            },
                          };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as any;

  const { bootstrap, senderId, error } = await getConversationBootstrap(fakeSupabase, randomUUID());
  assert.equal(error, null);
  assert.equal(senderId, "user-A");
  assert.equal((bootstrap as any).senderIdentityKey, "ik");
  assert.equal(capturedAscending, true, "must order ascending to get the earliest");
  assert.ok(capturedNotNull, "must filter to bootstrap_json IS NOT NULL");
});

// ═══════════════════════════════════════════════════════════════════════════════
// #6 — SSE catch-up uses keyset pagination (no offset skip/dup across batches),
// including messages that "arrive" between batches.
// ═══════════════════════════════════════════════════════════════════════════════

test("#6: getMessagesSinceCursor keyset-paginates without skips or duplicates", async () => {
  const { getMessagesSinceCursor } = await import("../lib/messaging.js");

  // created_at strings sort lexicographically the same as chronologically here.
  const all = [
    { id: "m1", conversation_id: "c1", sender_id: "s", envelope: Buffer.from("a").toString("base64"), attachment_url: null, attachment_type: null, created_at: "2026-01-01T00:00:01.000Z", bootstrap_json: null },
    { id: "m2", conversation_id: "c1", sender_id: "s", envelope: Buffer.from("b").toString("base64"), attachment_url: null, attachment_type: null, created_at: "2026-01-01T00:00:02.000Z", bootstrap_json: null },
    { id: "m3", conversation_id: "c1", sender_id: "s", envelope: Buffer.from("c").toString("base64"), attachment_url: null, attachment_type: null, created_at: "2026-01-01T00:00:03.000Z", bootstrap_json: null },
    { id: "m4", conversation_id: "c1", sender_id: "s", envelope: Buffer.from("d").toString("base64"), attachment_url: null, attachment_type: null, created_at: "2026-01-01T00:00:04.000Z", bootstrap_json: null },
    { id: "m5", conversation_id: "c1", sender_id: "s", envelope: Buffer.from("e").toString("base64"), attachment_url: null, attachment_type: null, created_at: "2026-01-01T00:00:05.000Z", bootstrap_json: null },
  ];

  const fakeSupabase = {
    from(table: string) {
      if (table === "conversations") {
        return { select: () => ({ or: async () => ({ data: [{ id: "c1" }], error: null }) }) };
      }
      // messages: builder capturing the gt() bound, resolving on limit().
      let gtVal = "";
      const builder: any = {
        select: () => builder,
        in: () => builder,
        gt: (_c: string, v: string) => { gtVal = v; return builder; },
        order: () => builder,
        limit: (n: number) => Promise.resolve({
          data: all.filter((m) => m.created_at > gtVal)
                   .sort((a, b) => a.created_at.localeCompare(b.created_at))
                   .slice(0, n),
          error: null,
        }),
      };
      return builder;
    },
  } as any;

  const seen: string[] = [];
  // batchSize 2 → forces 3 batches over 5 rows.
  for await (const batch of getMessagesSinceCursor(fakeSupabase, randomUUID(), "2026-01-01T00:00:00.000Z", 2)) {
    for (const m of batch) seen.push(m.id);
  }

  assert.deepEqual(seen, ["m1", "m2", "m3", "m4", "m5"], "all messages, in order, exactly once");
  assert.equal(new Set(seen).size, seen.length, "no duplicates");
});

// ═══════════════════════════════════════════════════════════════════════════════
// #12 — signalReady: only users with a usable bundle (identity key + non-sentinel
// pq_signature) are reported ready.
// ═══════════════════════════════════════════════════════════════════════════════

test("#12: usersWithUsableBundles excludes missing keys and sentinel pq_signature", async () => {
  const { usersWithUsableBundles } = await import("../lib/keys.js");

  const rows = [
    { user_id: "ready", identity_key_public: "ik", pq_signature: "sig" },
    { user_id: "stale", identity_key_public: "ik", pq_signature: "" },       // M7 sentinel
    { user_id: "noident", identity_key_public: null, pq_signature: "sig" },  // no identity key
    // "missing" is absent entirely from user_prekeys
  ];

  const fakeSupabase = {
    from(table: string) {
      assert.equal(table, "user_prekeys");
      return {
        select: () => ({
          in: async (_col: string, ids: string[]) => ({
            data: rows.filter((r) => ids.includes(r.user_id)),
            error: null,
          }),
        }),
      };
    },
  } as any;

  const ready = await usersWithUsableBundles(fakeSupabase, ["ready", "stale", "noident", "missing"]);
  assert.ok(ready.has("ready"));
  assert.ok(!ready.has("stale"));
  assert.ok(!ready.has("noident"));
  assert.ok(!ready.has("missing"));
  assert.equal(ready.size, 1);

  // empty input → no query, empty set
  const none = await usersWithUsableBundles(fakeSupabase, []);
  assert.equal(none.size, 0);
});
