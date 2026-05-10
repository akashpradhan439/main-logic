import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Redis } from "https://esm.sh/@upstash/redis@1.20.1";
import { create, verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const JWT_SECRET = Deno.env.get("JWT_SECRET")!;
const ACCESS_TOKEN_EXPIRY = 10 * 60; // 10 minutes
const REFRESH_TOKEN_EXPIRY = 30 * 24 * 60 * 60; // 30 days

interface RefreshRequest {
  refresh_token: string;
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

    // Parse request
    const { refresh_token }: RefreshRequest = await req.json();

    if (!refresh_token) {
      return new Response(
        JSON.stringify({ error: "refresh_token is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step A: Verify and decode the JWT refresh token
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );

    let payload;
    try {
      payload = await verify(refresh_token, key);
    } catch (error) {
      console.error("JWT verification failed:", error);
      return new Response(
        JSON.stringify({ error: "Invalid or expired refresh token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate token type
    if (payload.type !== "refresh") {
      return new Response(
        JSON.stringify({ error: "Invalid token type" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = payload.sub as string;
    const userPhone = payload.phone as string;

    // Hash the incoming refresh token
    const incomingTokenHash = await hashToken(refresh_token);

    // Get the live token hash from Redis
    const redisKey = `session:${userPhone}:refresh`;
    const liveTokenHash = await redis.get<string>(redisKey);

    // Check if user is logged in (Redis key exists)
    if (!liveTokenHash) {
      console.warn(`[SESSION EXPIRED] User ${userId} - No active session in Redis`);
      return new Response(
        JSON.stringify({ error: "Session expired. Please log in again." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step A: Check if incoming token matches the live token
    if (liveTokenHash === incomingTokenHash) {
      // LEGITIMATE REQUEST - Proceed with rotation
      console.log(`[VALID] User ${userId} - Token matches live session`);

      // Generate new tokens
      const { accessToken, refreshToken: newRefreshToken } = await generateTokens(
        userId,
        userPhone
      );
      const newTokenHash = await hashToken(newRefreshToken);

      // Store old token in expired_tokens table (for breach detection)
      const { error: insertError } = await supabase
        .from("expired_tokens")
        .insert({
          token_hash: incomingTokenHash,
          user_id: userId,
        });

      if (insertError) {
        console.error("Failed to insert expired token:", insertError);
        // Continue anyway - this is not critical for the flow
      }

      // Update Redis with new token hash (30-day sliding window)
      await redis.setex(redisKey, REFRESH_TOKEN_EXPIRY, newTokenHash);

      return new Response(
        JSON.stringify({
          access_token: accessToken,
          refresh_token: newRefreshToken,
          expires_in: ACCESS_TOKEN_EXPIRY,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step B: BREACH DETECTION - Token doesn't match live session
    console.warn(`[BREACH DETECTION] User ${userId} - Token mismatch`);

    // Check if this token exists in expired_tokens table
    const { data: expiredToken, error: queryError } = await supabase
      .from("expired_tokens")
      .select("token_hash")
      .eq("token_hash", incomingTokenHash)
      .single();

    if (expiredToken) {
      // REPLAY ATTACK DETECTED
      console.error(`[REPLAY ATTACK] User ${userId} - Expired token reused`);

      // Kill the active session
      await redis.del(redisKey);

      // Log the incident
      await supabase.from("security_incidents").insert({
        user_id: userId,
        incident_type: "replay_attack",
        token_hash: incomingTokenHash,
        ip_address: req.headers.get("x-forwarded-for") || "unknown",
        user_agent: req.headers.get("user-agent") || "unknown",
        metadata: {
          timestamp: new Date().toISOString(),
          message: "Attempted reuse of expired refresh token",
        },
      });

      return new Response(
        JSON.stringify({
          error: "Security violation detected. Please log in again.",
          code: "REPLAY_ATTACK",
        }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Token not in Redis AND not in expired_tokens
    console.warn(`[UNKNOWN TOKEN] User ${userId} - Token not found anywhere`);

    return new Response(
      JSON.stringify({
        error: "Invalid session. Please log in again.",
      }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error in refresh endpoint:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function generateTokens(userId: string, phone: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );

  const now = Math.floor(Date.now() / 1000);

  const accessToken = await create(
    { alg: "HS256", typ: "JWT" },
    {
      sub: userId,
      phone: phone,
      type: "access",
      iat: now,
      exp: now + ACCESS_TOKEN_EXPIRY,
    },
    key
  );

  const refreshToken = await create(
    { alg: "HS256", typ: "JWT" },
    {
      sub: userId,
      phone: phone,
      type: "refresh",
      iat: now,
      exp: now + REFRESH_TOKEN_EXPIRY,
    },
    key
  );

  return { accessToken, refreshToken };
}

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex;
}
