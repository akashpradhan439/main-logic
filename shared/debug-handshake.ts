import {
  initCrypto,
  generateDHKeyPair,
  generatePQKeyPair,
  sign,
} from "./cryptography.js";
import { initiateHandshake, respondToHandshake } from "./e2ee.js";

async function main() {
  console.log("Initializing crypto...");
  await initCrypto();
  console.log("Crypto initialized.");

  const bobIK = generateDHKeyPair() as any;
  const bobSPK = generateDHKeyPair();
  const bobSPKSig = new Uint8Array(64); 
  const bobPQSPK = generatePQKeyPair();
  const bobOPK = generateDHKeyPair();
  const bobPQOPK = generatePQKeyPair();

  const bobBundle = {
    identityKey: bobIK.publicKey,
    signedPrekey: bobSPK.publicKey,
    pqSignedPrekey: bobPQSPK.publicKey,
    signature: bobSPKSig,
    pqSignature: new Uint8Array(64), // Dummy signature for debug
    oneTimePrekey: bobOPK.publicKey,
    pqOneTimePrekey: bobPQOPK.publicKey,
  };

  const aliceIK = generateDHKeyPair() as any;
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

  if (Buffer.from(handshakeResult.sharedSecret).toString('hex') === Buffer.from(bobSharedSecret).toString('hex')) {
    console.log("SUCCESS: Shared secrets match!");
  } else {
    console.log("FAILURE: Shared secrets DO NOT match!");
  }
}

main().catch(console.error);
