import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initCrypto,
  generateDHKeyPair,
  generateSignKeyPair,
  generatePQKeyPair,
  sign,
  memzero,
} from "../shared/cryptography.js";
import {
  initiateHandshake,
  respondToHandshake,
  DoubleRatchet,
  type HandshakeBundle,
} from "../shared/e2ee.js";
import { encodeEnvelope, decodeEnvelope } from "../shared/types.js";

test("Full PQXDH + DR Flow: Handshake → Message → SPK Rotation → Re-handshake → Old Messages Decrypt", async () => {
  await initCrypto();

  // --- Phase 1: Initial Handshake ---
  const bobIK = generateSignKeyPair();
  const bobSPK = generateDHKeyPair();
  const bobSPKSig = sign(bobSPK.publicKey, bobIK.privateKey);
  const bobPQSPK = generatePQKeyPair();
  const bobPQSPKSig = sign(bobPQSPK.publicKey, bobIK.privateKey);

  const bobBundle: HandshakeBundle = {
    identityKey: bobIK.publicKey,
    signedPrekey: bobSPK.publicKey,
    pqSignedPrekey: bobPQSPK.publicKey,
    signature: bobSPKSig,
    pqSignature: bobPQSPKSig,
  };

  const aliceIK = generateSignKeyPair();
  const aliceHandshake = await initiateHandshake(aliceIK, bobBundle);
  const bobSecret = await respondToHandshake(
    bobIK, bobSPK, null, bobPQSPK, null,
    aliceIK.publicKey, aliceHandshake.ephemeralKey, aliceHandshake.pqCiphertext
  );
  assert.deepEqual(aliceHandshake.sharedSecret, bobSecret, "Phase 1: Handshake secrets must match");

  // --- Phase 2: Initialize Ratchets and Exchange Messages ---
  const aliceRatchet1 = await DoubleRatchet.initiate(aliceHandshake.sharedSecret, bobSPK.publicKey);
  const bobRatchet1 = await DoubleRatchet.respond(bobSecret, bobSPK);

  // Save states BEFORE any decryption (reference copy issue — exportState deep-copies)
  const aliceState1 = aliceRatchet1.exportState();
  const bobState1 = bobRatchet1.exportState();

  const msg1 = new TextEncoder().encode("Hello Bob! Phase 1 message.");
  const env1 = await aliceRatchet1.encrypt(msg1);
  const dec1 = await bobRatchet1.decrypt(env1);
  assert.equal(new TextDecoder().decode(dec1), "Hello Bob! Phase 1 message.");

  const msg2 = new TextEncoder().encode("Hi Alice! Phase 1 reply.");
  const env2 = await bobRatchet1.encrypt(msg2);
  const dec2 = await aliceRatchet1.decrypt(env2);
  assert.equal(new TextDecoder().decode(dec2), "Hi Alice! Phase 1 reply.");

  // Verify protobuf round-trip works for these envelopes
  const binEnv1 = encodeEnvelope(env1);
  const decodedEnv1 = decodeEnvelope(binEnv1);
  const bobRatchet1Copy = await DoubleRatchet.importState(bobState1);
  const dec1FromProtobuf = await bobRatchet1Copy.decrypt(decodedEnv1);
  assert.equal(new TextDecoder().decode(dec1FromProtobuf), "Hello Bob! Phase 1 message.", "Protobuf round-trip must preserve decryptability");

  // --- Phase 3: Bob Rotates SPK ---
  const bobNewSPK = generateDHKeyPair();
  const bobNewSPKSig = sign(bobNewSPK.publicKey, bobIK.privateKey);
  const bobNewPQSPK = generatePQKeyPair();
  const bobNewPQSPKSig = sign(bobNewPQSPK.publicKey, bobIK.privateKey);

  const bobNewBundle: HandshakeBundle = {
    identityKey: bobIK.publicKey,
    signedPrekey: bobNewSPK.publicKey,
    pqSignedPrekey: bobNewPQSPK.publicKey,
    signature: bobNewSPKSig,
    pqSignature: bobNewPQSPKSig,
  };

  // --- Phase 4: Re-handshake with New SPK ---
  const aliceHandshake2 = await initiateHandshake(aliceIK, bobNewBundle);
  const bobSecret2 = await respondToHandshake(
    bobIK, bobNewSPK, null, bobNewPQSPK, null,
    aliceIK.publicKey, aliceHandshake2.ephemeralKey, aliceHandshake2.pqCiphertext
  );
  assert.deepEqual(aliceHandshake2.sharedSecret, bobSecret2, "Phase 4: Re-handshake secrets must match");
  // New session must produce a different shared secret
  assert.notDeepEqual(aliceHandshake.sharedSecret, aliceHandshake2.sharedSecret, "Phase 4: New session secret must differ from old");

  // --- Phase 5: Exchange Messages in New Session ---
  const aliceRatchet2 = await DoubleRatchet.initiate(aliceHandshake2.sharedSecret, bobNewSPK.publicKey);
  const bobRatchet2 = await DoubleRatchet.respond(bobSecret2, bobNewSPK);

  const msg3 = new TextEncoder().encode("Hello Bob! Phase 2 message after SPK rotation.");
  const env3 = await aliceRatchet2.encrypt(msg3);
  const dec3 = await bobRatchet2.decrypt(env3);
  assert.equal(new TextDecoder().decode(dec3), "Hello Bob! Phase 2 message after SPK rotation.");

  const msg4 = new TextEncoder().encode("Hi Alice! Phase 2 reply after SPK rotation.");
  const env4 = await bobRatchet2.encrypt(msg4);
  const dec4 = await aliceRatchet2.decrypt(env4);
  assert.equal(new TextDecoder().decode(dec4), "Hi Alice! Phase 2 reply after SPK rotation.");

  // --- Phase 6: Verify Old Session Messages Still Decrypt ---
  const aliceRatchet1Restored = await DoubleRatchet.importState(aliceState1);
  const bobRatchet1Restored = await DoubleRatchet.importState(bobState1);

  const decOld1 = await bobRatchet1Restored.decrypt(env1);
  assert.equal(new TextDecoder().decode(decOld1), "Hello Bob! Phase 1 message.", "Old session message must still decrypt");

  const decOld2 = await aliceRatchet1Restored.decrypt(env2);
  assert.equal(new TextDecoder().decode(decOld2), "Hi Alice! Phase 1 reply.", "Old session reply must still decrypt");

  // --- Phase 7: Forward Secrecy Check ---
  const bobState2 = bobRatchet2.exportState();
  assert.equal(bobState2.MKSKIPPED.size, 0, "No skipped keys should remain after in-order delivery");
});

test("PQXDH with One-Time Prekeys: Full Flow", async () => {
  await initCrypto();

  const bobIK = generateSignKeyPair();
  const bobSPK = generateDHKeyPair();
  const bobSPKSig = sign(bobSPK.publicKey, bobIK.privateKey);
  const bobPQSPK = generatePQKeyPair();
  const bobPQSPKSig = sign(bobPQSPK.publicKey, bobIK.privateKey);
  const bobOPK = generateDHKeyPair();
  const bobPQOPK = generatePQKeyPair();

  const bobBundle: HandshakeBundle = {
    identityKey: bobIK.publicKey,
    signedPrekey: bobSPK.publicKey,
    pqSignedPrekey: bobPQSPK.publicKey,
    signature: bobSPKSig,
    pqSignature: bobPQSPKSig,
    oneTimePrekey: bobOPK.publicKey,
    pqOneTimePrekey: bobPQOPK.publicKey,
  };

  const aliceIK = generateSignKeyPair();
  const aliceHandshake = await initiateHandshake(aliceIK, bobBundle);

  const bobSecret = await respondToHandshake(
    bobIK, bobSPK, bobOPK, bobPQSPK, bobPQOPK,
    aliceIK.publicKey, aliceHandshake.ephemeralKey, aliceHandshake.pqCiphertext
  );
  assert.deepEqual(aliceHandshake.sharedSecret, bobSecret, "OPK handshake secrets must match");

  // Verify the handshake produces a working ratchet
  const aliceRatchet = await DoubleRatchet.initiate(aliceHandshake.sharedSecret, bobSPK.publicKey);
  const bobRatchet = await DoubleRatchet.respond(bobSecret, bobSPK);

  const msg = new TextEncoder().encode("Message with OPK!");
  const env = await aliceRatchet.encrypt(msg);
  const dec = await bobRatchet.decrypt(env);
  assert.equal(new TextDecoder().decode(dec), "Message with OPK!");
});

test("Skipped Message Keys: Stress Test", async () => {
  await initCrypto();

  const bobIK = generateSignKeyPair();
  const bobSPK = generateDHKeyPair();
  const bobSPKSig = sign(bobSPK.publicKey, bobIK.privateKey);
  const bobPQSPK = generatePQKeyPair();
  const bobPQSPKSig = sign(bobPQSPK.publicKey, bobIK.privateKey);

  const bobBundle: HandshakeBundle = {
    identityKey: bobIK.publicKey,
    signedPrekey: bobSPK.publicKey,
    pqSignedPrekey: bobPQSPK.publicKey,
    signature: bobSPKSig,
    pqSignature: bobPQSPKSig,
  };

  const aliceIK = generateSignKeyPair();
  const aliceHandshake = await initiateHandshake(aliceIK, bobBundle);
  const bobSecret = await respondToHandshake(
    bobIK, bobSPK, null, bobPQSPK, null,
    aliceIK.publicKey, aliceHandshake.ephemeralKey, aliceHandshake.pqCiphertext
  );

  const aliceRatchet = await DoubleRatchet.initiate(aliceHandshake.sharedSecret, bobSPK.publicKey);
  const bobRatchet = await DoubleRatchet.respond(bobSecret, bobSPK);

  // Alice sends 10 messages
  const messages = [];
  for (let i = 0; i < 10; i++) {
    const msg = new TextEncoder().encode(`Message ${i}`);
    const env = await aliceRatchet.encrypt(msg);
    messages.push(env);
  }

  // Bob receives out of order: 0, 5, 9, 2, 7, 1, 3, 4, 6, 8
  const receiveOrder = [0, 5, 9, 2, 7, 1, 3, 4, 6, 8];
  for (const idx of receiveOrder) {
    const env = messages[idx];
    assert.ok(env, `Message ${idx} must exist`);
    const dec = await bobRatchet.decrypt(env);
    assert.equal(new TextDecoder().decode(dec), `Message ${idx}`);
  }

  // All skipped keys should be consumed after receiving all messages
  const state = (bobRatchet as any).state;
  assert.equal(state.MKSKIPPED.size, 0, "All skipped keys consumed after receiving all messages");
});
