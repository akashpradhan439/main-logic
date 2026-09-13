import { config } from "../config.js";

const authHeader = "Basic " + Buffer.from(
  `${config.twilioAccountSid}:${config.twilioAuthToken}`
).toString("base64");

export interface TwilioVerifyResult {
  status: string;
  valid: boolean;
}

export async function sendOtp(phone: string): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch(
    `https://verify.twilio.com/v2/Services/${config.twilioVerifyServiceSid}/Verifications`,
    {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: phone,
        Channel: "sms",
      }),
    }
  );

  if (response.ok) return { ok: true };

  const result = await response.json().catch(() => ({}));
  return { ok: false, error: (result as any).message || "Failed to send OTP" };
}

export async function verifyOtp(phone: string, code: string): Promise<TwilioVerifyResult> {
  const response = await fetch(
    `https://verify.twilio.com/v2/Services/${config.twilioVerifyServiceSid}/VerificationCheck`,
    {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: phone,
        Code: code,
      }),
    }
  );

  const result: TwilioVerifyResult = await response.json();
  return result;
}
