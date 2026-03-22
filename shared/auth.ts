import jwt from "jsonwebtoken";
import { config } from "../config.js";

export interface AccessTokenPayload {
  sub: string;   // userId
  phone: string;
  type: "access";
  iat: number;
  exp: number;
}

export interface WsTokenPayload {
  sub: string;   // userId
  type: "ws";
  iat: number;
  exp: number;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export function verifyAccessToken(authHeader: string | undefined): AccessTokenPayload {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AuthError("Missing or invalid Authorization header");
  }

  const token = authHeader.replace("Bearer ", "").trim();

  try {
    const payload = jwt.verify(token, config.jwtSecret) as AccessTokenPayload;

    if (payload.type !== "access") {
      throw new AuthError("Invalid token type");
    }

    return payload;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError("Invalid or expired token");
  }
}

/**
 * Signs a short-lived token for WebSocket authentication.
 */
export function signWsToken(userId: string): string {
  const payload: Partial<WsTokenPayload> = {
    sub: userId,
    type: "ws",
  };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "60s" });
}

/**
 * Verifies a short-lived WebSocket token.
 */
export function verifyWsToken(token: string): WsTokenPayload {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as WsTokenPayload;
    if (payload.type !== "ws") {
      throw new AuthError("Invalid token type");
    }
    return payload;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError("Invalid or expired WebSocket token");
  }
}