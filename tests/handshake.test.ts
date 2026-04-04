import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initCrypto,
  generateDHKeyPair,
  generateSignKeyPair,
  generatePQKeyPair,
  sign,
  type DHKeyPair,
  type PQKeyPair,
  type SignKeyPair,
} from "../shared/cryptography.js";
import { initiateHandshake, respondToHandshake, type HandshakeBundle } from "../shared/e2ee.js";

test("PQXDH Handshake: Alice and Bob derive the same shared secret", async () => {
  await initCrypto();

  // 1. Setup Bob's Prekeys
  // Identity Key is Ed25519 (SignKeyPair)
  const bobIK = generateSignKeyPair();
  const bobSPK = generateDHKeyPair();
  // Real signature of the SPK's public key by the IK's private key
  const bobSPKSig = sign(bobSPK.publicKey, bobIK.privateKey);
  const bobPQSPK = generatePQKeyPair();
  const bobOPK = generateDHKeyPair();
  const bobPQOPK = generatePQKeyPair();

  // 2. Bob publishes bundle
  const bobBundle: HandshakeBundle = {
    identityKey: bobIK.publicKey,
    signedPrekey: bobSPK.publicKey,
    pqSignedPrekey: bobPQSPK.publicKey,
    signature: bobSPKSig,
    oneTimePrekey: bobOPK.publicKey,
    pqOneTimePrekey: bobPQOPK.publicKey,
  };

  // 3. Alice initiates
  // Alice Identity Key is also Ed25519
  const aliceIK = generateSignKeyPair();
  const handshakeResult = await initiateHandshake(aliceIK, bobBundle);

  // 4. Bob responds
  const bobSharedSecret = await respondToHandshake(
    bobIK,
    bobSPK,
    bobOPK,
    bobPQSPK,
    bobPQOPK,
    aliceIK.publicKey,
    handshakeResult.ephemeralKey,
    handshakeResult.pqCiphertext
  );

  // 5. Assert equality
  const aliceHex = Buffer.from(handshakeResult.sharedSecret).toString('hex');
  const bobHex = Buffer.from(bobSharedSecret).toString('hex');

  assert.equal(aliceHex, bobHex, "Derived shared secrets must match");
  assert.equal(handshakeResult.sharedSecret.length, 32);
});
