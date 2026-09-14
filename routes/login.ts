import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { redisGet, redisSet, redisDel } from "../lib/redis.js";
import { config } from "../config.js";

const PEPPER = process.env.PASSWORD_PEPPER || "default_pepper_if_not_set";
const ACCESS_TOKEN_EXPIRY = 10 * 60; // 10 minutes (seconds)
const REFRESH_TOKEN_EXPIRY = 30 * 24 * 60 * 60; // 30 days (seconds)
const FORCE_LOGIN_TOKEN_EXPIRY = 15 * 60; // 15 minutes (seconds)

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

const LoginSchema = z.object({
  country_code: z.string().min(1),
  phone_number: z.string().min(1),
  password: z.string().min(1),
  force_login: z.boolean().optional(),
  force_login_token: z.string().optional(),
});

const GetCountriesSchema = z.object({
  country_code: z.string().optional(),
  search: z.string().optional(),
});

export default async function loginRoutes(app: FastifyInstance) {
  app.post("/login", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.flatten().fieldErrors,
      });
    }

    const { country_code, phone_number, password, force_login, force_login_token } = parsed.data;

    try {
      // 1. Fetch user
      const { rows } = await pool.query(
        `SELECT id, password_hash, country_code, phone_number, language_preference
         FROM users WHERE country_code = $1 AND phone_number = $2`,
        [country_code, phone_number]
      );
      const user = rows[0];

      if (!user) {
        return reply.status(401).send({ error: "Invalid credentials" });
      }

      // 2. Rate limit check
      const failedKey = `failed_login:${country_code}${phone_number}`;
      const failedCount = Number(await redisGet(failedKey)) || 0;
      if (failedCount >= 3) {
        await redisSet(failedKey, String(failedCount + 1), 900);
        return reply.status(429).send({ error: "Too many failed attempts. Try again in 15 minutes." });
      }
      await redisSet(failedKey, String(failedCount + 1), 900);

      // 3. Verify password
      const passwordMatch = await bcrypt.compare(password + PEPPER, user.password_hash);
      if (!passwordMatch) {
        return reply.status(401).send({ error: "Invalid credentials" });
      }

      // 4. Check for existing session
      const sessionKey = `session:${user.country_code}${user.phone_number}:refresh`;
      const existingSession = await redisGet(sessionKey);

      if (existingSession) {
        if (force_login && force_login_token) {
          // 4a. Verify force_login_token
          let payload: any;
          try {
            payload = jwt.verify(force_login_token, config.jwtSecret, { algorithms: ["HS256"] });
          } catch {
            return reply.status(401).send({ error: "Invalid or expired force_login_token" });
          }

          if (payload.type !== "force_login" || payload.sub !== user.id) {
            return reply.status(401).send({ error: "Invalid force_login_token" });
          }

          const forceLoginKey = `force_login:${user.country_code}${user.phone_number}`;
          const storedHash = await redisGet(forceLoginKey);
          const incomingHash = hashToken(force_login_token);

          if (!storedHash || storedHash !== incomingHash) {
            return reply.status(401).send({ error: "Invalid or already used force_login_token" });
          }

          await redisDel(sessionKey);
          await redisDel(forceLoginKey);
        } else {
          // Issue force_login_token, ask client to confirm
          const forceToken = jwt.sign(
            { sub: user.id, type: "force_login" },
            config.jwtSecret,
            { algorithm: "HS256", expiresIn: FORCE_LOGIN_TOKEN_EXPIRY }
          );

          const forceTokenHash = hashToken(forceToken);
          const forceLoginKey = `force_login:${user.country_code}${user.phone_number}`;
          await redisSet(forceLoginKey, forceTokenHash, FORCE_LOGIN_TOKEN_EXPIRY);

          return reply.status(409).send({
            error: "An active session exists on another device.",
            code: "ACTIVE_SESSION_EXISTS",
            force_login_token: forceToken,
          });
        }
      }

      // 5. Generate and store new session tokens
      const { accessToken, refreshToken } = generateTokens(user.id, user.country_code, user.phone_number);
      const refreshTokenHash = hashToken(refreshToken);
      await redisSet(sessionKey, refreshTokenHash, REFRESH_TOKEN_EXPIRY);
      await redisDel(failedKey);

      return reply.status(200).send({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: ACCESS_TOKEN_EXPIRY,
        user: {
          id: user.id,
          phone: `${user.country_code}${user.phone_number}`,
          language_preference: user.language_preference,
        },
      });
    } catch (error) {
      req.log.error({ err: error }, "Login error");
      return reply.status(500).send({ error: (error as Error).message });
    }
  });

  app.post("/get-countries", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = GetCountriesSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
    }

    const { country_code, search } = parsed.data;

    try {
      let sql = "SELECT country_name, country_code, flag_url, phone_code FROM countries";
      const conditions: string[] = [];
      const params: string[] = [];

      if (country_code) {
        params.push(`%${country_code}%`);
        conditions.push(`country_code ILIKE $${params.length}`);
      }

      if (search) {
        params.push(`%${search}%`);
        conditions.push(`country_name ILIKE $${params.length}`);
      }

      if (conditions.length > 0) {
        sql += " WHERE " + conditions.join(" AND ");
      }

      sql += " ORDER BY country_name ASC";

      const { rows } = await pool.query(sql, params);

      return reply.status(200).send({
        success: true,
        data: rows,
        count: rows.length,
      });
    } catch (error) {
      req.log.error({ err: error }, "get-countries error");
      return reply.status(400).send({ success: false, error: (error as Error).message });
    }
  });
}
