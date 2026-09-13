import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { redisGet, redisSet, redisDel } from "../lib/redis.js";
import { config } from "../config.js";
import { sendOtp, verifyOtp } from "../lib/twilio.js";

const PEPPER = config.passwordPepper;
const ACCESS_TOKEN_EXPIRY = 10 * 60;
const REFRESH_TOKEN_EXPIRY = 30 * 24 * 60 * 60;
const FORCE_LOGIN_TOKEN_EXPIRY = 15 * 60;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateTokens(userId: string, countryCode: string, phoneNumber: string) {
  const sub = `${countryCode}${phoneNumber}`;
  const accessToken = jwt.sign(
    { sub: userId, phone: sub, type: "access" },
    config.jwtSecret,
    { algorithm: "HS256", expiresIn: ACCESS_TOKEN_EXPIRY }
  );
  const refreshToken = jwt.sign(
    { sub: userId, phone: sub, type: "refresh" },
    config.jwtSecret,
    { algorithm: "HS256", expiresIn: REFRESH_TOKEN_EXPIRY }
  );
  return { accessToken, refreshToken };
}

const SignupSchema = z.object({
  country_code: z.string().min(1),
  phone_number: z.string().min(1),
  password: z.string().min(1),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  code: z.string().min(1),
  language_preference: z.string().optional(),
});

const ForgotPasswordSchema = z.object({
  country_code: z.string().min(1),
  phone_number: z.string().min(1),
});

const ForgotPasswordVerifySchema = z.object({
  country_code: z.string().min(1),
  phone_number: z.string().min(1),
  otp_code: z.string().min(1),
});

const ResetPasswordSchema = z.object({
  reset_token: z.string().min(1),
  new_password: z.string().min(1),
});

const RefreshTokenSchema = z.object({
  refresh_token: z.string().min(1),
});

export default async function authRoutes(app: FastifyInstance) {
  // ─── POST /signup ─────────────────────────────────────────────────────────
  app.post("/signup", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = SignupSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
    }

    const { country_code, phone_number, password, dob, first_name, last_name, code, language_preference } = parsed.data;
    const phone = `${country_code}${phone_number}`;
    const failedAttemptsKey = `signup:failed:${phone}`;

    try {
      // 1. Rate limit check
      const failedAttempts = Number(await redisGet(failedAttemptsKey)) || 0;
      if (failedAttempts >= 3) {
        return reply.status(429).send({
          error: "Too many failed signup attempts. Please try again after 15 minutes.",
          retry_after_seconds: 900,
        });
      }

      // 2. Validate OTP
      const otpResult = await verifyOtp(phone, code);
      if (otpResult.status !== "approved") {
        const current = Number(await redisGet(failedAttemptsKey)) || 0;
        await redisSet(failedAttemptsKey, String(current + 1), 900);
        const remaining = 3 - (current + 1);
        return reply.status(remaining <= 0 ? 429 : 401).send({
          success: false,
          message: "Invalid or expired OTP",
          ...(remaining <= 0 && { error: "Too many failed attempts. Account temporarily locked for 15 minutes." }),
        });
      }

      // 3. Hash password
      const salt = await bcrypt.genSalt(12);
      const passwordHash = await bcrypt.hash(password + PEPPER, salt);

      // 4. Insert user
      const languagePreference = language_preference || "en";
      const { rows } = await pool.query(
        `INSERT INTO users (country_code, phone_number, password_hash, dob, first_name, last_name, language_preference)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, country_code, phone_number, language_preference`,
        [country_code, phone_number, passwordHash, dob, first_name, last_name, languagePreference]
      );

      const newUser = rows[0];

      // 5. Clear failed attempts
      await redisDel(failedAttemptsKey);

      // 6. Generate tokens
      const { accessToken, refreshToken } = generateTokens(newUser.id, newUser.country_code, newUser.phone_number);
      const refreshTokenHash = hashToken(refreshToken);
      await redisSet(`session:${newUser.country_code}${newUser.phone_number}:refresh`, refreshTokenHash, REFRESH_TOKEN_EXPIRY);

      return reply.status(201).send({
        message: "User created and logged in",
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: ACCESS_TOKEN_EXPIRY,
        user: {
          id: newUser.id,
          phone: `${newUser.country_code}${newUser.phone_number}`,
          language_preference: newUser.language_preference,
        },
      });
    } catch (error: any) {
      if (error.code === "23505") {
        return reply.status(409).send({ error: "Phone already registered" });
      }
      req.log.error({ err: error }, "Signup error");
      return reply.status(500).send({ error: error.message });
    }
  });

  // ─── POST /logout ─────────────────────────────────────────────────────────
  app.post("/logout", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return reply.status(401).send({ error: "Missing or invalid Authorization header" });
      }

      const token = authHeader.replace("Bearer ", "").trim();
      let payload: any;
      try {
        payload = jwt.verify(token, config.jwtSecret);
      } catch {
        return reply.status(401).send({ error: "Invalid access token" });
      }

      if (payload.type !== "access") {
        return reply.status(401).send({ error: "Invalid token type" });
      }

      const userPhone = payload.phone as string;
      await redisDel(`session:${userPhone}:refresh`);

      return reply.status(200).send({ message: "Logged out successfully" });
    } catch (error) {
      req.log.error({ err: error }, "Logout error");
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // ─── POST /refresh-token ──────────────────────────────────────────────────
  app.post("/refresh-token", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = RefreshTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "refresh_token is required" });
    }

    const { refresh_token } = parsed.data;

    try {
      let payload: any;
      try {
        payload = jwt.verify(refresh_token, config.jwtSecret);
      } catch {
        return reply.status(401).send({ error: "Invalid or expired refresh token" });
      }

      if (payload.type !== "refresh") {
        return reply.status(401).send({ error: "Invalid token type" });
      }

      const userId = payload.sub as string;
      const userPhone = payload.phone as string;
      const incomingTokenHash = hashToken(refresh_token);
      const redisKey = `session:${userPhone}:refresh`;
      const liveTokenHash = await redisGet(redisKey);

      if (!liveTokenHash) {
        return reply.status(401).send({ error: "Session expired. Please log in again." });
      }

      if (liveTokenHash === incomingTokenHash) {
        // Legitimate request — rotate tokens
        const accessToken = jwt.sign(
          { sub: userId, phone: userPhone, type: "access" },
          config.jwtSecret,
          { algorithm: "HS256", expiresIn: ACCESS_TOKEN_EXPIRY }
        );
        const newRefreshToken = jwt.sign(
          { sub: userId, phone: userPhone, type: "refresh" },
          config.jwtSecret,
          { algorithm: "HS256", expiresIn: REFRESH_TOKEN_EXPIRY }
        );
        const newTokenHash = hashToken(newRefreshToken);

        // Store old token in expired_tokens (breach detection)
        await pool.query(
          "INSERT INTO expired_tokens (token_hash, user_id) VALUES ($1, $2)",
          [incomingTokenHash, userId]
        ).catch(() => {});

        await redisSet(redisKey, newTokenHash, REFRESH_TOKEN_EXPIRY);

        return reply.status(200).send({
          access_token: accessToken,
          refresh_token: newRefreshToken,
          expires_in: ACCESS_TOKEN_EXPIRY,
        });
      }

      // Token mismatch — check for replay attack
      const { rows } = await pool.query(
        "SELECT token_hash FROM expired_tokens WHERE token_hash = $1",
        [incomingTokenHash]
      );

      if (rows.length > 0) {
        // Replay attack
        await redisDel(redisKey);
        await pool.query(
          `INSERT INTO security_incidents (user_id, incident_type, token_hash, ip_address, user_agent, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            userId,
            "replay_attack",
            incomingTokenHash,
            req.headers["x-forwarded-for"] || "unknown",
            req.headers["user-agent"] || "unknown",
            JSON.stringify({ timestamp: new Date().toISOString(), message: "Attempted reuse of expired refresh token" }),
          ]
        ).catch(() => {});

        return reply.status(401).send({
          error: "Security violation detected. Please log in again.",
          code: "REPLAY_ATTACK",
        });
      }

      return reply.status(401).send({ error: "Invalid session. Please log in again." });
    } catch (error) {
      req.log.error({ err: error }, "Refresh token error");
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // ─── POST /forgot-password ────────────────────────────────────────────────
  app.post("/forgot-password", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = ForgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
    }

    const { country_code, phone_number } = parsed.data;
    const fullPhone = `${country_code}${phone_number}`;
    const countKey = `forgot_limit:${fullPhone}`;

    try {
      const resendCount = Number(await redisGet(countKey)) || 0;
      if (resendCount >= 3) {
        return reply.status(429).send({ error: "Too many attempts. Try again later." });
      }

      // Check if user exists (don't reveal)
      const { rows } = await pool.query(
        "SELECT id FROM users WHERE country_code = $1 AND phone_number = $2",
        [country_code, phone_number]
      );

      if (rows.length === 0) {
        // Fake delay
        await new Promise((r) => setTimeout(r, 200));
        return reply.status(200).send({ success: true, message: "If this phone is registered, you will receive an OTP" });
      }

      // Send OTP
      const result = await sendOtp(fullPhone);
      if (!result.ok) {
        return reply.status(500).send({ error: "Failed to send OTP" });
      }

      if (resendCount === 0) {
        await redisSet(countKey, "1", 300);
      } else {
        await redisSet(countKey, String(resendCount + 1), 300);
      }

      return reply.status(200).send({ success: true, message: "If this phone is registered, you will receive an OTP" });
    } catch (error) {
      req.log.error({ err: error }, "Forgot password error");
      return reply.status(500).send({ error: "Something went wrong. Please try again." });
    }
  });

  // ─── POST /forgot-password-otp-verify ─────────────────────────────────────
  app.post("/forgot-password-otp-verify", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = ForgotPasswordVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
    }

    const { country_code, phone_number, otp_code } = parsed.data;
    const fullPhone = `${country_code}${phone_number}`;

    try {
      const result = await verifyOtp(fullPhone, otp_code);
      if (result.status !== "approved") {
        return reply.status(401).send({ error: "Invalid or expired OTP" });
      }

      // OTP verified — find user
      const { rows } = await pool.query(
        "SELECT id, country_code, phone_number FROM users WHERE country_code = $1 AND phone_number = $2",
        [country_code, phone_number]
      );

      if (rows.length === 0) {
        return reply.status(400).send({ error: "Invalid request" });
      }

      const user = rows[0];

      // Issue 10-minute reset token
      const resetToken = jwt.sign(
        { sub: user.id, phone: fullPhone, type: "password_reset" },
        config.jwtSecret,
        { algorithm: "HS256", expiresIn: 600 }
      );

      return reply.status(200).send({
        success: true,
        reset_token: resetToken,
        expires_in: 600,
      });
    } catch (error) {
      req.log.error({ err: error }, "Forgot password OTP verify error");
      return reply.status(500).send({ error: "Something went wrong" });
    }
  });

  // ─── POST /reset-password ─────────────────────────────────────────────────
  app.post("/reset-password", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = ResetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Missing required fields" });
    }

    const { reset_token, new_password } = parsed.data;

    try {
      let payload: any;
      try {
        payload = jwt.verify(reset_token, config.jwtSecret);
      } catch {
        return reply.status(401).send({ error: "Invalid or expired reset token" });
      }

      if (payload.type !== "password_reset") {
        return reply.status(401).send({ error: "Invalid token type" });
      }

      const userId = payload.sub as string;
      const userPhone = payload.phone as string;

      // Hash new password
      const salt = await bcrypt.genSalt(12);
      const newPasswordHash = await bcrypt.hash(new_password + PEPPER, salt);

      // Update password
      const { rowCount } = await pool.query(
        "UPDATE users SET password_hash = $1 WHERE id = $2",
        [newPasswordHash, userId]
      );

      if (!rowCount) {
        return reply.status(500).send({ error: "Failed to update password" });
      }

      // Invalidate all sessions
      await redisDel(`session:${userPhone}:refresh`);

      return reply.status(200).send({
        success: true,
        message: "Password reset successful. Please login with your new password.",
      });
    } catch (error) {
      req.log.error({ err: error }, "Reset password error");
      return reply.status(500).send({ error: "Something went wrong" });
    }
  });
}
