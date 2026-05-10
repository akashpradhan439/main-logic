import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Redis } from "https://esm.sh/@upstash/redis@1.25.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const redis = new Redis({
  url: Deno.env.get("REDIS_URL")!,
  token: Deno.env.get("REDIS_TOKEN")!,
});

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const VERIFY_SERVICE_SID = Deno.env.get("TWILIO_VERIFY_SERVICE_SID")!;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { country_code, phone_number } = await req.json();
    const fullPhone = `${country_code}${phone_number}`;
    const countKey = `forgot_limit:${fullPhone}`;

    // Rate limiting
    const resendCount = (await redis.get<number>(countKey)) || 0;
    if (resendCount >= 3) {
      return new Response(
        JSON.stringify({ error: "Too many attempts. Try again later." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if user exists
    const { data: user } = await supabase
      .from("users")
      .select("id")
      .eq("country_code", country_code)
      .eq("phone_number", phone_number)
      .maybeSingle();

    // Generic response (don't reveal if user exists)
    if (!user) {
      // Fake delay to prevent timing attacks
      await new Promise((resolve) => setTimeout(resolve, 200));
      return new Response(
        JSON.stringify({ success: true, message: "If this phone is registered, you will receive an OTP" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // User exists - send OTP
    const authHeader = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
    const response = await fetch(
      `https://verify.twilio.com/v2/Services/${VERIFY_SERVICE_SID}/Verifications`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${authHeader}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: fullPhone,
          Channel: "sms",
        }),
      }
    );

    if (response.ok) {
      // Increment rate limit
      if (resendCount === 0) {
        await redis.set(countKey, 1, { ex: 300 });
      } else {
        await redis.incr(countKey);
      }

      return new Response(
        JSON.stringify({ success: true, message: "If this phone is registered, you will receive an OTP" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } else {
      throw new Error("Failed to send OTP");
    }
  } catch (error) {
    console.error("Forgot password OTP error:", error);
    return new Response(
      JSON.stringify({ error: "Something went wrong. Please try again." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
