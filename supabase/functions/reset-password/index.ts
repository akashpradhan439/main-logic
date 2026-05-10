import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Redis } from "https://esm.sh/@upstash/redis@1.25.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";
import bcrypt from "https://esm.sh/bcryptjs@2.4.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const JWT_SECRET = Deno.env.get("JWT_SECRET")!;
const PEPPER = Deno.env.get("PASSWORD_PEPPER") || "";

const redis = new Redis({
  url: Deno.env.get("REDIS_URL")!,
  token: Deno.env.get("REDIS_TOKEN")!,
});

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { reset_token, new_password } = await req.json();

    if (!reset_token || !new_password) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify reset token
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );

    let payload;
    try {
      payload = await verify(reset_token, key);
    } catch (error) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired reset token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (payload.type !== "password_reset") {
      return new Response(
        JSON.stringify({ error: "Invalid token type" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = payload.sub as string;
    const userPhone = payload.phone as string;

    // Hash new password
    const pepperedPassword = new_password + PEPPER;
    const salt = await bcrypt.genSalt(12);
    const newPasswordHash = await bcrypt.hash(pepperedPassword, salt);

    // Update password
    const { error: updateError } = await supabase
      .from("users")
      .update({ password_hash: newPasswordHash })
      .eq("id", userId);

    if (updateError) {
      console.error("Failed to update password:", updateError);
      return new Response(
        JSON.stringify({ error: "Failed to update password" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Invalidate all sessions (logout from all devices)
    const redisKey = `session:${userPhone}:refresh`;
    await redis.del(redisKey);

    console.log(`[RESET_PASSWORD] Password updated for user ${userId}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Password reset successful. Please login with your new password.",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Reset password error:", error);
    return new Response(
      JSON.stringify({ error: "Something went wrong" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
