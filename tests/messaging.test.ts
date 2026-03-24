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
  verifyParticipantResult: { isParticipant: boolean; isBlocked: boolean; conversation: ConversationRow | null; error: Error | null };
  insertMessageResult: { message: MessageRow | null; error: Error | null };
  messagesResult: { messages: MessageRow[]; error: Error | null };
  publishCalled: boolean;
  publishResult: boolean;
  wsToken: string;
} = {
  userId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  otherUserId: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
  conversationId: "c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f",
  connectionRow: null,
  connectionError: null,
  conversations: [],
  conversationsError: null,
  findOrCreateResult: { conversation: null, error: null, created: false },
  verifyParticipantResult: { isParticipant: false, isBlocked: false, conversation: null, error: null },
  insertMessageResult: { message: null, error: null },
  messagesResult: { messages: [], error: null },
  publishCalled: false,
  publishResult: true,
  wsToken: "mock-ws-token",
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
  scenario.verifyParticipantResult = { isParticipant: false, isBlocked: false, conversation: null, error: null };
  scenario.insertMessageResult = { message: null, error: null };
  scenario.messagesResult = { messages: [], error: null };
  scenario.publishCalled = false;
  scenario.publishResult = true;
  scenario.wsToken = "mock-ws-token";
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
  signWsToken: () => scenario.wsToken,
  verifyWsToken: (token) => {
    if (token === scenario.wsToken) {
      return { sub: scenario.userId, type: "ws", iat: 0, exp: 0 };
    }
    throw new AuthError("Invalid token");
  },
  AuthError,
  findConnectionBetweenUsers: async () => ({
    row: scenario.connectionRow,
    error: scenario.connectionError,
  }),
  isPairBlocked: (row) => {
    if (!row) return false;
    return row.status === "blocked" || !!row.requester_blocked || !!row.addressee_blocked;
  },
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

function makeConnection(status: string, overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8091",
    requester_id: scenario.userId,
    addressee_id: scenario.otherUserId,
    status: status as ConnectionRow["status"],
    requester_blocked: false,
    addressee_blocked: false,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  resetScenario();
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /messaging/ws-token
// ═══════════════════════════════════════════════════════════════════════════════

test("WS Token: success", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/messaging/ws-token",
    headers: { authorization: "Bearer test" },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.success, true);
  assert.equal(body.token, scenario.wsToken);
  await app.close();
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
  assert.equal(body.conversation.otherUserId, scenario.otherUserId);
  await app.close();
});

test("Create conversation: 403 - user is blocked", async () => {
  scenario.connectionRow = makeConnection("blocked");

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

test("Create conversation: 403 - user is soft blocked", async () => {
  scenario.connectionRow = makeConnection("accepted", { requester_blocked: true });

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

// ═══════════════════════════════════════════════════════════════════════════════
// GET /messaging/conversations/:id/messages
// ═══════════════════════════════════════════════════════════════════════════════

test("Get messages: returns messages", async () => {
  const conv = makeConversation();
  scenario.verifyParticipantResult = { isParticipant: true, isBlocked: false, conversation: conv, error: null };
  scenario.messagesResult = { messages: [], error: null };

  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: `/messaging/conversations/${scenario.conversationId}/messages`,
    headers: { authorization: "Bearer test" },
  });

  assert.equal(res.statusCode, 200);
  await app.close();
});

test("Get messages: 403 - blocked", async () => {
  const conv = makeConversation();
  scenario.verifyParticipantResult = { isParticipant: true, isBlocked: true, conversation: conv, error: null };

  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: `/messaging/conversations/${scenario.conversationId}/messages`,
    headers: { authorization: "Bearer test" },
  });

  assert.equal(res.statusCode, 403);
  await app.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Unit tests for lib/messaging.ts pure functions
// ═══════════════════════════════════════════════════════════════════════════════

test("getConversationParticipants: orders canonically", async () => {
  const { getConversationParticipants } = await import("../lib/messaging.js");
  const a = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
  const b = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";

  const result1 = getConversationParticipants(a, b);
  assert.equal(result1.participantOne, a < b ? a : b);
  assert.equal(result1.participantTwo, a < b ? b : a);
});
