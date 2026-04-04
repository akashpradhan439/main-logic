import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initCrypto,
  generateDHKeyPair,
  diffieHellman,
  generatePQKeyPair,
  pqEncapsulate,
  pqDecapsulate,
  generateSignKeyPair,
  sign,
  verify,
  hkdf,
  encryptSiv,
  decryptSiv,
  toBase64,
  fromBase64,
  randomBytes,
} from "../shared/cryptography.js";

test("Cryptographic Primitives", async (t) => {
  await initCrypto();

  await t.test("X25519 (Classical DH)", () => {
    const alice = generateDHKeyPair();
    const bob = generateDHKeyPair();

    const secret1 = diffieHellman(alice.privateKey, bob.publicKey);
    const secret2 = diffieHellman(bob.privateKey, alice.publicKey);

    assert.deepEqual(secret1, secret2, "Shared secrets must match");
    assert.equal(secret1.length, 32, "Shared secret should be 32 bytes");
  });

  await t.test("ML-KEM-768 (PQ KEM)", () => {
    const bob = generatePQKeyPair();
    const { sharedSecret: ss1, ciphertext } = pqEncapsulate(bob.publicKey);
    const ss2 = pqDecapsulate(ciphertext, bob.privateKey);

    assert.deepEqual(ss1, ss2, "PQ shared secrets must match");
    assert.equal(ss1.length, 32, "PQ shared secret should be 32 bytes");
  });

  await t.test("Ed25519 (Signatures)", () => {
    const alice = generateSignKeyPair();
    const message = new TextEncoder().encode("Hello world");
    const sig = sign(message, alice.privateKey);
    const isValid = verify(message, sig, alice.publicKey);

    assert.ok(isValid, "Signature should be valid");

    const wrongMessage = new TextEncoder().encode("Goodbye world");
    const isInvalid = verify(wrongMessage, sig, alice.publicKey);
    assert.ok(!isInvalid, "Signature should be invalid for different message");
  });

  await t.test("HKDF (Key Derivation)", () => {
    const ikm = randomBytes(32);
    const salt = randomBytes(32);
    const info = "test info";
    const okm1 = hkdf(ikm, salt, info, 32);
    const okm2 = hkdf(ikm, salt, info, 32);

    const hex1 = Buffer.from(okm1).toString('hex');
    const hex2 = Buffer.from(okm2).toString('hex');
    assert.equal(hex1, hex2, "HKDF output should be deterministic");
    assert.equal(okm1.length, 32, "HKDF output length should match requested length");

    const okm3 = hkdf(ikm, salt, "different info", 32);
    assert.notDeepEqual(okm1, okm3, "HKDF output should change with different info");
  });

  await t.test("AES-SIV (Deterministic AEAD)", () => {
    const key = randomBytes(64); // SIV-AES256 requires 64-byte key (32 for CMAC, 32 for CTR)
    const plaintext = new TextEncoder().encode("Secret message");
    const ad = [new TextEncoder().encode("header data")];

    const ciphertext = encryptSiv(plaintext, key, ad);
    const decrypted = decryptSiv(ciphertext, key, ad);

    assert.deepEqual(decrypted, plaintext, "Decrypted text must match plaintext");

    // Test deterministic property
    const ciphertext2 = encryptSiv(plaintext, key, ad);
    assert.deepEqual(ciphertext, ciphertext2, "AES-SIV should be deterministic for same inputs");

    // Test AD dependency
    assert.throws(() => {
      decryptSiv(ciphertext, key, [new TextEncoder().encode("wrong header")]);
    }, "Decryption should fail with wrong AD");
  });

  await t.test("Base64 Helpers", () => {
    const data = randomBytes(16);
    const b64 = toBase64(data);
    const decoded = fromBase64(b64);
    assert.deepEqual(decoded, data, "Base64 roundtrip should work");
  });
});
