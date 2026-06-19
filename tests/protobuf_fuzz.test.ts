import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEnvelope, encodeEnvelope, type MessageEnvelope } from "../shared/types.js";

test("Protobuf Fuzz: Random bytes do not crash decodeEnvelope", async () => {
  const iterations = 1000;
  let crashCount = 0;

  for (let i = 0; i < iterations; i++) {
    const len = Math.floor(Math.random() * 512) + 1;
    const randomBytes = new Uint8Array(len);
    for (let j = 0; j < len; j++) {
      randomBytes[j] = Math.floor(Math.random() * 256);
    }

    try {
      decodeEnvelope(randomBytes);
    } catch (err) {
      // Should throw typed errors, not crash
      assert.ok(
        err instanceof Error,
        "decodeEnvelope must throw Error instances, not arbitrary values"
      );
      crashCount++;
    }
  }

  // Not all random bytes will be valid — that's expected
  // The key assertion is that no unhandled exceptions occurred
  console.log(`Fuzz test: ${iterations} random inputs, ${crashCount} threw errors (expected)`);
});

test("Protobuf Fuzz: Empty and edge-case inputs", async () => {
  const edgeCases = [
    new Uint8Array(0),
    new Uint8Array(1).fill(0),
    new Uint8Array(1).fill(0xff),
    new Uint8Array(2),
    new Uint8Array(32),
    new Uint8Array(64),
    new Uint8Array(128),
    new Uint8Array(256),
  ];

  for (const input of edgeCases) {
    try {
      decodeEnvelope(input);
    } catch (err) {
      assert.ok(err instanceof Error, "Edge case must throw Error instances");
    }
  }
});

test("Protobuf Round-trip: encode then decode preserves data", async () => {
  const envelope: MessageEnvelope = {
    header: {
      dhPublicKey: crypto.getRandomValues(new Uint8Array(32)),
      n: 42,
      pn: 10,
    },
    ciphertext: crypto.getRandomValues(new Uint8Array(64)),
  };

  const encoded = encodeEnvelope(envelope);
  const decoded = decodeEnvelope(encoded);

  assert.ok(Buffer.from(decoded.header.dhPublicKey).equals(Buffer.from(envelope.header.dhPublicKey)));
  assert.equal(decoded.header.n, envelope.header.n);
  assert.equal(decoded.header.pn, envelope.header.pn);
  assert.ok(Buffer.from(decoded.ciphertext).equals(Buffer.from(envelope.ciphertext)));
  assert.equal(decoded.bootstrap, undefined);
});

test("Protobuf Round-trip: envelope with bootstrap data (bootstrap NOT in protobuf)", async () => {
  const envelope: MessageEnvelope = {
    header: {
      dhPublicKey: crypto.getRandomValues(new Uint8Array(32)),
      n: 0,
      pn: 0,
    },
    ciphertext: crypto.getRandomValues(new Uint8Array(32)),
    bootstrap: {
      senderIdentityKey: crypto.getRandomValues(new Uint8Array(32)),
      senderEphemeralKey: crypto.getRandomValues(new Uint8Array(32)),
      pqCiphertext: crypto.getRandomValues(new Uint8Array(1088)),
      signedPrekeyId: 1,
      pqSignedPrekeyId: 2,
      oneTimePrekeyId: 3,
      pqOneTimePrekeyId: 4,
    },
  };

  // M8/#13: Bootstrap data is NOT encoded in protobuf — it's in bootstrap_json column.
  // encodeEnvelope should ignore the bootstrap field.
  const encoded = encodeEnvelope(envelope);
  const decoded = decodeEnvelope(encoded);

  assert.ok(Buffer.from(decoded.header.dhPublicKey).equals(Buffer.from(envelope.header.dhPublicKey)));
  assert.equal(decoded.header.n, 0);
  assert.equal(decoded.header.pn, 0);
  assert.ok(Buffer.from(decoded.ciphertext).equals(Buffer.from(envelope.ciphertext)));
  // Bootstrap should NOT be present in the decoded envelope
  assert.equal(decoded.bootstrap, undefined);
});

test("Protobuf Validation: rejects invalid key sizes", async () => {
  // Valid header but wrong dhPublicKey size
  const badHeader = encodeEnvelope({
    header: {
      dhPublicKey: new Uint8Array(16), // Wrong: should be 32
      n: 0,
      pn: 0,
    },
    ciphertext: new Uint8Array(32),
  });

  assert.throws(() => decodeEnvelope(badHeader), /dhPublicKey/);

  // Valid header but empty ciphertext
  const emptyCipher = encodeEnvelope({
    header: {
      dhPublicKey: new Uint8Array(32),
      n: 0,
      pn: 0,
    },
    ciphertext: new Uint8Array(0),
  });

  assert.throws(() => decodeEnvelope(emptyCipher), /ciphertext/);
});
