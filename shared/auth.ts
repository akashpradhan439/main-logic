import jwt from "jsonwebtoken";
import { config } from "../config.js";

export interface AccessTokenPayload {
  sub: string;   // userId
  phone: string;
  type: "access";
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