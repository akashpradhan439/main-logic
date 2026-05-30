// L3: moved out of shared/ (it is a manual debug harness, not protocol code).
// Run with: tsx scripts/debug-handshake.ts
import {
  initCrypto,
  generateDHKeyPair,
  generateSignKeyPair,
  generatePQKeyPair,
  sign,
} from "../shared/cryptography.js";
import { initiateHandshake, respondToHandshake, type HandshakeBundle } from "../shared/e2ee.js";

async function main() {
  console.log("Initializing crypto...");
  await initCrypto();
  console.log("Crypto initialized.");

  // Identity keys are Ed25519 (XEdDSA); signatures are real so verification passes.
  const bobIK = generateSignKeyPair();
  const bobSPK = generateDHKeyPair();
  const bobPQSPK = generatePQKeyPair();
  const bobOPK = generateDHKeyPair();
  const bobPQOPK = generatePQKeyPair();

  const bobBundle: HandshakeBundle = {
    identityKey: bobIK.publicKey,
    signedPrekey: bobSPK.publicKey,
    pqSignedPrekey: bobPQSPK.publicKey,
    signature: sign(bobSPK.publicKey, bobIK.privateKey),
    pqSignature: sign(bobPQSPK.publicKey, bobIK.privateKey),
    oneTimePrekey: bobOPK.publicKey,
    pqOneTimePrekey: bobPQOPK.publicKey,
  };

  const aliceIK = generateSignKeyPair();
  const handshakeResult = await initiateHandshake(aliceIK, bobBundle);
  console.log("Alice handshake result generated.");

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
  console.log("Bob shared secret generated.");

  if (Buffer.from(handshakeResult.sharedSecret).toString("hex") === Buffer.from(bobSharedSecret).toString("hex")) {
    console.log("SUCCESS: Shared secrets match!");
  } else {
    console.log("FAILURE: Shared secrets DO NOT match!");
  }
}

main().catch(console.error);
