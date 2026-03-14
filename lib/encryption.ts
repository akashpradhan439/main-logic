import crypto from "crypto";
import { config } from "../config.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

interface EncryptedData {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export function encryptPayload(payload: object): EncryptedData {
  if (!config.qrEncryptionKey) {
    throw new Error("QR_ENCRYPTION_KEY environment variable is not set");
  }

  // Derive 256-bit key from the config key
  const key = crypto
    .createHash("sha256")
    .update(config.qrEncryptionKey)
    .digest();

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const jsonString = JSON.stringify(payload);
  const encrypted = Buffer.concat([
    cipher.update(jsonString, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decryptPayload(data: EncryptedData): object {
  if (!config.qrEncryptionKey) {
    throw new Error("QR_ENCRYPTION_KEY environment variable is not set");
  }

  const key = crypto
    .createHash("sha256")
    .update(config.qrEncryptionKey)
    .digest();

  const iv = Buffer.from(data.iv, "base64");
  const authTag = Buffer.from(data.authTag, "base64");
  const ciphertext = Buffer.from(data.ciphertext, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString("utf8"));
  } catch (err) {
    throw new Error("Failed to decrypt payload: authentication tag verification failed");
  }
}

/**
 * Serialize encrypted data to a single string token (iv.authTag.ciphertext)
 */
export function serializeEncryptedToken(data: EncryptedData): string {
  return `${data.iv}.${data.authTag}.${data.ciphertext}`;
}

/**
 * Parse encrypted token string back to structured format
 */
export function parseEncryptedToken(token: string): EncryptedData {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token format");
  }

  const [iv, authTag, ciphertext] = parts as [string, string, string];

  return {
    iv,
    authTag,
    ciphertext,
  };
}
