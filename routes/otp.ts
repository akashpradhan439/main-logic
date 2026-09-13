import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { redisGet, redisSet, redisDel } from "../lib/redis.js";
import { sendOtp, verifyOtp } from "../lib/twilio.js";

const OtpSendSchema = z.object({
  phone: z.string().min(1),
});

const OtpVerifySchema = z.object({
  phone: z.string().min(1),
  code: z.string().min(1),
});

export default async function otpRoutes(app: FastifyInstance) {
  // ─── POST /otp/send ───────────────────────────────────────────────────────
  app.post("/otp/send", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = OtpSendSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Missing phone" });
    }

    const { phone } = parsed.data;
    const countKey = `resend_limit:${phone}`;

    try {
      const resendCount = Number(await redisGet(countKey)) || 0;
      if (resendCount >= 3) {
        return reply.status(429).send({ error: "Too many attempts. Try again later." });
      }

      const result = await sendOtp(phone);
      if (!result.ok) {
        return reply.status(400).send({ success: false, error: result.error });
      }

      if (resendCount === 0) {
        await redisSet(countKey, "1", 300);
      } else {
        await redisSet(countKey, String(resendCount + 1), 300);
      }

      return reply.status(200).send({ success: true, message: "OTP Sent Successfully" });
    } catch (error) {
      req.log.error({ err: error }, "OTP send error");
      return reply.status(500).send({ error: (error as Error).message });
    }
  });

  // ─── POST /otp/verify ─────────────────────────────────────────────────────
  app.post("/otp/verify", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = OtpVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Missing phone or code" });
    }

    const { phone, code } = parsed.data;

    try {
      const result = await verifyOtp(phone, code);

      if (result.status === "approved") {
        await redisDel(`resend_limit:${phone}`);
        return reply.status(200).send({ success: true, message: "Verified successfully" });
      } else {
        return reply.status(401).send({ success: false, message: "Invalid or expired code" });
      }
    } catch (error) {
      req.log.error({ err: error }, "OTP verify error");
      return reply.status(500).send({ error: (error as Error).message });
    }
  });
}
