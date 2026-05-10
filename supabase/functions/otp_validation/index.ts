import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { Redis } from "https://esm.sh/@upstash/redis@1.25.0"

// 1. Define Types for the Request and Twilio Response
interface VerifyRequest {
  phone: string;
  code: string;
}

interface TwilioVerifyCheck {
  status: 'pending' | 'approved' | 'canceled' | 'expired';
  valid: boolean;
}

// 2. Initialize Redis
const redis = new Redis({
  url: Deno.env.get('REDIS_URL')!,
  token: Deno.env.get('REDIS_TOKEN')!,
})

// 3. Setup Twilio Credentials
const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!
const VERIFY_SERVICE_SID = Deno.env.get('TWILIO_VERIFY_SERVICE_SID')!
const authHeader = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)

serve(async (req: Request) => {
  try {
    // 4. Parse and Validate Request
    const { phone, code }: VerifyRequest = await req.json()

    if (!phone || !code) {
      return new Response(
        JSON.stringify({ error: "Missing phone or code" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    // 5. Call Twilio Verification Check API
    const response = await fetch(
      `https://verify.twilio.com/v2/Services/${VERIFY_SERVICE_SID}/VerificationCheck`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: phone,
          Code: code
        }),
      }
    )

    const check: TwilioVerifyCheck = await response.json()

    // 6. Handle Success and Cleanup Redis
    if (check.status === 'approved') {
      // Clear the rate limit counter in Redis so they start fresh next time
      await redis.del(`resend_limit:${phone}`)

      return new Response(
        JSON.stringify({ success: true, message: "Verified successfully" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    } else {
      return new Response(
        JSON.stringify({ success: false, message: "Invalid or expired code" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      )
    }

  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
})
