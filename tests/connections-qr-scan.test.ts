import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { ConnectionRow } from "../lib/connections.js";
import type { ConnectionsRouteDeps } from "../routes/connections.js";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "test-key";

type UpdatePayload = Record<string, unknown> | null;

const scenario: {
  userId: string;
  targetUserId: string;
  existing: ConnectionRow | null;
  updateCalled: boolean;
  insertCalled: boolean;
  updatePayload: UpdatePayload;
  insertPayload: UpdatePayload;
  updateError: Error | null;
  insertError: Error | null;
  redisDelCalled: boolean;
} = {
  userId: "scanner-1",
  targetUserId: "target-1",
  existing: null,
  updateCalled: false,
  insertCalled: false,
  updatePayload: null,
  insertPayload: null,
  updateError: null,
  insertError: null,
  redisDelCalled: false,
};

function resetScenario() {
  scenario.userId = "scanner-1";
  scenario.targetUserId = "target-1";
  scenario.existing = null;
  scenario.updateCalled = false;
  scenario.insertCalled = false;
  scenario.updatePayload = null;
  scenario.insertPayload = null;
  scenario.updateError = null;
  scenario.insertError = null;
  scenario.redisDelCalled = false;
}

const supabaseStub = {
  from(table: string) {
    if (table === "users") {
      return {
        select() {
          return {
            eq() {
              return {
                async single() {
                  return { data: { id: scenario.targetUserId }, error: null };
                },
              };
            },
          };
        },
      };
    }

    if (table === "connections") {
      return {
        select() {
          return {
            or() {
              return {
                limit() {
                  return {
                    async maybeSingle() {
                      return { data: scenario.existing, error: null };
                    },
                  };
                },
              };
            },
          };
        },
        update(payload: Record<string, unknown>) {
          return {
            async eq() {
              scenario.updateCalled = true;
              scenario.updatePayload = payload as UpdatePayload;
              return { error: scenario.updateError };
            },
          };
        },
        async insert(payload: Record<string, unknown>) {
          scenario.insertCalled = true;
          scenario.insertPayload = payload as UpdatePayload;
          return { error: scenario.insertError };
        },
      };
    }

    throw new Error(`Unexpected table: ${table}`);
  },
};

class AuthError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

const deps: Partial<ConnectionsRouteDeps> = {
  supabase: supabaseStub as unknown as ConnectionsRouteDeps["supabase"],
  verifyAccessToken: () => ({
    sub: scenario.userId,
    phone: "",
    type: "access" as const,
    iat: 0,
    exp: 0,
  }),
  AuthError,
  parseEncryptedToken: () => ({
    iv: "iv",
    authTag: "tag",
    ciphertext: "cipher",
  }),
  decryptPayload: () => ({
    userId: scenario.targetUserId,
    nonce: "nonce",
    exp: Math.floor(Date.now() / 1000) + 120,
  }),
  encryptPayload: () => ({
    iv: "iv",
    authTag: "tag",
    ciphertext: "cipher",
  }),
  serializeEncryptedToken: () => "token",
  redisSet: async () => {},
  redisExists: async () => true,
  redisDel: async () => {
    scenario.redisDelCalled = true;
  },
};

async function buildApp() {
  const app = Fastify({ logger: false });
  const { createConnectionsRoutes } = await import("../routes/connections.js");
  await app.register(createConnectionsRoutes(deps));
  await app.ready();
  return app;
}

beforeEach(() => {
  resetScenario();
});

test("QR scan: rejected + scanner is addressee bypasses cooldown and accepts", async () => {
  const nowIso = new Date().toISOString();
  scenario.existing = {
    id: "conn-1",
    requester_id: scenario.targetUserId,
    addressee_id: scenario.userId,
    status: "rejected",
    requester_blocked: false,
    addressee_blocked: false,
    updated_at: nowIso,
  };

  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/connections/qr/scan",
    headers: { authorization: "Bearer test" },
    payload: { token: "token" },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(scenario.updateCalled, true);
  assert.equal(scenario.insertCalled, false);
  assert.ok(scenario.updatePayload);
  assert.equal(scenario.updatePayload.requester_id, scenario.userId);
  assert.equal(scenario.updatePayload.addressee_id, scenario.targetUserId);
  assert.equal(scenario.updatePayload.status, "accepted");
  await app.close();
});

test("QR scan: rejected + scanner is requester blocked by cooldown", async () => {
  scenario.existing = {
    id: "conn-2",
    requester_id: scenario.userId,
    addressee_id: scenario.targetUserId,
    status: "rejected",
    requester_blocked: false,
    addressee_blocked: false,
    updated_at: new Date().toISOString(),
  };

  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/connections/qr/scan",
    headers: { authorization: "Bearer test" },
    payload: { token: "token" },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(scenario.updateCalled, false);
  assert.equal(scenario.insertCalled, false);
  await app.close();
});

test("QR scan: rejected + scanner is requester after cooldown accepts", async () => {
  const pastIso = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  scenario.existing = {
    id: "conn-3",
    requester_id: scenario.userId,
    addressee_id: scenario.targetUserId,
    status: "rejected",
    requester_blocked: false,
    addressee_blocked: false,
    updated_at: pastIso,
  };

  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/connections/qr/scan",
    headers: { authorization: "Bearer test" },
    payload: { token: "token" },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(scenario.updateCalled, true);
  assert.equal(scenario.insertCalled, false);
  assert.ok(scenario.updatePayload);
  assert.equal(scenario.updatePayload.status, "accepted");
  await app.close();
});

test("QR scan: accepted returns conflict", async () => {
  scenario.existing = {
    id: "conn-4",
    requester_id: scenario.userId,
    addressee_id: scenario.targetUserId,
    status: "accepted",
    requester_blocked: false,
    addressee_blocked: false,
    updated_at: new Date().toISOString(),
  };

  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/connections/qr/scan",
    headers: { authorization: "Bearer test" },
    payload: { token: "token" },
  });

  assert.equal(res.statusCode, 409);
  assert.equal(scenario.updateCalled, false);
  assert.equal(scenario.insertCalled, false);
  await app.close();
});

test("QR scan: pending accepts existing connection", async () => {
  scenario.existing = {
    id: "conn-5",
    requester_id: scenario.targetUserId,
    addressee_id: scenario.userId,
    status: "pending",
    requester_blocked: false,
    addressee_blocked: false,
    updated_at: new Date().toISOString(),
  };

  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/connections/qr/scan",
    headers: { authorization: "Bearer test" },
    payload: { token: "token" },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(scenario.updateCalled, true);
  assert.equal(scenario.insertCalled, false);
  assert.ok(scenario.updatePayload);
  assert.equal(scenario.updatePayload.status, "accepted");
  await app.close();
});

test("QR scan: blocked returns forbidden", async () => {
  scenario.existing = {
    id: "conn-6",
    requester_id: scenario.userId,
    addressee_id: scenario.targetUserId,
    status: "blocked",
    requester_blocked: false,
    addressee_blocked: false,
    updated_at: new Date().toISOString(),
  };

  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/connections/qr/scan",
    headers: { authorization: "Bearer test" },
    payload: { token: "token" },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(scenario.updateCalled, false);
  assert.equal(scenario.insertCalled, false);
  await app.close();
});
