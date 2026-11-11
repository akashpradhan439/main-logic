import { test } from "node:test";
import assert from "node:assert/strict";
import { initCrypto, generateDHKeyPair, generateSignKeyPair, generatePQKeyPair, sign, memzero } from "../shared/cryptography.js";
import { initiateHandshake, respondToHandshake, DoubleRatchet } from "../shared/e2ee.js";
import { encodeEnvelope } from "../shared/types.js";

async function setupRatchets() {
  await initCrypto();
  const bobIK = generateSignKeyPair();
  const bobSPK = generateDHKeyPair();
  const bobPQSPK = generatePQKeyPair();
  const bobBundle = {
    identityKey: bobIK.publicKey,
    signedPrekey: bobSPK.publicKey,
    pqSignedPrekey: bobPQSPK.publicKey,
    signature: sign(bobSPK.publicKey, bobIK.privateKey),
    pqSignature: sign(bobPQSPK.publicKey, bobIK.privateKey),
  };
  const aliceIK = generateSignKeyPair();

  const aliceHandshake = await initiateHandshake(aliceIK, bobBundle);
  const bobSecret = await respondToHandshake(bobIK, bobSPK, null, bobPQSPK, null, aliceIK.publicKey, aliceHandshake.ephemeralKey, aliceHandshake.pqCiphertext);

  const alice = await DoubleRatchet.initiate(aliceHandshake.sharedSecret, bobSPK.publicKey);
  const bob = await DoubleRatchet.respond(bobSecret, bobSPK);
  return { alice, bob };
}

test("Messaging Edge Cases", async (t) => {
  await t.test("Responder encrypting before receiving first message throws clear error", async () => {
    const { bob } = await setupRatchets();
    await assert.rejects(bob.encrypt(new Uint8Array([1])), /Cannot encrypt/);
  });

  await t.test("Replay attack: same message sent twice", async () => {
    const { alice, bob } = await setupRatchets();
    const env = await alice.encrypt(new Uint8Array([1]));
    await bob.decrypt(env); // First time succeeds
    await assert.rejects(bob.decrypt(env), /replayed/i); // Second time should fail or be handled gracefully
  });

  await t.test("Max skip limit: sending more than MAX_SKIP messages at once without response", async () => {
    const { alice, bob } = await setupRatchets();
    // This is valid on Alice's side
    let env: any;
    for (let i = 0; i <= 1001; i++) {
        env = await alice.encrypt(new Uint8Array([i % 256]));
    }
    // Bob receives message 1001. Should throw Too many skipped messages.
    await assert.rejects(bob.decrypt(env), /Too many skipped messages|Too many/);
  });

  await t.test("Expired skipped keys: message arrives after TTL", async () => {
    const { alice, bob } = await setupRatchets();
    const m1 = await alice.encrypt(new Uint8Array([1]));
    const m2 = await alice.encrypt(new Uint8Array([2]));
    await bob.decrypt(m2); // skips m1

    // forcefully expire skipped keys
    const bobState = (bob as any).state;
    for (const v of bobState.MKSKIPPED.values()) {
        v.addedAt = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
    }

    // Now receive m1
    await assert.rejects(bob.decrypt(m1), /replayed or expired/i); // Or whatever error MAC validation gives
  });
});
