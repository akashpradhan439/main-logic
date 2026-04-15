process.env.SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-key";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { KeysRouteDeps } from "../routes/keys.js";

// ─── Scenario State ──────────────────────────────────────────────────────────

const scenario: {
  userId: string;
  otherUserId: string;
  prekeys: any;
  oneTimePrekeys: any[];
  authUserId: string;
} = {
  userId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  otherUserId: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
  prekeys: null,
  oneTimePrekeys: [],
  authUserId: "",
};

function resetScenario() {
  scenario.prekeys = null;
  scenario.oneTimePrekeys = [];
  scenario.authUserId = scenario.userId;
}

// ─── Stubs ──────────────────────────────────────────────────────────────────

class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

const deps: Partial<KeysRouteDeps> = {
  supabase: {} as any,
  verifyAccessToken: (auth: string | undefined) => {
    if (auth === "Bearer test") return { sub: scenario.authUserId } as any;
    throw new AuthError("Auth required");
  },
  uploadPrekeys: async (supabase: any, userId: string, bundle: any, oneTimePrekeys: any[]) => {
    scenario.userId = userId;
    scenario.prekeys = bundle;
    scenario.oneTimePrekeys.push(...oneTimePrekeys);
    return { error: null };
  },
  getPrekeyBundle: async (supabase: any, userId: string) => {
    if (userId !== scenario.userId && userId !== scenario.otherUserId) {
      return { bundle: null, error: new Error("Not found") };
    }
    return {
      bundle: {
        userId,
        identityKey: "id-key",
        signedPrekey: "spk",
        pqSignedPrekey: "pq-spk",
        signature: "sig",
        pqSignature: "pq-sig",
        oneTimePrekey: "opk",
        pqOneTimePrekey: "pq-opk",
      },
      error: null,
    };
  },
  AuthError,
};

async function buildApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest("t", null as any);
  app.addHook("onRequest", async (request) => {
    request.t = ((key: string) => key) as any;
  });
  const { createKeysRoutes } = await import("../routes/keys.js");
  await app.register(createKeysRoutes(deps));
  await app.ready();
  return app;
}

beforeEach(() => {
  resetScenario();
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /keys/upload
// ═══════════════════════════════════════════════════════════════════════════════

test("Keys/Upload: success", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/keys/upload",
    headers: { authorization: "Bearer test" },
    payload: {
      identityKey: "ik",
      signedPreKey: "spk",
      pqSignedPreKey: "pqspk",
      signedPreKeySignature: "sig",
      pqSignedPreKeySignature: "pqsig",
      oneTimePreKeys: ["opk1"],
      pqOneTimePreKeys: ["pqopk1"],
    },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().success, true);
  assert.equal(scenario.prekeys.identityKey, "ik");
  assert.equal(scenario.oneTimePrekeys.length, 1);
  await app.close();
});

test("Keys/Upload: 401 unauthorized", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/keys/upload",
    payload: {},
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /keys/bundle/:userId
// ═══════════════════════════════════════════════════════════════════════════════

test("Keys/Bundle: success", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: `/keys/bundle/${scenario.userId}`,
    headers: { authorization: "Bearer test" },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.success, true);
  assert.equal(body.bundle.identityKey, "id-key");
  await app.close();
});

test("Keys/Bundle: 404 not found", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/keys/bundle/non-existent-user",
    headers: { authorization: "Bearer test" },
  });

  assert.equal(res.statusCode, 404);
  await app.close();
});
