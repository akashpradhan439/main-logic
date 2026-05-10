import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { Redis } from "https://esm.sh/@upstash/redis@1.25.0"

const redis = new Redis({
  url: Deno.env.get('REDIS_URL')!,
  token: Deno.env.get('REDIS_TOKEN')!,
})

const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!
const VERIFY_SERVICE_SID = Deno.env.get('TWILIO_VERIFY_SERVICE_SID')!

serve(async (req) => {
  try {
    const { phone } = await req.json() // Expected format: +919876543210
    const countKey = `resend_limit:${phone}`

    // 1. Rate Limiting via Redis (Max 3 requests per 5 mins)
    const resendCount = await redis.get<number>(countKey) || 0
    if (resendCount >= 3) {
      return new Response(JSON.stringify({ error: "Too many attempts. Try again later." }), { status: 429 })
    }

    // 2. Trigger Twilio Verify (WhatsApp Channel)
    const authHeader = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)
    const response = await fetch(
      `https://verify.twilio.com/v2/Services/${VERIFY_SERVICE_SID}/Verifications`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: phone,
          Channel: 'sms', // Change to 'sms' if needed
        }),
      }
    )

    const result = await response.json()

    if (response.ok) {
      // 3. Increment Redis counter on successful send
      if (resendCount === 0) {
        await redis.set(countKey, 1, { ex: 300 })
      } else {
        await redis.incr(countKey)
      }

      return new Response(JSON.stringify({ success: true, message: "OTP Sent Successfully" }), { status: 200 })
    } else {
      return new Response(JSON.stringify({ success: false, error: result.message }), { status: 400 })
    }

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
