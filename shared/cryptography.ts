import sodium from "libsodium-wrappers";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { aessiv } from "@noble/ciphers/aes.js";
import { hkdf as noble_hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import crypto from "node:crypto";

export interface DHKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface PQKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface SignKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export async function initCrypto() {
  await sodium.ready;
}

// ─── Classical X25519 ────────────────────────────────────────────────────────

export function generateDHKeyPair(): DHKeyPair {
  const { publicKey, privateKey } = sodium.crypto_kx_keypair();
  return { publicKey, privateKey };
}

export function diffieHellman(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return sodium.crypto_scalarmult(privateKey, publicKey);
}

export function ed25519ToX25519(publicKey: Uint8Array): Uint8Array {
  return sodium.crypto_sign_ed25519_pk_to_curve25519(publicKey);
}

export function ed25519skToX25519(privateKey: Uint8Array): Uint8Array {
  return sodium.crypto_sign_ed25519_sk_to_curve25519(privateKey);
}

// ─── Post-Quantum ML-KEM-768 ─────────────────────────────────────────────────

export function generatePQKeyPair(): PQKeyPair {
  const seed = crypto.randomBytes(64);
  const { publicKey, secretKey: privateKey } = ml_kem768.keygen(seed);
  return { publicKey, privateKey };
}

export function pqEncapsulate(publicKey: Uint8Array): { sharedSecret: Uint8Array; ciphertext: Uint8Array } {
  const { cipherText: ciphertext, sharedSecret } = ml_kem768.encapsulate(publicKey);
  return { sharedSecret, ciphertext };
}

export function pqDecapsulate(ciphertext: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return ml_kem768.decapsulate(ciphertext, privateKey);
}

// ─── Ed25519 Signatures ──────────────────────────────────────────────────────

export function generateSignKeyPair(): SignKeyPair {
  const { publicKey, privateKey } = sodium.crypto_sign_keypair();
  return { publicKey, privateKey };
}

export function sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return sodium.crypto_sign_detached(message, privateKey);
}

export function verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  return sodium.crypto_sign_verify_detached(signature, message, publicKey);
}

// ─── Key Derivation & HMAC ───────────────────────────────────────────────────

export function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Uint8Array {
  return noble_hkdf(sha256, ikm, salt, new TextEncoder().encode(info), length);
}

export function hmac_sha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  return hmac(sha256, key, message);
}

// ─── SIV Encryption ──────────────────────────────────────────────────────────

export function encryptSiv(plaintext: Uint8Array, key: Uint8Array, ad: Uint8Array[] = []): Uint8Array {
  const cipher = aessiv(key, ...ad);
  return cipher.encrypt(plaintext);
}

export function decryptSiv(ciphertext: Uint8Array, key: Uint8Array, ad: Uint8Array[] = []): Uint8Array {
  const cipher = aessiv(key, ...ad);
  return cipher.decrypt(ciphertext);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function toBase64(data: Uint8Array): string {
  return sodium.to_base64(data);
}

export function fromBase64(b64: string): Uint8Array {
  return sodium.from_base64(b64);
}

export function randomBytes(length: number): Uint8Array {
  return sodium.randombytes_buf(length);
}

export function memzero(data: Uint8Array): void {
  sodium.memzero(data);
}

export function equals(a: Uint8Array, b: Uint8Array): boolean {
  return sodium.memcmp(a, b);
}
