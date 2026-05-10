import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const JWT_SECRET = Deno.env.get("JWT_SECRET")!;

export interface AccessTokenPayload {
  sub: string;
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

export async function verifyAccessToken(req: Request): Promise<AccessTokenPayload> {
  const authHeader = req.headers.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AuthError("Missing or invalid Authorization header");
  }

  const token = authHeader.replace("Bearer ", "").trim();

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const payload = await verify(token, key) as AccessTokenPayload;

  if (payload.type !== "access") {
    throw new AuthError("Invalid token type");
  }

  return payload;
}
