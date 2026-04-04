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
import { encodeEnvelope } from "../shared/types.js";

const toHex = (buf: Uint8Array) => Buffer.from(buf).toString("hex");

test("Double Ratchet: Full E2EE Flow (Handshake + Messaging + Out-of-Order)", async () => {
  await initCrypto();

  console.log("\n🧪 STARTING E2EE GOLDEN TRACE GENERATION\n");

  // --- 1. Handshake ---
  const bobIK = generateSignKeyPair();
  const bobSPK = generateDHKeyPair();
  const bobSPKSig = sign(bobSPK.publicKey, bobIK.privateKey);
  const bobPQSPK = generatePQKeyPair();

  console.log("--- HANDSHAKE INPUTS ---");
  console.log("Bob IK Pub:  ", toHex(bobIK.publicKey));
  console.log("Bob SPK Pub: ", toHex(bobSPK.publicKey));
  console.log("Bob PQSPK Pub:", toHex(bobPQSPK.publicKey));

  const bobBundle: HandshakeBundle = {
    identityKey: bobIK.publicKey,
    signedPrekey: bobSPK.publicKey,
    pqSignedPrekey: bobPQSPK.publicKey,
    signature: bobSPKSig,
  };

  const aliceIK = generateSignKeyPair();
  console.log("Alice IK Pub:", toHex(aliceIK.publicKey));

  const aliceHandshake = await initiateHandshake(aliceIK, bobBundle);
  console.log("\n--- HANDSHAKE RESULT ---");
  console.log("Alice Ephemeral Pub:", toHex(aliceHandshake.ephemeralKey));
  console.log("PQ Ciphertext:      ", toHex(aliceHandshake.pqCiphertext!));
  console.log("Shared Secret (SK): ", toHex(aliceHandshake.sharedSecret));

  const bobSecret = await respondToHandshake(
    bobIK,
    bobSPK,
    null,
    bobPQSPK,
    null,
    aliceIK.publicKey,
    aliceHandshake.ephemeralKey,
    aliceHandshake.pqCiphertext
  );

  assert.deepEqual(aliceHandshake.sharedSecret, bobSecret, "Handshake secrets must match");

  // --- 2. Initialize Ratchets ---
  const aliceRatchet = await DoubleRatchet.initiate(aliceHandshake.sharedSecret, bobSPK.publicKey);
  const bobRatchet = await DoubleRatchet.respond(bobSecret, bobSPK);

  const aliceState = (aliceRatchet as any).state;
  console.log("\n--- RATCHET INITIALIZATION ---");
  console.log("Alice Root Key (RK): ", toHex(aliceState.RK));
  console.log("Alice CKs:           ", toHex(aliceState.CKs));

  // --- 3. Synchronous Exchange ---
  console.log("\n--- MESSAGE 1 (Alice -> Bob) ---");
  const msg1 = new TextEncoder().encode("Hello Bob!");
  const env1 = await aliceRatchet.encrypt(msg1);
  const binEnv1 = encodeEnvelope(env1);
  console.log("Ciphertext (Hex): ", toHex(env1.ciphertext));
  console.log("Protobuf (Hex):   ", toHex(binEnv1));
  
  const dec1 = await bobRatchet.decrypt(env1);
  assert.equal(new TextDecoder().decode(dec1), "Hello Bob!");
  console.log("Decrypted:         ", new TextDecoder().decode(dec1));

  console.log("\n--- MESSAGE 2 (Bob -> Alice) ---");
  const msg2 = new TextEncoder().encode("Hi Alice!");
  const env2 = await bobRatchet.encrypt(msg2);
  const dec2 = await aliceRatchet.decrypt(env2);
  assert.equal(new TextDecoder().decode(dec2), "Hi Alice!");
  console.log("Decrypted:         ", new TextDecoder().decode(dec2));

  // --- 4. Out-of-Order Delivery ---
  console.log("\n--- OUT-OF-ORDER SEQUENCE (Alice sends A, B, C) ---");
  const msgA = new TextEncoder().encode("Message A");
  const msgB = new TextEncoder().encode("Message B");
  const msgC = new TextEncoder().encode("Message C");

  const envA = await aliceRatchet.encrypt(msgA);
  const envB = await aliceRatchet.encrypt(msgB);
  const envC = await aliceRatchet.encrypt(msgC);

  console.log("Alice sends Msg C (N=4)");
  const decC = await bobRatchet.decrypt(envC);
  assert.equal(new TextDecoder().decode(decC), "Message C");
  console.log("Bob receives C (Skipped A, B)");

  console.log("Bob receives A from MKSKIPPED");
  const decA = await bobRatchet.decrypt(envA);
  assert.equal(new TextDecoder().decode(decA), "Message A");

  console.log("Bob receives B from MKSKIPPED");
  const decB = await bobRatchet.decrypt(envB);
  assert.equal(new TextDecoder().decode(decB), "Message B");

  // --- 5. Forward Secrecy ---
  const state = (bobRatchet as any).state;
  assert.equal(state.MKSKIPPED.size, 0, "All skipped keys should be deleted after use");
  
  console.log("\n--- FINAL STATE ---");
  console.log("Bob Root Key (RK):  ", toHex(state.RK));
  console.log("MKSKIPPED Size:     ", state.MKSKIPPED.size);

  console.log("\n✅ GOLDEN TRACE GENERATION COMPLETE\n");
});
