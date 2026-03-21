import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { MessagingRouteDeps } from "../routes/messaging.js";
import type { ConversationRow, MessageRow } from "../lib/messaging.js";
import type { ConnectionRow } from "../lib/connections.js";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "test-key";

// ─── Scenario State ───────────────────────────────────────────────────────────

const scenario: {
  userId: string;
  otherUserId: string;
  conversationId: string;
  connectionRow: ConnectionRow | null;
  connectionError: Error | null;
  conversations: ConversationRow[];
  conversationsError: unknown;
  findOrCreateResult: { conversation: ConversationRow | null; error: Error | null; created: boolean };
  verifyParticipantResult: { isParticipant: boolean; conversation: ConversationRow | null; error: Error | null };
  insertMessageResult: { message: MessageRow | null; error: Error | null };
  messagesResult: { messages: MessageRow[]; error: Error | null };
  publishCalled: boolean;
  publishResult: boolean;
} = {
  userId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  otherUserId: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
  conversationId: "c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f",
  connectionRow: null,
  connectionError: null,
  conversations: [],
  conversationsError: null,
  findOrCreateResult: { conversation: null, error: null, created: false },
  verifyParticipantResult: { isParticipant: false, conversation: null, error: null },
  insertMessageResult: { message: null, error: null },
  messagesResult: { messages: [], error: null },
  publishCalled: false,
  publishResult: true,
};

function resetScenario() {
  scenario.userId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
  scenario.otherUserId = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
  scenario.conversationId = "c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f";
  scenario.connectionRow = null;
  scenario.connectionError = null;
  scenario.conversations = [];
  scenario.conversationsError = null;
  scenario.findOrCreateResult = { conversation: null, error: null, created: false };
  scenario.verifyParticipantResult = { isParticipant: false, conversation: null, error: null };
  scenario.insertMessageResult = { message: null, error: null };
  scenario.messagesResult = { messages: [], error: null };
  scenario.publishCalled = false;
  scenario.publishResult = true;
}

// ─── Stubs ────────────────────────────────────────────────────────────────────

class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

const supabaseStub = {
  from(table: string) {
    if (table === "conversations") {
      return {
        select() {
          return {
            or() {
              return {
                async order() {
                  return { data: scenario.conversations, error: scenario.conversationsError };
                },
              };
            },
          };
        },
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  },
};

const deps: Partial<MessagingRouteDeps> = {
  supabase: supabaseStub as unknown as MessagingRouteDeps["supabase"],
  verifyAccessToken: () => ({
    sub: scenario.userId,
    phone: "",
    type: "access" as const,
    iat: 0,
    exp: 0,
  }),
  AuthError,
  findConnectionBetweenUsers: async () => ({
    row: scenario.connectionRow,
    error: scenario.connectionError,
  }),
  findOrCreateConversation: async () => scenario.findOrCreateResult,
  insertMessage: async () => scenario.insertMessageResult,
  getConversationMessages: async () => scenario.messagesResult,
  verifyConversationParticipant: async () => scenario.verifyParticipantResult,
  getOtherParticipant: (conv, currentUserId) => {
    if (conv.participant_one === currentUserId) return conv.participant_two;
    if (conv.participant_two === currentUserId) return conv.participant_one;
    return null;
  },
  publishNewMessage: async () => {
    scenario.publishCalled = true;
    return scenario.publishResult;
  },
  redisSet: async () => {},
  redisDel: async () => {},
  redisGet: async () => null,
};

async function buildApp() {
  const app = Fastify({ logger: false });
  const { createMessagingRoutes } = await import("../routes/messaging.js");
  await app.register(createMessagingRoutes(deps));
  await app.ready();
  return app;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConversation(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: scenario.conversationId,
    participant_one: scenario.userId < scenario.otherUserId ? scenario.userId : scenario.otherUserId,
    participant_two: scenario.userId < scenario.otherUserId ? scenario.otherUserId : scenario.userId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMessage(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "d4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f80",
    conversation_id: scenario.conversationId,
    sender_id: scenario.userId,
    content: "Hello!",
    attachment_url: null,
    attachment_type: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeConnection(status: string): ConnectionRow {
  return {
    id: "e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8091",
    requester_id: scenario.userId,
    addressee_id: scenario.otherUserId,
    status: status as ConnectionRow["status"],
    requester_blocked: false,
    addressee_blocked: false,
    updated_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  resetScenario();
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /messaging/conversations
// ═══════════════════════════════════════════════════════════════════════════════

test("Create conversation: success - new conversation created", async () => {
  const conv = makeConversation();
  scenario.connectionRow = makeConnection("accepted");
  scenario.findOrCreateResult = { conversation: conv, error: null, created: true };

  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/messaging/conversations",
    headers: { authorization: "Bearer test" },
    payload: { otherUserId: scenario.otherUserId },
  });

  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.success, true);
  assert.equal(body.conversation.id, scenario.conversationId);
  await app.close();
});

test("Create conversation: success - existing conversation returned", async () => {
  const conv = makeConversation();
  scenario.connectionRow = makeConnection("accepted");
  scenario.findOrCreateResult = { conversation: conv, error: null, created: false };

  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/messaging/conversations",
    headers: { authorization: "Bearer test" },
    payload: { otherUserId: scenario.otherUserId },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.success, true);
  await app.close();
});

test("Create conversation: 400 - cannot message yourself", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/messaging/conversations",
    headers: { authorization: "Bearer test" },
    payload: { otherUserId: scenario.userId },
  });

  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.success, false);
  await app.close();
});

test("Create conversation: 400 - invalid UUID", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/messaging/conversations",
    headers: { authorization: "Bearer test" },
    payload: { otherUserId: "not-a-uuid" },
  });

  assert.equal(res.statusCode, 400);
  await app.close();
});

test("Create conversation: 403 - users not connected", async () => {
  scenario.connectionRow = null;

  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/messaging/conversations",
    headers: { authorization: "Bearer test" },
    payload: { otherUserId: scenario.otherUserId },
  });

  assert.equal(res.statusCode, 403);
  const body = res.json();
  assert.equal(body.success, false);
  await app.close();
});

test("Create conversation: 403 - connection pending", async () => {
  scenario.connectionRow = makeConnection("pending");

  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/messaging/conversations",
    headers: { authorization: "Bearer test" },
    payload: { otherUserId: scenario.otherUserId },
  });

  assert.equal(res.statusCode, 403);
  await app.close();
});

test("Create conversation: 500 - connection check DB error", async () => {
  scenario.connectionError = new Error("DB error");

  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/messaging/conversations",
    headers: { authorization: "Bearer test" },
    payload: { otherUserId: scenario.otherUserId },
  });

  assert.equal(res.statusCode, 500);
  await app.close();
});

test("Create conversation: 500 - findOrCreate error", async () => {
  scenario.connectionRow = makeConnection("accepted");
  scenario.findOrCreateResult = { conversation: null, error: new Error("DB error"), created: false };

  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/messaging/conversations",
    headers: { authorization: "Bearer test" },
    payload: { otherUserId: scenario.otherUserId },
  });

  assert.equal(res.statusCode, 500);
  await app.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /messaging/conversations
// ═══════════════════════════════════════════════════════════════════════════════

test("List conversations: returns conversations", async () => {
  const conv = makeConversation();
  scenario.conversations = [conv];

  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/messaging/conversations",
    headers: { authorization: "Bearer test" },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.success, true);
  assert.equal(body.conversations.length, 1);
  assert.equal(body.conversations[0].id, scenario.conversationId);
  await app.close();
});

test("List conversations: empty list", async () => {
  scenario.conversations = [];

  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/messaging/conversations",
    headers: { authorization: "Bearer test" },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.success, true);
  assert.equal(body.conversations.length, 0);
  await app.close();
});

test("List conversations: 500 - DB error", async () => {
  scenario.conversationsError = { message: "DB error" };

  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/messaging/conversations",
    headers: { authorization: "Bearer test" },
  });

  assert.equal(res.statusCode, 500);
  await app.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /messaging/conversations/:id/messages
// ═══════════════════════════════════════════════════════════════════════════════

test("Get messages: returns messages with pagination", async () => {
  const conv = makeConversation();
  const msg1 = makeMessage({ id: "msg-1", content: "Hello" });
  const msg2 = makeMessage({ id: "msg-2", content: "World" });
  scenario.verifyParticipantResult = { isParticipant: true, conversation: conv, error: null };
  scenario.messagesResult = { messages: [msg1, msg2], error: null };

  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: `/messaging/conversations/${scenario.conversationId}/messages?limit=20`,
    headers: { authorization: "Bearer test" },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.success, true);
  assert.equal(body.messages.length, 2);
  assert.equal(body.nextCursor, null); // less than limit so no next page
  await app.close();
});

test("Get messages: 403 - not a participant", async () => {
  scenario.verifyParticipantResult = { isParticipant: false, conversation: null, error: null };

  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: `/messaging/conversations/${scenario.conversationId}/messages?limit=20`,
    headers: { authorization: "Bearer test" },
  });

  assert.equal(res.statusCode, 403);
  const body = res.json();
  assert.equal(body.success, false);
  await app.close();
});

test("Get messages: 500 - verify participant DB error", async () => {
  scenario.verifyParticipantResult = { isParticipant: false, conversation: null, error: new Error("DB error") };

  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: `/messaging/conversations/${scenario.conversationId}/messages?limit=20`,
    headers: { authorization: "Bearer test" },
  });

  assert.equal(res.statusCode, 500);
  await app.close();
});

test("Get messages: 500 - messages fetch error", async () => {
  const conv = makeConversation();
  scenario.verifyParticipantResult = { isParticipant: true, conversation: conv, error: null };
  scenario.messagesResult = { messages: [], error: new Error("DB error") };

  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: `/messaging/conversations/${scenario.conversationId}/messages?limit=20`,
    headers: { authorization: "Bearer test" },
  });

  assert.equal(res.statusCode, 500);
  await app.close();
});

test("Get messages: empty conversation", async () => {
  const conv = makeConversation();
  scenario.verifyParticipantResult = { isParticipant: true, conversation: conv, error: null };
  scenario.messagesResult = { messages: [], error: null };

  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: `/messaging/conversations/${scenario.conversationId}/messages`,
    headers: { authorization: "Bearer test" },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.success, true);
  assert.equal(body.messages.length, 0);
  assert.equal(body.nextCursor, null);
  await app.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Unit tests for lib/messaging.ts pure functions
// ═══════════════════════════════════════════════════════════════════════════════

test("getConversationParticipants: orders canonically (smaller first)", async () => {
  const { getConversationParticipants } = await import("../lib/messaging.js");
  const a = "aaaaaaaa-0000-0000-0000-000000000001";
  const b = "bbbbbbbb-0000-0000-0000-000000000002";

  const result1 = getConversationParticipants(a, b);
  assert.equal(result1.participantOne, a);
  assert.equal(result1.participantTwo, b);

  const result2 = getConversationParticipants(b, a);
  assert.equal(result2.participantOne, a);
  assert.equal(result2.participantTwo, b);
});

test("getOtherParticipant: returns correct participant", async () => {
  const { getOtherParticipant } = await import("../lib/messaging.js");
  const conv = { participant_one: "user-a", participant_two: "user-b" };

  assert.equal(getOtherParticipant(conv, "user-a"), "user-b");
  assert.equal(getOtherParticipant(conv, "user-b"), "user-a");
  assert.equal(getOtherParticipant(conv, "user-c"), null);
});
