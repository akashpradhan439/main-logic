import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { ConnectionRow } from "../lib/connections.js";
import type { ConnectionsRouteDeps } from "../routes/connections.js";

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

const poolStub = {
  async query(sql: string, params?: unknown[]) {
    const sqlLower = sql.trim().toLowerCase();

    if (sqlLower.startsWith("select id from users")) {
      const targetId = params?.[0];
      if (targetId === scenario.targetUserId) {
        return { rows: [{ id: scenario.targetUserId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (sqlLower.startsWith("select") && sqlLower.includes("from connections")) {
      if (scenario.existing) {
        return { rows: [scenario.existing], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (sqlLower.startsWith("update connections")) {
      scenario.updateCalled = true;
      scenario.updatePayload = {};
      const cols = sql.match(/SET\s+(.*?)\s+WHERE/si)?.[1] || "";
      const setParts = cols.split(",").map((s) => s.trim());
      for (const part of setParts) {
        const col = part.split("=")[0].trim();
        const paramIdx = part.match(/\$(\d+)/)?.[1];
        if (paramIdx && params) {
          scenario.updatePayload[col] = params[parseInt(paramIdx) - 1];
        }
      }
      if (scenario.updateError) throw scenario.updateError;
      return { rows: [], rowCount: 1 };
    }

    if (sqlLower.startsWith("insert into connections")) {
      scenario.insertCalled = true;
      scenario.insertPayload = {};
      if (scenario.insertError) throw scenario.insertError;
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
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
  pool: poolStub as unknown as ConnectionsRouteDeps["pool"],
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
  app.decorateRequest("t", null as any);
  app.addHook("onRequest", async (request) => {
    request.t = ((key: string) => key) as any;
  });
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
