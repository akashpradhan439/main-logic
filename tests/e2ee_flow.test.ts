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
import { initiateHandshake, respondToHandshake, DoubleRatchet, type HandshakeBundle } from "../shared/e2ee.js";

test("Double Ratchet: Full E2EE Flow (Handshake + Messaging + Out-of-Order)", async () => {
  await initCrypto();

  // --- 1. Handshake ---
  const bobIK = generateSignKeyPair();
  const bobSPK = generateDHKeyPair();
  const bobSPKSig = sign(bobSPK.publicKey, bobIK.privateKey);
  const bobPQSPK = generatePQKeyPair();

  const bobBundle: HandshakeBundle = {
    identityKey: bobIK.publicKey,
    signedPrekey: bobSPK.publicKey,
    pqSignedPrekey: bobPQSPK.publicKey,
    signature: bobSPKSig,
  };

  const aliceIK = generateSignKeyPair();
  const aliceHandshake = await initiateHandshake(aliceIK, bobBundle);

  const bobSecret = await respondToHandshake(
    bobIK,
    bobSPK,
    null, // no OPK for this test
    bobPQSPK,
    null, // no PQOPK for this test
    aliceIK.publicKey,
    aliceHandshake.ephemeralKey,
    aliceHandshake.pqCiphertext
  );

  assert.deepEqual(aliceHandshake.sharedSecret, bobSecret, "Handshake secrets must match");

  // --- 2. Initialize Ratchets ---
  const aliceRatchet = await DoubleRatchet.initiate(aliceHandshake.sharedSecret, bobSPK.publicKey);
  const bobRatchet = await DoubleRatchet.respond(bobSecret, bobSPK);

  // --- 3. Synchronous Exchange ---
  const msg1 = new TextEncoder().encode("Hello Bob!");
  const env1 = await aliceRatchet.encrypt(msg1);
  const dec1 = await bobRatchet.decrypt(env1);
  assert.equal(new TextDecoder().decode(dec1), "Hello Bob!");

  const msg2 = new TextEncoder().encode("Hi Alice!");
  const env2 = await bobRatchet.encrypt(msg2);
  const dec2 = await aliceRatchet.decrypt(env2);
  assert.equal(new TextDecoder().decode(dec2), "Hi Alice!");

  // --- 4. Out-of-Order Delivery ---
  // Alice sends 3 messages: A, B, C
  const msgA = new TextEncoder().encode("Message A");
  const msgB = new TextEncoder().encode("Message B");
  const msgC = new TextEncoder().encode("Message C");

  const envA = await aliceRatchet.encrypt(msgA);
  const envB = await aliceRatchet.encrypt(msgB);
  const envC = await aliceRatchet.encrypt(msgC);

  // Bob receives C first
  const decC = await bobRatchet.decrypt(envC);
  assert.equal(new TextDecoder().decode(decC), "Message C");

  // Bob receives A
  const decA = await bobRatchet.decrypt(envA);
  assert.equal(new TextDecoder().decode(decA), "Message A");

  // Bob receives B
  const decB = await bobRatchet.decrypt(envB);
  assert.equal(new TextDecoder().decode(decB), "Message B");

  // --- 5. Forward Secrecy (Key Deletion) ---
  // We'll peek into the state to verify deletion (demo purposes)
  const state = (bobRatchet as any).state;
  assert.equal(state.MKSKIPPED.size, 0, "All skipped keys should be deleted after use");
  
  console.log("SUCCESS: End-to-end E2EE flow verified with out-of-order delivery.");
});
