import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Redis } from "https://esm.sh/@upstash/redis@1.20.1";
import bcrypt from "https://esm.sh/bcryptjs@2.4.3";
import { create, verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const JWT_SECRET = Deno.env.get("JWT_SECRET")!;
const PEPPER = Deno.env.get("PASSWORD_PEPPER") || "default_pepper_if_not_set";
const ACCESS_TOKEN_EXPIRY = 10 * 60;        // 10 minutes
const REFRESH_TOKEN_EXPIRY = 30 * 24 * 60 * 60; // 30 days
const FORCE_LOGIN_TOKEN_EXPIRY = 15 * 60;   // 15 minutes

interface LoginRequest {
  country_code: string;
  phone_number: number;
  password: string;
  force_login?: boolean;
  force_login_token?: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const redis = new Redis({
      url: Deno.env.get("REDIS_URL")!,
      token: Deno.env.get("REDIS_TOKEN")!,
    });

    const { country_code, phone_number, password, force_login, force_login_token }: LoginRequest = await req.json();

    if (!country_code || !phone_number || !password) {
      return new Response(
        JSON.stringify({ error: "Phone details and password are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Fetch user
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, password_hash, country_code, phone_number")
      .eq("country_code", country_code)
      .eq("phone_number", phone_number)
      .maybeSingle();

    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid credentials" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Rate limit check
    const failedKey = `failed_login:${country_code}${phone_number}`;
    const failedCount = (await redis.get<number>(failedKey)) || 0;
    if (failedCount >= 3) {
      await redis.set(failedKey, failedCount + 1, { ex: 900 });
      return new Response(
        JSON.stringify({ error: "Too many failed attempts. Try again in 15 minutes." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    await redis.set(failedKey, failedCount + 1, { ex: 900 });

    // 3. Verify password
    const passwordMatch = await bcrypt.compare(password + PEPPER, user.password_hash);
    if (!passwordMatch) {
      return new Response(
        JSON.stringify({ error: "Invalid credentials" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Check for existing session
    const sessionKey = `session:${user.country_code}${user.phone_number}:refresh`;
    const existingSession = await redis.get(sessionKey);

    if (existingSession) {
      // --- FORCE LOGIN PATH ---
      if (force_login && force_login_token) {
        // 4a. Verify JWT signature + expiry
        const jwtKey = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(JWT_SECRET),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["verify"]
        );

        let payload: Record<string, unknown>;
        try {
          payload = await verify(force_login_token, jwtKey) as Record<string, unknown>;
        } catch {
          return new Response(
            JSON.stringify({ error: "Invalid or expired force_login_token" }),
            { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // 4b. Confirm token type and that it belongs to this user
        if (payload.type !== "force_login" || payload.sub !== user.id) {
          return new Response(
            JSON.stringify({ error: "Invalid force_login_token" }),
            { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // 4c. Verify hash matches what's stored in Redis
        const forceLoginKey = `force_login:${user.country_code}${user.phone_number}`;
        const storedHash = await redis.get<string>(forceLoginKey);
        const incomingHash = await hashToken(force_login_token);

        if (!storedHash || storedHash !== incomingHash) {
          return new Response(
            JSON.stringify({ error: "Invalid or already used force_login_token" }),
            { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // 4d. All checks passed — evict old session and the force_login token
        await redis.del(sessionKey);
        await redis.del(forceLoginKey);

      } else {
        // --- NO FORCE LOGIN — issue force_login_token and ask user to confirm ---
        const jwtKey = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(JWT_SECRET),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );

        const now = Math.floor(Date.now() / 1000);
        const forceToken = await create(
          { alg: "HS256", typ: "JWT" },
          {
            sub: user.id,
            type: "force_login",
            iat: now,
            exp: now + FORCE_LOGIN_TOKEN_EXPIRY,
          },
          jwtKey
        );

        const forceTokenHash = await hashToken(forceToken);
        const forceLoginKey = `force_login:${user.country_code}${user.phone_number}`;
        await redis.set(forceLoginKey, forceTokenHash, { ex: FORCE_LOGIN_TOKEN_EXPIRY });

        return new Response(
          JSON.stringify({
            error: "An active session exists on another device.",
            code: "ACTIVE_SESSION_EXISTS",
            force_login_token: forceToken,
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // 5. Generate and store new session tokens
    const { accessToken, refreshToken } = await generateTokens(user.id, user.country_code, user.phone_number);
    const refreshTokenHash = await hashToken(refreshToken);
    await redis.set(sessionKey, refreshTokenHash, { ex: REFRESH_TOKEN_EXPIRY });
    await redis.del(failedKey);

    return new Response(
      JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: ACCESS_TOKEN_EXPIRY,
        user: {
          id: user.id,
          phone: `${user.country_code}${user.phone_number}`,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Login error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function generateTokens(userId: string, countryCode: string, phoneNumber: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const now = Math.floor(Date.now() / 1000);
  const sub = `${countryCode}${phoneNumber}`;

  const accessToken = await create(
    { alg: "HS256", typ: "JWT" },
    { sub: userId, phone: sub, type: "access", iat: now, exp: now + ACCESS_TOKEN_EXPIRY },
    key
  );

  const refreshToken = await create(
    { alg: "HS256", typ: "JWT" },
    { sub: userId, phone: sub, type: "refresh", iat: now, exp: now + REFRESH_TOKEN_EXPIRY },
    key
  );

  return { accessToken, refreshToken };
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
