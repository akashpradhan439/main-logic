import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Redis } from "https://esm.sh/@upstash/redis@1.20.1";
import bcrypt from "https://esm.sh/bcryptjs@2.4.3";
import { create } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Env Variables
const JWT_SECRET = Deno.env.get("JWT_SECRET")!;
const PEPPER = Deno.env.get("PASSWORD_PEPPER") || "default_pepper_if_not_set";
const ACCESS_TOKEN_EXPIRY = 10 * 60;        // 10 minutes
const REFRESH_TOKEN_EXPIRY = 30 * 24 * 60 * 60; // 30 days
const MAX_FAILED_ATTEMPTS = 3;
const FAILED_ATTEMPT_TTL = 15 * 60; // 15 minutes lockout window

interface SignupRequest {
  country_code: string;
  phone_number: number;
  password: string;
  dob: string;
  first_name: string;
  last_name: string;
  code: String;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const redis = new Redis({
      url: Deno.env.get("REDIS_URL")!,
      token: Deno.env.get("REDIS_TOKEN")!,
    });

    const { country_code, phone_number, password, dob, first_name, last_name, code }: SignupRequest = await req.json();

    // 1. Validation check
    if (!country_code || !phone_number || !password || !dob || !first_name || !last_name || !code) {
       return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers: corsHeaders });
    }

    const phone = `${country_code}${phone_number}`;
    const failedAttemptsKey = `signup:failed:${phone}`;

    // 2. Check if phone is temporarily blocked due to too many failed attempts
    const failedAttempts = await redis.get<number>(failedAttemptsKey);
    if (failedAttempts !== null && failedAttempts >= MAX_FAILED_ATTEMPTS) {
      return new Response(
        JSON.stringify({
          error: "Too many failed signup attempts. Please try again after 15 minutes.",
          retry_after_seconds: FAILED_ATTEMPT_TTL,
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const dobRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dobRegex.test(dob)) {
      return new Response(
        JSON.stringify({ error: "Invalid date format. Use YYYY-MM-DD" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Helper to increment failed attempts in Redis
    const recordFailedAttempt = async () => {
      const current = await redis.incr(failedAttemptsKey);
      // Set TTL only on the first increment so it auto-expires
      if (current === 1) {
        await redis.expire(failedAttemptsKey, FAILED_ATTEMPT_TTL);
      }
      return current;
    };

    // 3. Validate OTP
    const otpResponse = await fetch(
      `${Deno.env.get("SUPABASE_URL")}/functions/v1/otp_validation`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({ phone, code }),
      }
    );

    const otpResult = await otpResponse.json();

    if (!otpResponse.ok || !otpResult.success) {
      const attempts = await recordFailedAttempt();
      const remaining = MAX_FAILED_ATTEMPTS - attempts;
      return new Response(
        JSON.stringify({
          ...otpResult,
          ...(remaining <= 0 && { error: "Too many failed attempts. Account temporarily locked for 15 minutes." }),
        }),
        { status: remaining <= 0 ? 429 : 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Hash password with Pepper
    const salt = await bcrypt.genSalt(12);
    const passwordHash = await bcrypt.hash(password + PEPPER, salt);

    // 5. Insert User
    const { data: newUser, error: insertError } = await supabase
      .from("users")
      .insert({ country_code, phone_number, password_hash: passwordHash, dob, first_name, last_name })
      .select("id, country_code, phone_number")
      .single();

    if (insertError) {
      const isDuplicate = insertError.code === '23505';
      if (!isDuplicate) {
        // Only count non-duplicate DB errors as failed attempts
        await recordFailedAttempt();
      }
      return new Response(
        JSON.stringify({ error: isDuplicate ? "Phone already registered" : "Signup failed" }),
        { status: isDuplicate ? 409 : 500, headers: corsHeaders }
      );
    }

    // 6. Signup succeeded — clear failed attempts counter
    await redis.del(failedAttemptsKey);

    // 7. Generate session tokens
    const { accessToken, refreshToken } = await generateTokens(newUser.id, newUser.country_code, newUser.phone_number);

    // 8. Store refresh token hash in Redis
    const redisKey = `session:${newUser.country_code}${newUser.phone_number}:refresh`;
    const refreshTokenHash = await hashToken(refreshToken);
    await redis.set(redisKey, refreshTokenHash, { ex: REFRESH_TOKEN_EXPIRY });

    return new Response(
      JSON.stringify({
        message: "User created and logged in",
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: ACCESS_TOKEN_EXPIRY,
        user: { id: newUser.id, phone: `${newUser.country_code}${newUser.phone_number}` }
      }),
      { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
});

// Helper Functions
async function generateTokens(userId: string, countryCode: string, phoneNumber: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: userId, phone: `${countryCode}${phoneNumber}`, iat: now };

  const accessToken = await create({ alg: "HS256", typ: "JWT" }, { ...payload, type: "access", exp: now + ACCESS_TOKEN_EXPIRY }, key);
  const refreshToken = await create({ alg: "HS256", typ: "JWT" }, { ...payload, type: "refresh", exp: now + REFRESH_TOKEN_EXPIRY }, key);

  return { accessToken, refreshToken };
}

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
