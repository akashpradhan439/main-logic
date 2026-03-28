import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "crypto";
import { supabase } from "../lib/supabase.js";
import {
  connectionRequestsTotal,
  connectionAcceptsTotal,
  connectionBlocksTotal,
} from "../lib/metrics.js";
import { verifyAccessToken, AuthError } from "../shared/auth.js";
import {
  getCanonicalPair,
  findConnectionBetweenUsers,
  getOtherUserId,
  getRejectionCooldownState,
  isPairBlocked,
  type ConnectionRow,
} from "../lib/connections.js";
import { encryptPayload, serializeEncryptedToken, parseEncryptedToken, decryptPayload } from "../lib/encryption.js";
import { redisSet, redisExists, redisDel } from "../lib/redis.js";

const SendRequestSchema = z.object({
  target_user_id: z.string().uuid(),
});

const ListConnectionsQuerySchema = z.object({
  status: z
    .enum(["accepted", "pending", "rejected", "blocked"])
    .optional(),
  role: z.enum(["incoming", "outgoing", "all"]).optional(),
});

const BlockBodySchema = z.object({
  target_user_id: z.string().uuid(),
});

const ScanQRTokenSchema = z.object({
  token: z.string(),
});

const GenerateQRTokenSchema = z.object({}).strict();

export type ConnectionsRouteDeps = {
  supabase: typeof supabase;
  verifyAccessToken: typeof verifyAccessToken;
  AuthError: typeof AuthError;
  encryptPayload: typeof encryptPayload;
  serializeEncryptedToken: typeof serializeEncryptedToken;
  parseEncryptedToken: typeof parseEncryptedToken;
  decryptPayload: typeof decryptPayload;
  redisSet: typeof redisSet;
  redisExists: typeof redisExists;
  redisDel: typeof redisDel;
};

export function createConnectionsRoutes(
  overrides: Partial<ConnectionsRouteDeps> = {}
) {
  const deps: ConnectionsRouteDeps = {
    supabase,
    verifyAccessToken,
    AuthError,
    encryptPayload,
    serializeEncryptedToken,
    parseEncryptedToken,
    decryptPayload,
    redisSet,
    redisExists,
    redisDel,
    ...overrides,
  };

  return async function connectionsRoutes(app: FastifyInstance) {
    const {
      supabase,
      verifyAccessToken,
      AuthError,
      encryptPayload,
      serializeEncryptedToken,
      parseEncryptedToken,
      decryptPayload,
      redisSet,
      redisExists,
      redisDel,
    } = deps;
  // POST /connections/qr/generate - Generate QR code token for connection requests
  app.post("/connections/qr/generate", async (req, reply) => {
    const requestId = req.id;
    const log = req.log;
    const requestStart = process.hrtime.bigint();

    try {
      // Extract and verify access token
      let userId: string;
      try {
        const user = verifyAccessToken(req.headers.authorization);
        userId = user.sub;
      } catch (err) {
        if (err instanceof AuthError) {
          log.info(
            { event: "qr_token_generation_auth_failed", requestId },
            "Authentication failed for QR token generation"
          );
          return reply.status(err.status).send({
            success: false,
            error: req.t("common.errors.auth_required"),
          });
        }
        throw err;
      }

      // Validate request body
      const parsed = GenerateQRTokenSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.flatten().fieldErrors,
        });
      }

      log.info(
        { event: "qr_token_generation_start", userId, requestId },
        "QR token generation initiated"
      );

      try {
        // Generate nonce for replay attack prevention
        const nonce = randomUUID();

        // Calculate expiration time (120 seconds from now)
        const nowSeconds = Math.floor(Date.now() / 1000);
        const expirationSeconds = nowSeconds + 120;

        // Build payload
        const payload = {
          userId,
          nonce,
          exp: expirationSeconds,
        };

        // Encrypt the payload
        const encryptedData = encryptPayload(payload);
        const encryptedToken = serializeEncryptedToken(encryptedData);

        // Store nonce in Redis with 120 second TTL
        const nonceKey = `qr_nonce:${nonce}`;
        await redisSet(nonceKey, "valid", 120);

        log.info(
          { event: "qr_token_generated", userId, nonce, requestId },
          "QR token successfully generated"
        );

        const durationMs =
          Number(process.hrtime.bigint() - requestStart) / 1_000_000;

        return reply.status(200).send({
          success: true,
          data: {
            token: encryptedToken,
            expiresIn: 120, // seconds
          },
        });
      } catch (encryptionError) {
        log.error(
          {
            event: "qr_token_generation_failure",
            userId,
            requestId,
            error: "Failed to process encryption for connection token",
          },
          "Failed to generate QR token"
        );

        return reply.status(500).send({
          success: false,
          error: req.t("connections.errors.generic_failure"),
        });
      }
    } catch (err) {
      log.error(
        {
          event: "qr_token_generation_error",
          requestId,
          error: "An unexpected error occurred during QR token generation",
        },
        "Unexpected error during QR token generation"
      );

      return reply.status(500).send({
        success: false,
        error: req.t("common.errors.unexpected"),
      });
    }
  });

  // POST /connections/qr/scan - Scan and validate QR code token
  app.post("/connections/qr/scan", async (req, reply) => {
    const requestId = req.id;
    const log = req.log;
    const requestStart = process.hrtime.bigint();

    try {
      // Extract and verify access token (scanning user)
      let userId: string;
      try {
        const user = verifyAccessToken(req.headers.authorization);
        userId = user.sub;
      } catch (err) {
        if (err instanceof AuthError) {
          log.info(
            { event: "qr_scan_auth_failed", requestId },
            "Authentication failed for QR scan"
          );
          return reply.status(err.status).send({
            success: false,
            error: req.t("common.errors.auth_required"),
          });
        }
        throw err;
      }

      // Validate request body
      const parsed = ScanQRTokenSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.flatten().fieldErrors,
        });
      }

      const { token } = parsed.data;

      log.info(
        { event: "qr_scan_start", userId, requestId },
        "QR code scan initiated"
      );

      try {

        // Parse and decrypt the token
        const encryptedData = parseEncryptedToken(token);
        const payload = decryptPayload(encryptedData) as {
          userId: string;
          nonce: string;
          exp: number;
        };

        // Validate payload structure
        if (
          !payload.userId ||
          !payload.nonce ||
          typeof payload.exp !== "number"
        ) {
          log.warn(
            {
              event: "qr_scan_invalid_payload",
              userId,
              requestId,
            },
            "Invalid QR token payload structure"
          );
          return reply.status(400).send({
            success: false,
            error: req.t("connections.errors.invalid_qr"),
          });
        }

        // Check expiration
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (nowSeconds > payload.exp) {
          log.warn(
            {
              event: "qr_scan_expired",
              userId,
              targetUserId: payload.userId,
              requestId,
            },
            "QR token has expired"
          );
          return reply.status(400).send({
            success: false,
            error: req.t("connections.errors.qr_expired"),
          });
        }

        // Verify nonce exists in Redis (hasn't been used)
        const nonceKey = `qr_nonce:${payload.nonce}`;
        const nonceExists = await redisExists(nonceKey);

        if (!nonceExists) {
          log.warn(
            {
              event: "qr_scan_invalid_nonce",
              userId,
              targetUserId: payload.userId,
              requestId,
            },
            "QR nonce not found or already used"
          );
          return reply.status(400).send({
            success: false,
            error: req.t("connections.errors.qr_used"),
          });
        }

        const targetUserId = payload.userId;

        // Prevent self-connection
        if (targetUserId === userId) {
          log.warn(
            {
              event: "qr_scan_self_connection",
              userId,
              requestId,
            },
            "User attempted to connect to themselves"
          );
          return reply.status(400).send({
            success: false,
            error: req.t("connections.errors.self_connect"),
          });
        }

        // Verify target user exists
        const targetFetchStart = process.hrtime.bigint();
        const { data: targetUser, error: targetError } = await supabase
          .from("users")
          .select("id")
          .eq("id", targetUserId)
          .single();
        const targetFetchDurationMs =
          Number(process.hrtime.bigint() - targetFetchStart) / 1_000_000;

        if (targetFetchDurationMs > 200) {
          log.warn(
            {
              event: "db_query_slow",
              operation: "fetch_qr_target_user",
              userId,
              targetUserId,
              requestId,
              durationMs: targetFetchDurationMs,
            },
            "Slow DB query detected while fetching QR target user"
          );
        }

        if (targetError || !targetUser) {
          log.error(
            {
              event: "qr_scan_target_not_found",
              userId,
              targetUserId,
              requestId,
              dbError: targetError
                ? {
                    message: targetError.message,
                    details: targetError.details,
                    code: targetError.code,
                  }
                : null,
            },
            "Target user from QR not found"
          );
          return reply.status(404).send({
            success: false,
            error: req.t("connections.errors.target_not_found"),
          });
        }

        // Mark nonce as used (delete from Redis)
        await redisDel(nonceKey);

        // Check for existing connection
        const { row: existing, error: findError } =
          await findConnectionBetweenUsers(supabase, userId, targetUserId);

        if (findError) {
          log.error(
            {
              event: "qr_scan_connection_check_failed",
              userId,
              targetUserId,
              requestId,
              error: "A database error occurred",
            },
            "Failed to check existing connection"
          );
          return reply.status(500).send({
            success: false,
            error: req.t("connections.errors.generic_failure"),
          });
        }

        const { requesterId, addresseeId } = getCanonicalPair(
          userId,
          targetUserId
        );

        // Check if blocked
        if (existing && isPairBlocked(existing)) {
          log.info(
            {
              event: "qr_scan_blocked",
              userId,
              targetUserId,
              requestId,
            },
            "Connection blocked"
          );
          return reply.status(403).send({
            success: false,
            error: req.t("connections.errors.blocked"),
          });
        }

        // Handle existing connection states
        if (existing) {
          if (existing.status === "accepted") {
            log.info(
              {
                event: "qr_scan_already_connected",
                userId,
                targetUserId,
                requestId,
              },
              "Users already connected"
            );
            return reply.status(409).send({
              success: false,
              error: req.t("connections.errors.already_connected"),
            });
          }

          if (existing.status === "pending") {
            // Accept existing pending request from either side
            const { error: acceptError } = await supabase
              .from("connections")
              .update({
                status: "accepted",
                updated_at: new Date().toISOString(),
              })
              .eq("id", existing.id);

            if (acceptError) {
              log.error(
                {
                  event: "qr_scan_accept_failed",
                  userId,
                  targetUserId,
                  requestId,
                  error: "A database error occurred during connection acceptance",
                },
                "Failed to accept connection"
              );
              return reply.status(500).send({
                success: false,
                error: req.t("connections.errors.generic_failure"),
              });
            }

            connectionAcceptsTotal.inc();

            log.info(
              {
                event: "qr_scan_accepted",
                userId,
                targetUserId,
                requestId,
              },
              "Connection accepted via QR scan"
            );

            return reply.status(200).send({
              success: true,
              data: {
                message: req.t("connections.success.accepted"),
                action: "accepted",
              },
            });
          }

          if (existing.status === "rejected") {
            const scannerIsAddressee = existing.addressee_id === userId;
            const cooldown = getRejectionCooldownState(existing.updated_at);

            if (!scannerIsAddressee && cooldown.withinCooldown) {
              log.info(
                {
                  event: "qr_scan_conflict",
                  reason: "rejection_cooldown",
                  userId,
                  targetUserId,
                  requestId,
                  elapsedMs: cooldown.elapsedMs,
                },
                "QR scan blocked by rejection cooldown"
              );
              return reply.status(400).send({
                success: false,
                error: req.t("connections.errors.cooldown"),
              });
            }

            const { error: updateError } = await supabase
              .from("connections")
              .update({
                requester_id: userId,
                addressee_id: targetUserId,
                status: "accepted",
                requester_blocked: false,
                addressee_blocked: false,
                updated_at: new Date().toISOString(),
              })
              .eq("id", existing.id);

            if (updateError) {
              log.error(
                {
                  event: "qr_scan_request_failed",
                  userId,
                  targetUserId,
                  requestId,
                  error: "A database error occurred while updating connection status",
                },
                "Failed to update connection request from rejected"
              );
              return reply.status(500).send({
                success: false,
                error: req.t("connections.errors.generic_failure"),
              });
            }

            connectionAcceptsTotal.inc();

            log.info(
              {
                event: "qr_scan_accepted_from_rejected",
                userId,
                targetUserId,
                requestId,
                reusedExistingRow: true,
                skippedCooldown: scannerIsAddressee,
              },
              "Connection accepted via QR scan"
            );

            return reply.status(200).send({
              success: true,
              data: {
                message: req.t("connections.success.accepted"),
                action: "accepted",
                targetUserId,
              },
            });
          }
        }

        // Create new connection request
        const { error: insertError } = await supabase
          .from("connections")
          .insert({
            requester_id: requesterId,
            addressee_id: addresseeId,
            status: "accepted",
            created_at: new Date().toISOString(),
          });

        if (insertError) {
          log.error(
            {
              event: "qr_scan_request_failed",
              userId,
              targetUserId,
              requestId,
              error: "A database error occurred while creating connection request",
            },
            "Failed to create connection request"
          );
          return reply.status(500).send({
            success: false,
            error: req.t("connections.errors.generic_failure"),
          });
        }

        connectionAcceptsTotal.inc();

        log.info(
          {
            event: "qr_scan_accepted",
            userId,
            targetUserId,
            requestId,
          },
          "Connection accepted via QR"
        );

        const durationMs =
          Number(process.hrtime.bigint() - requestStart) / 1_000_000;

        return reply.status(200).send({
          success: true,
          data: {
            message: req.t("connections.success.accepted"),
            action: "accepted",
            targetUserId,
          },
        });
      } catch (decryptionError) {
        log.error(
          {
            event: "qr_scan_decryption_failed",
            userId,
            requestId,
            error:
              decryptionError instanceof Error
                ? decryptionError.message
                : "Unknown error",
          },
          "Failed to decrypt QR token"
        );

        return reply.status(400).send({
          success: false,
          error: req.t("connections.errors.invalid_qr"),
        });
      }
    } catch (err) {
      log.error(
        {
          event: "qr_scan_error",
          requestId,
          error: "An unexpected error occurred",
        },
        "Unexpected error during QR scan"
      );

      return reply.status(500).send({
        success: false,
        error: req.t("common.errors.unexpected"),
      });
    }
  });

  app.post("/connections/requests", async (req, reply) => {
    const requestId = req.id;
    const log = req.log;
    const requestStart = process.hrtime.bigint();

    try {
      let userId: string;
      try {
        const user = verifyAccessToken(req.headers.authorization);
        userId = user.sub;
      } catch (err) {
        if (err instanceof AuthError) {
          log.info(
            { event: "connection_auth_failed", requestId },
            "Authentication failed"
          );
          return reply.status(err.status).send({
            success: false,
            error: req.t("common.errors.auth_required"),
          });
        }
        throw err;
      }

      log.info(
        { event: "connection_request_start", userId, requestId },
        "connection request received"
      );

      const parsed = SendRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.flatten().fieldErrors,
        });
      }

      const { target_user_id } = parsed.data;

      if (target_user_id === userId) {
        return reply.status(400).send({
          success: false,
          error: "Invalid connection target",
        });
      }

      const targetFetchStart = process.hrtime.bigint();
      const { data: targetUser, error: targetError } = await supabase
        .from("users")
        .select("id")
        .eq("id", target_user_id)
        .single();
      const targetFetchDurationMs =
        Number(process.hrtime.bigint() - targetFetchStart) / 1_000_000;

      if (targetFetchDurationMs > 200) {
        log.warn(
          {
            event: "db_query_slow",
            operation: "fetch_connection_target_user",
            userId,
            targetUserId: target_user_id,
            requestId,
            durationMs: targetFetchDurationMs,
          },
          "Slow DB query detected while fetching target user"
        );
      }

      if (targetError || !targetUser) {
        log.error(
          {
            event: "connection_request_failure",
            userId,
            targetUserId: target_user_id,
            requestId,
            dbError: targetError
              ? {
                  message: targetError.message,
                  details: targetError.details,
                  hint: targetError.hint,
                  code: targetError.code,
                }
              : null,
          },
          "Failed to fetch target user for connection"
        );
        return reply.status(404).send({
          success: false,
          error: req.t("connections.errors.generic_failure"),
        });
      }

      const { row: existing, error: findError } =
        await findConnectionBetweenUsers(supabase, userId, target_user_id);

      if (findError) {
        log.error(
          {
            event: "connection_request_failure",
            userId,
            targetUserId: target_user_id,
            requestId,
            error: "A database error occurred",
          },
          "Failed to fetch existing connection row"
        );
        return reply.status(500).send({
          success: false,
          error: req.t("common.errors.unable_to_process"),
        });
      }

      const { requesterId, addresseeId } = getCanonicalPair(
        userId,
        target_user_id
      );

      if (existing && isPairBlocked(existing)) {
        log.info(
          {
            event: "connection_request_blocked",
            userId,
            targetUserId: target_user_id,
            requestId,
          },
          "Connection request blocked by existing block state"
        );
        return reply.status(403).send({
          success: false,
          error: req.t("connections.errors.blocked"),
        });
      }

      if (existing) {
        const callerIsRequester = existing.requester_id === userId;

        if (existing.status === "accepted") {
          log.info(
            {
              event: "connection_request_conflict",
              reason: "already_accepted",
              userId,
              targetUserId: target_user_id,
              requestId,
            },
            "Connection already accepted"
          );
          return reply.status(409).send({
            success: false,
            error: req.t("connections.errors.already_connected"),
          });
        }

        if (existing.status === "pending") {
          if (callerIsRequester) {
            log.info(
              {
                event: "connection_request_conflict",
                reason: "duplicate_pending",
                userId,
                targetUserId: target_user_id,
                requestId,
              },
              "Duplicate pending connection request"
            );
            return reply.status(409).send({
              success: false,
              error: req.t("connections.errors.generic_failure"),
            });
          }

          log.info(
            {
              event: "connection_request_can_accept",
              userId,
              targetUserId: target_user_id,
              connectionId: existing.id,
              requestId,
            },
            "Existing pending request can be accepted by caller"
          );

          return reply.status(200).send({
            success: true,
            connectionId: existing.id,
            status: existing.status,
            can_accept: true,
          });
        }

        if (existing.status === "rejected") {
          const cooldown = getRejectionCooldownState(existing.updated_at);

          if (cooldown.withinCooldown) {
            log.info(
              {
                event: "connection_request_conflict",
                reason: "rejection_cooldown",
                userId,
                targetUserId: target_user_id,
                requestId,
                elapsedMs: cooldown.elapsedMs,
              },
              "Connection request blocked by rejection cooldown"
            );
            return reply.status(400).send({
              success: false,
              error: req.t("connections.errors.cooldown"),
            });
          }

          const { error: updateError } = await supabase
            .from("connections")
            .update({
              requester_id: userId,
              addressee_id: target_user_id,
              status: "pending",
              requester_blocked: false,
              addressee_blocked: false,
              updated_at: new Date().toISOString(),
            })
            .eq("id", existing.id);

          if (updateError) {
            log.error(
              {
                event: "connection_request_failure",
                userId,
                targetUserId: target_user_id,
                requestId,
                dbError: {
                  message: updateError.message,
                  details: updateError.details,
                  hint: updateError.hint,
                  code: updateError.code,
                },
              },
              "Failed to update connection row from rejected to pending"
            );
            return reply.status(500).send({
              success: false,
              error: req.t("common.errors.unable_to_process"),
            });
          }

          connectionRequestsTotal.inc();

          const requestDurationMs =
            Number(process.hrtime.bigint() - requestStart) / 1_000_000;

          log.info(
            {
              event: "connection_request_created",
              userId,
              targetUserId: target_user_id,
              connectionId: existing.id,
              requestId,
              durationMs: requestDurationMs,
              reusedExistingRow: true,
            },
            "Connection request created from rejected state"
          );

          return reply.status(200).send({
            success: true,
            connectionId: existing.id,
            status: "pending",
          });
        }
      }

      const { error: insertError, data: inserted } = await supabase
        .from("connections")
        .insert({
          requester_id: userId,
          addressee_id: target_user_id,
          status: "pending",
          requester_blocked: false,
          addressee_blocked: false,
          updated_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      if (insertError || !inserted) {
        log.error(
          {
            event: "connection_request_failure",
            userId,
            targetUserId: target_user_id,
            requestId,
            dbError: insertError
              ? {
                  message: insertError.message,
                  details: insertError.details,
                  hint: insertError.hint,
                  code: insertError.code,
                }
              : null,
          },
          "Failed to insert new connection request"
        );
        return reply.status(500).send({
          success: false,
          error: req.t("common.errors.unable_to_process"),
        });
      }

      connectionRequestsTotal.inc();

      const requestDurationMs =
        Number(process.hrtime.bigint() - requestStart) / 1_000_000;

      log.info(
        {
          event: "connection_request_created",
          userId,
          targetUserId: target_user_id,
          connectionId: inserted.id,
          requestId,
          durationMs: requestDurationMs,
          reusedExistingRow: false,
        },
        "Connection request created"
      );

      return reply.status(200).send({
        success: true,
        connectionId: inserted.id,
        status: "pending",
      });
    } catch (err) {
      const requestDurationMs =
        Number(process.hrtime.bigint() - requestStart) / 1_000_000;

      req.log.error(
        {
          event: "connection_request_error",
          requestId,
          durationMs: requestDurationMs,
          err,
        },
        "Unexpected error in connection request handler"
      );
      return reply.status(500).send({
        success: false,
        error: req.t("common.errors.unable_to_process"),
      });
    }
  });

  app.get("/connections", async (req, reply) => {
    const requestId = req.id;
    const log = req.log;
    const requestStart = process.hrtime.bigint();

    try {
      let userId: string;
      try {
        const user = verifyAccessToken(req.headers.authorization);
        userId = user.sub;
      } catch (err) {
        if (err instanceof AuthError) {
          log.info(
            { event: "connection_auth_failed", requestId },
            "Authentication failed"
          );
          return reply.status(err.status).send({
            success: false,
            error: req.t("common.errors.auth_required"),
          });
        }
        throw err;
      }

      const parsed = ListConnectionsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.flatten().fieldErrors,
        });
      }

      const status = parsed.data.status;
      const role = parsed.data.role ?? "all";

      let query = supabase
        .from("connections")
        .select(
          `id, 
           requester_id, 
           addressee_id, 
           status, 
           requester_blocked, 
           addressee_blocked,
           requester:users!requester_id(first_name, last_name),
           addressee:users!addressee_id(first_name, last_name)`
        );
      
      if (status) {
        query = query.eq("status", status);
      }

      if (role === "incoming") {
        query = query.eq("addressee_id", userId);
      } else if (role === "outgoing") {
        query = query.eq("requester_id", userId);
      } else {
        query = query.or(
          `requester_id.eq.${userId},addressee_id.eq.${userId}`
        );
      }

      const fetchStart = process.hrtime.bigint();
      const { data, error } = await query;
      const fetchDurationMs =
        Number(process.hrtime.bigint() - fetchStart) / 1_000_000;

      if (fetchDurationMs > 200) {
        log.warn(
          {
            event: "db_query_slow",
            operation: "list_connections",
            userId,
            requestId,
            durationMs: fetchDurationMs,
          },
          "Slow DB query detected while listing connections"
        );
      }

      if (error) {
        log.error(
          {
            event: "connection_list_failure",
            userId,
            requestId,
            dbError: {
              message: error.message,
              details: error.details,
              hint: error.hint,
              code: error.code,
            },
          },
          "Failed to list connections"
        );
        return reply.status(500).send({
          success: false,
          error: req.t("common.errors.unable_to_process"),
        });
      }

      type ConnectionWithUsers = ConnectionRow & {
        requester?: { first_name: string; last_name: string };
        addressee?: { first_name: string; last_name: string };
      };

      const rows = (data as unknown as ConnectionWithUsers[] | null) ?? [];
      const connections = rows
        .map((row) => {
          const otherUserId = getOtherUserId(row, userId);
          if (!otherUserId) {
            return null;
          }
          const otherUser =
            otherUserId === row.requester_id ? row.requester : row.addressee;

          let action_text = "";
          if (row.status === "accepted") {
            action_text =
              userId === row.requester_id
                ? "Request sent by you"
                : "Received request";
          }

          return {
            connection_id: row.id,
            user_id: otherUserId,
            first_name: otherUser?.first_name ?? null,
            last_name: otherUser?.last_name ?? null,
            status: row.status,
            action_text: action_text || undefined,
          };
        })
        .filter((x) => x !== null);

      const requestDurationMs =
        Number(process.hrtime.bigint() - requestStart) / 1_000_000;

      log.info(
        {
          event: "connection_list_fetched",
          userId,
          requestId,
          status: status || "all",
          role,
          count: connections.length,
          durationMs: requestDurationMs,
        },
        "Connections listed"
      );

      return reply.status(200).send({
        success: true,
        connections,
      });
    } catch (err) {
      const requestDurationMs =
        Number(process.hrtime.bigint() - requestStart) / 1_000_000;

      req.log.error(
        {
          event: "connection_list_error",
          requestId,
          durationMs: requestDurationMs,
          err,
        },
        "Unexpected error in list connections handler"
      );
      return reply.status(500).send({
        success: false,
        error: req.t("common.errors.unable_to_process"),
      });
    }
  });

  app.get("/connections/requests", async (req, reply) => {
    const requestId = req.id;
    const log = req.log;
    const requestStart = process.hrtime.bigint();

    try {
      let userId: string;
      try {
        const user = verifyAccessToken(req.headers.authorization);
        userId = user.sub;
      } catch (err) {
        if (err instanceof AuthError) {
          log.info(
            { event: "connection_auth_failed", requestId },
            "Authentication failed"
          );
          return reply.status(err.status).send({
            success: false,
            error: req.t("common.errors.auth_required"),
          });
        }
        throw err;
      }

      const parsed = ListConnectionsQuerySchema.pick({
        role: true,
      }).safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.flatten().fieldErrors,
        });
      }

      const role = parsed.data.role ?? "incoming";

      let query = supabase
        .from("connections")
        .select(
          `id, 
           requester_id, 
           addressee_id, 
           status,
           requester:users!requester_id(first_name, last_name),
           addressee:users!addressee_id(first_name, last_name)`
        )
        .eq("status", "pending");

      if (role === "incoming") {
        query = query.eq("addressee_id", userId);
      } else if (role === "outgoing") {
        query = query.eq("requester_id", userId);
      } else {
        query = query.or(
          `requester_id.eq.${userId},addressee_id.eq.${userId}`
        );
      }

      const fetchStart = process.hrtime.bigint();
      const { data, error } = await query;
      const fetchDurationMs =
        Number(process.hrtime.bigint() - fetchStart) / 1_000_000;

      if (fetchDurationMs > 200) {
        log.warn(
          {
            event: "db_query_slow",
            operation: "list_pending_connections",
            userId,
            requestId,
            durationMs: fetchDurationMs,
          },
          "Slow DB query detected while listing pending connections"
        );
      }

      if (error) {
        log.error(
          {
            event: "connection_list_failure",
            userId,
            requestId,
            dbError: {
              message: error.message,
              details: error.details,
              hint: error.hint,
              code: error.code,
            },
          },
          "Failed to list pending connections"
        );
        return reply.status(500).send({
          success: false,
          error: req.t("common.errors.unable_to_process"),
        });
      }

      type ConnectionWithUsers = ConnectionRow & {
        requester?: { first_name: string; last_name: string };
        addressee?: { first_name: string; last_name: string };
      };

      const rows = (data as unknown as ConnectionWithUsers[] | null) ?? [];
      const connections = rows
        .map((row) => {
          const otherUserId = getOtherUserId(row, userId);
          if (!otherUserId) {
            return null;
          }
          const otherUser =
            otherUserId === row.requester_id ? row.requester : row.addressee;
          return {
            connection_id: row.id,
            user_id: otherUserId,
            first_name: otherUser?.first_name ?? null,
            last_name: otherUser?.last_name ?? null,
            status: row.status,
          };
        })
        .filter((x) => x !== null);

      const requestDurationMs =
        Number(process.hrtime.bigint() - requestStart) / 1_000_000;

      log.info(
        {
          event: "connection_list_fetched",
          userId,
          requestId,
          status: "accepted",
          role,
          count: connections.length,
          durationMs: requestDurationMs,
        },
        "Pending connections listed"
      );

      return reply.status(200).send({
        success: true,
        connections,
      });
    } catch (err) {
      const requestDurationMs =
        Number(process.hrtime.bigint() - requestStart) / 1_000_000;

      req.log.error(
        {
          event: "connection_list_error",
          requestId,
          durationMs: requestDurationMs,
          err,
        },
        "Unexpected error in list pending connections handler"
      );
      return reply.status(500).send({
        success: false,
        error: req.t("common.errors.unable_to_process"),
      });
    }
  });

  app.post(
    "/connections/requests/:connectionId/accept",
    async (req, reply) => {
      const requestId = req.id;
      const log = req.log;
      const requestStart = process.hrtime.bigint();

      try {
        let userId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          userId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            log.info(
              { event: "connection_auth_failed", requestId },
              "Authentication failed"
            );
            return reply.status(err.status).send({
              success: false,
              error: req.t("common.errors.auth_required"),
            });
          }
          throw err;
        }

        const connectionId = String(
          (req.params as { connectionId: string }).connectionId
        );

        const fetchStart = process.hrtime.bigint();
        const { data, error } = await supabase
          .from("connections")
          .select(
            "id, requester_id, addressee_id, status, requester_blocked, addressee_blocked"
          )
          .eq("id", connectionId)
          .single();
        const fetchDurationMs =
          Number(process.hrtime.bigint() - fetchStart) / 1_000_000;

        if (fetchDurationMs > 200) {
          log.warn(
            {
              event: "db_query_slow",
              operation: "fetch_connection_for_accept",
              userId,
              connectionId,
              requestId,
              durationMs: fetchDurationMs,
            },
            "Slow DB query detected while fetching connection to accept"
          );
        }

        if (error || !data) {
          log.info(
            {
              event: "connection_request_accept_not_found",
              userId,
              connectionId,
              requestId,
            },
            "Connection to accept not found"
          );
          return reply.status(404).send({
            success: false,
            error: req.t("common.errors.unable_to_process"),
          });
        }

        const row = data as ConnectionRow;

        if (isPairBlocked(row)) {
          log.info(
            {
              event: "connection_request_accept_blocked",
              userId,
              connectionId,
              requestId,
            },
            "Connection accept blocked by existing block state"
          );
          return reply.status(403).send({
            success: false,
            error: req.t("common.errors.unable_to_process"),
          });
        }

        if (row.status !== "pending" || row.addressee_id !== userId) {
          log.info(
            {
              event: "connection_request_accept_invalid_state",
              userId,
              connectionId,
              status: row.status,
              addresseeId: row.addressee_id,
              requestId,
            },
            "Connection cannot be accepted in current state"
          );
          return reply.status(403).send({
            success: false,
            error: req.t("common.errors.unable_to_process"),
          });
        }

        const { error: updateError } = await supabase
          .from("connections")
          .update({
            status: "accepted",
            updated_at: new Date().toISOString(),
          })
          .eq("id", connectionId);

        if (updateError) {
          log.error(
            {
              event: "connection_request_accept_failure",
              userId,
              connectionId,
              requestId,
              dbError: {
                message: updateError.message,
                details: updateError.details,
                hint: updateError.hint,
                code: updateError.code,
              },
            },
            "Failed to accept connection request"
          );
          return reply.status(500).send({
            success: false,
            error: req.t("common.errors.unable_to_process"),
          });
        }

        connectionAcceptsTotal.inc();

        const requestDurationMs =
          Number(process.hrtime.bigint() - requestStart) / 1_000_000;

        log.info(
          {
            event: "connection_request_accepted",
            userId,
            connectionId,
            requestId,
            durationMs: requestDurationMs,
          },
          "Connection request accepted"
        );

        return reply.status(200).send({
          success: true,
          status: "accepted",
        });
      } catch (err) {
        const requestDurationMs =
          Number(process.hrtime.bigint() - requestStart) / 1_000_000;

        req.log.error(
          {
            event: "connection_request_accept_error",
            requestId,
            durationMs: requestDurationMs,
            err,
          },
          "Unexpected error in accept connection request handler"
        );
        return reply.status(500).send({
          success: false,
          error: req.t("common.errors.unable_to_process"),
        });
      }
    }
  );

  app.post(
    "/connections/requests/:connectionId/reject",
    async (req, reply) => {
      const requestId = req.id;
      const log = req.log;
      const requestStart = process.hrtime.bigint();

      try {
        let userId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          userId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            log.info(
              { event: "connection_auth_failed", requestId },
              "Authentication failed"
            );
            return reply.status(err.status).send({
              success: false,
              error: req.t("common.errors.auth_required"),
            });
          }
          throw err;
        }

        const connectionId = String(
          (req.params as { connectionId: string }).connectionId
        );

        const fetchStart = process.hrtime.bigint();
        const { data, error } = await supabase
          .from("connections")
          .select(
            "id, requester_id, addressee_id, status, requester_blocked, addressee_blocked"
          )
          .eq("id", connectionId)
          .single();
        const fetchDurationMs =
          Number(process.hrtime.bigint() - fetchStart) / 1_000_000;

        if (fetchDurationMs > 200) {
          log.warn(
            {
              event: "db_query_slow",
              operation: "fetch_connection_for_reject",
              userId,
              connectionId,
              requestId,
              durationMs: fetchDurationMs,
            },
            "Slow DB query detected while fetching connection to reject"
          );
        }

        if (error || !data) {
          log.info(
            {
              event: "connection_request_reject_not_found",
              userId,
              connectionId,
              requestId,
            },
            "Connection to reject not found"
          );
          return reply.status(404).send({
            success: false,
            error: req.t("common.errors.unable_to_process"),
          });
        }

        const row = data as ConnectionRow;

        if (isPairBlocked(row)) {
          log.info(
            {
              event: "connection_request_reject_blocked",
              userId,
              connectionId,
              requestId,
            },
            "Connection reject blocked by existing block state"
          );
          return reply.status(403).send({
            success: false,
            error: req.t("common.errors.unable_to_process"),
          });
        }

        if (row.status !== "pending" || row.addressee_id !== userId) {
          log.info(
            {
              event: "connection_request_reject_invalid_state",
              userId,
              connectionId,
              status: row.status,
              addresseeId: row.addressee_id,
              requestId,
            },
            "Connection cannot be rejected in current state"
          );
          return reply.status(403).send({
            success: false,
            error: req.t("common.errors.unable_to_process"),
          });
        }

        const { error: updateError } = await supabase
          .from("connections")
          .update({
            status: "rejected",
            updated_at: new Date().toISOString(),
          })
          .eq("id", connectionId);

        if (updateError) {
          log.error(
            {
              event: "connection_request_reject_failure",
              userId,
              connectionId,
              requestId,
              dbError: {
                message: updateError.message,
                details: updateError.details,
                hint: updateError.hint,
                code: updateError.code,
              },
            },
            "Failed to reject connection request"
          );
          return reply.status(500).send({
            success: false,
            error: req.t("common.errors.unable_to_process"),
          });
        }

        const requestDurationMs =
          Number(process.hrtime.bigint() - requestStart) / 1_000_000;

        log.info(
          {
            event: "connection_request_rejected",
            userId,
            connectionId,
            requestId,
            durationMs: requestDurationMs,
          },
          "Connection request rejected"
        );

        return reply.status(200).send({
          success: true,
          status: "rejected",
        });
      } catch (err) {
        const requestDurationMs =
          Number(process.hrtime.bigint() - requestStart) / 1_000_000;

        req.log.error(
          {
            event: "connection_request_reject_error",
            requestId,
            durationMs: requestDurationMs,
            err,
          },
          "Unexpected error in reject connection request handler"
        );
        return reply.status(500).send({
          success: false,
          error: req.t("common.errors.unable_to_process"),
        });
      }
    }
  );

  app.post(
    "/connections/requests/:connectionId/cancel",
    async (req, reply) => {
      const requestId = req.id;
      const log = req.log;
      const requestStart = process.hrtime.bigint();

      try {
        let userId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          userId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            log.info(
              { event: "connection_auth_failed", requestId },
              "Authentication failed"
            );
            return reply.status(err.status).send({
              success: false,
              error: req.t("common.errors.auth_required"),
            });
          }
          throw err;
        }

        const connectionId = String(
          (req.params as { connectionId: string }).connectionId
        );

        const fetchStart = process.hrtime.bigint();
        const { data, error } = await supabase
          .from("connections")
          .select(
            "id, requester_id, addressee_id, status, requester_blocked, addressee_blocked"
          )
          .eq("id", connectionId)
          .single();
        const fetchDurationMs =
          Number(process.hrtime.bigint() - fetchStart) / 1_000_000;

        if (fetchDurationMs > 200) {
          log.warn(
            {
              event: "db_query_slow",
              operation: "fetch_connection_for_cancel",
              userId,
              connectionId,
              requestId,
              durationMs: fetchDurationMs,
            },
            "Slow DB query detected while fetching connection to cancel"
          );
        }

        if (error || !data) {
          log.info(
            {
              event: "connection_request_cancel_not_found",
              userId,
              connectionId,
              requestId,
            },
            "Connection to cancel not found"
          );
          return reply.status(404).send({
            success: false,
            error: req.t("common.errors.unable_to_process"),
          });
        }

        const row = data as ConnectionRow;

        if (isPairBlocked(row)) {
          log.info(
            {
              event: "connection_request_cancel_blocked",
              userId,
              connectionId,
              requestId,
            },
            "Connection cancel blocked by existing block state"
          );
          return reply.status(403).send({
            success: false,
            error: req.t("common.errors.unable_to_process"),
          });
        }

        if (row.status !== "pending" || row.requester_id !== userId) {
          log.info(
            {
              event: "connection_request_cancel_invalid_state",
              userId,
              connectionId,
              status: row.status,
              requesterId: row.requester_id,
              requestId,
            },
            "Connection cannot be cancelled in current state"
          );
          return reply.status(403).send({
            success: false,
            error: req.t("common.errors.unable_to_process"),
          });
        }

        const { error: deleteError } = await supabase
          .from("connections")
          .delete()
          .eq("id", connectionId);

        if (deleteError) {
          log.error(
            {
              event: "connection_request_cancel_failure",
              userId,
              connectionId,
              requestId,
              dbError: {
                message: deleteError.message,
                details: deleteError.details,
                hint: deleteError.hint,
                code: deleteError.code,
              },
            },
            "Failed to cancel connection request"
          );
          return reply.status(500).send({
            success: false,
            error: req.t("common.errors.unable_to_process"),
          });
        }

        const requestDurationMs =
          Number(process.hrtime.bigint() - requestStart) / 1_000_000;

        log.info(
          {
            event: "connection_request_cancelled",
            userId,
            connectionId,
            requestId,
            durationMs: requestDurationMs,
          },
          "Connection request cancelled"
        );

        return reply.status(200).send({
          success: true,
        });
      } catch (err) {
        const requestDurationMs =
          Number(process.hrtime.bigint() - requestStart) / 1_000_000;

        req.log.error(
          {
            event: "connection_request_cancel_error",
            requestId,
            durationMs: requestDurationMs,
            err,
          },
          "Unexpected error in cancel connection request handler"
        );
        return reply.status(500).send({
          success: false,
          error: req.t("common.errors.unable_to_process"),
        });
      }
    }
  );

  app.delete("/connections/:connectionId", async (req, reply) => {
    const requestId = req.id;
    const log = req.log;
    const requestStart = process.hrtime.bigint();

    try {
      let userId: string;
      try {
        const user = verifyAccessToken(req.headers.authorization);
        userId = user.sub;
      } catch (err) {
        if (err instanceof AuthError) {
          log.info(
            { event: "connection_auth_failed", requestId },
            "Authentication failed"
          );
          return reply.status(err.status).send({
            success: false,
            error: req.t("common.errors.auth_required"),
          });
        }
        throw err;
      }

      const connectionId = String(
        (req.params as { connectionId: string }).connectionId
      );

      const fetchStart = process.hrtime.bigint();
      const { data, error } = await supabase
        .from("connections")
        .select(
          "id, requester_id, addressee_id, status, requester_blocked, addressee_blocked"
        )
        .eq("id", connectionId)
        .single();
      const fetchDurationMs =
        Number(process.hrtime.bigint() - fetchStart) / 1_000_000;

      if (fetchDurationMs > 200) {
        log.warn(
          {
            event: "db_query_slow",
            operation: "fetch_connection_for_delete",
            userId,
            connectionId,
            requestId,
            durationMs: fetchDurationMs,
          },
          "Slow DB query detected while fetching connection to delete"
        );
      }

      if (error || !data) {
        log.info(
          {
            event: "connection_remove_not_found",
            userId,
            connectionId,
            requestId,
          },
          "Connection to remove not found"
        );
        return reply.status(404).send({
          success: false,
          error: req.t("common.errors.unable_to_process"),
        });
      }

      const row = data as ConnectionRow;

      if (isPairBlocked(row)) {
        log.info(
          {
            event: "connection_remove_blocked",
            userId,
            connectionId,
            requestId,
          },
          "Connection remove blocked by existing block state"
        );
        return reply.status(403).send({
          success: false,
          error: req.t("common.errors.unable_to_process"),
        });
      }

      if (row.status !== "accepted") {
        log.info(
          {
            event: "connection_remove_invalid_state",
            userId,
            connectionId,
            status: row.status,
            requestId,
          },
          "Connection cannot be removed in current state"
        );
        return reply.status(403).send({
          success: false,
          error: req.t("common.errors.unable_to_process"),
        });
      }

      if (row.requester_id !== userId && row.addressee_id !== userId) {
        log.info(
          {
            event: "connection_remove_not_participant",
            userId,
            connectionId,
            requesterId: row.requester_id,
            addresseeId: row.addressee_id,
            requestId,
          },
          "Connection cannot be removed by non-participant"
        );
        return reply.status(403).send({
          success: false,
          error: req.t("common.errors.unable_to_process"),
        });
      }

      const { error: deleteError } = await supabase
        .from("connections")
        .delete()
        .eq("id", connectionId);

      if (deleteError) {
        log.error(
          {
            event: "connection_remove_failure",
            userId,
            connectionId,
            requestId,
            dbError: {
              message: deleteError.message,
              details: deleteError.details,
              hint: deleteError.hint,
              code: deleteError.code,
            },
          },
          "Failed to remove connection"
        );
        return reply.status(500).send({
          success: false,
          error: req.t("common.errors.unable_to_process"),
        });
      }

      const requestDurationMs =
        Number(process.hrtime.bigint() - requestStart) / 1_000_000;

      log.info(
        {
          event: "connection_removed",
          userId,
          connectionId,
          requestId,
          durationMs: requestDurationMs,
        },
        "Connection removed"
      );

      return reply.status(200).send({
        success: true,
      });
    } catch (err) {
      const requestDurationMs =
        Number(process.hrtime.bigint() - requestStart) / 1_000_000;

      req.log.error(
        {
          event: "connection_remove_error",
          requestId,
          durationMs: requestDurationMs,
          err,
        },
        "Unexpected error in remove connection handler"
      );
      return reply.status(500).send({
        success: false,
        error: req.t("common.errors.unable_to_process"),
      });
    }
  });

  app.post("/connections/block", async (req, reply) => {
    const requestId = req.id;
    const log = req.log;
    const requestStart = process.hrtime.bigint();

    try {
      let userId: string;
      try {
        const user = verifyAccessToken(req.headers.authorization);
        userId = user.sub;
      } catch (err) {
        if (err instanceof AuthError) {
          log.info(
            { event: "connection_auth_failed", requestId },
            "Authentication failed"
          );
          return reply.status(err.status).send({
            success: false,
            error: req.t("common.errors.auth_required"),
          });
        }
        throw err;
      }

      const parsed = BlockBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.flatten().fieldErrors,
        });
      }

      const { target_user_id } = parsed.data;

      if (target_user_id === userId) {
        return reply.status(400).send({
          success: false,
          error: "Invalid connection target",
        });
      }

      const targetFetchStart = process.hrtime.bigint();
      const { data: targetUser, error: targetError } = await supabase
        .from("users")
        .select("id")
        .eq("id", target_user_id)
        .single();
      const targetFetchDurationMs =
        Number(process.hrtime.bigint() - targetFetchStart) / 1_000_000;

      if (targetFetchDurationMs > 200) {
        log.warn(
          {
            event: "db_query_slow",
            operation: "fetch_block_target_user",
            userId,
            targetUserId: target_user_id,
            requestId,
            durationMs: targetFetchDurationMs,
          },
          "Slow DB query detected while fetching block target user"
        );
      }

      if (targetError || !targetUser) {
        log.error(
          {
            event: "connection_block_failure",
            userId,
            targetUserId: target_user_id,
            requestId,
            dbError: targetError
              ? {
                  message: targetError.message,
                  details: targetError.details,
                  hint: targetError.hint,
                  code: targetError.code,
                }
              : null,
          },
          "Failed to fetch block target user"
        );
        return reply.status(404).send({
          success: false,
          error: req.t("common.errors.unable_to_process"),
        });
      }

      const { row: existing, error: findError } =
        await findConnectionBetweenUsers(supabase, userId, target_user_id);

      if (findError) {
        log.error(
          {
            event: "connection_block_failure",
            userId,
            targetUserId: target_user_id,
            requestId,
            error: "A database error occurred",
          },
          "Failed to fetch existing connection row for block"
        );
        return reply.status(500).send({
          success: false,
          error: req.t("common.errors.unable_to_process"),
        });
      }

      const { requesterId, addresseeId } = getCanonicalPair(
        userId,
        target_user_id
      );
      const callerIsRequester = requesterId === userId;

      if (!existing) {
        const { error: insertError } = await supabase
          .from("connections")
          .insert({
            requester_id: requesterId,
            addressee_id: addresseeId,
            status: "blocked",
            requester_blocked: callerIsRequester,
            addressee_blocked: !callerIsRequester,
            updated_at: new Date().toISOString(),
          });

        if (insertError) {
          log.error(
            {
              event: "connection_block_failure",
              userId,
              targetUserId: target_user_id,
              requestId,
              dbError: {
                message: insertError.message,
                details: insertError.details,
                hint: insertError.hint,
                code: insertError.code,
              },
            },
            "Failed to insert block connection row"
          );
          return reply.status(500).send({
            success: false,
            error: req.t("common.errors.unable_to_process"),
          });
        }

        connectionBlocksTotal.inc();

        const requestDurationMs =
          Number(process.hrtime.bigint() - requestStart) / 1_000_000;

        log.info(
          {
            event: "connection_blocked",
            userId,
            targetUserId: target_user_id,
            requestId,
            durationMs: requestDurationMs,
          },
          "Connection blocked (new row)"
        );

        return reply.status(200).send({
          success: true,
        });
      }

      const currentRequesterBlocked = existing.requester_blocked === true;
      const currentAddresseeBlocked = existing.addressee_blocked === true;

      const nextRequesterBlocked = callerIsRequester
        ? true
        : currentRequesterBlocked;
      const nextAddresseeBlocked = callerIsRequester
        ? currentAddresseeBlocked
        : true;

      if (
        currentRequesterBlocked === nextRequesterBlocked &&
        currentAddresseeBlocked === nextAddresseeBlocked &&
        existing.status === "blocked"
      ) {
        const requestDurationMs =
          Number(process.hrtime.bigint() - requestStart) / 1_000_000;

        log.info(
          {
            event: "connection_block_idempotent",
            userId,
            targetUserId: target_user_id,
            requestId,
            durationMs: requestDurationMs,
          },
          "Connection block is idempotent"
        );

        return reply.status(200).send({
          success: true,
        });
      }

      const { error: updateError } = await supabase
        .from("connections")
        .update({
          requester_id: requesterId,
          addressee_id: addresseeId,
          status: "blocked",
          requester_blocked: nextRequesterBlocked,
          addressee_blocked: nextAddresseeBlocked,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);

      if (updateError) {
        log.error(
          {
            event: "connection_block_failure",
            userId,
            targetUserId: target_user_id,
            requestId,
            dbError: {
              message: updateError.message,
              details: updateError.details,
              hint: updateError.hint,
              code: updateError.code,
            },
          },
          "Failed to update connection row for block"
        );
        return reply.status(500).send({
          success: false,
          error: req.t("common.errors.unable_to_process"),
        });
      }

      connectionBlocksTotal.inc();

      const requestDurationMs =
        Number(process.hrtime.bigint() - requestStart) / 1_000_000;

      log.info(
        {
          event: "connection_blocked",
          userId,
          targetUserId: target_user_id,
          requestId,
          durationMs: requestDurationMs,
        },
        "Connection blocked"
      );

      return reply.status(200).send({
        success: true,
      });
    } catch (err) {
      const requestDurationMs =
        Number(process.hrtime.bigint() - requestStart) / 1_000_000;

      req.log.error(
        {
          event: "connection_block_error",
          requestId,
          durationMs: requestDurationMs,
          err,
        },
        "Unexpected error in block connection handler"
      );
      return reply.status(500).send({
        success: false,
        error: req.t("common.errors.unable_to_process"),
      });
    }
  });

  app.post("/connections/unblock", async (req, reply) => {
    const requestId = req.id;
    const log = req.log;
    const requestStart = process.hrtime.bigint();

    try {
      let userId: string;
      try {
        const user = verifyAccessToken(req.headers.authorization);
        userId = user.sub;
      } catch (err) {
        if (err instanceof AuthError) {
          log.info(
            { event: "connection_auth_failed", requestId },
            "Authentication failed"
          );
          return reply.status(err.status).send({
            success: false,
            error: req.t("common.errors.auth_required"),
          });
        }
        throw err;
      }

      const parsed = BlockBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.flatten().fieldErrors,
        });
      }

      const { target_user_id } = parsed.data;

      if (target_user_id === userId) {
        return reply.status(400).send({
          success: false,
          error: "Invalid connection target",
        });
      }

      const { row: existing, error: findError } =
        await findConnectionBetweenUsers(supabase, userId, target_user_id);

      if (findError) {
        log.error(
          {
            event: "connection_unblock_failure",
            userId,
            targetUserId: target_user_id,
            requestId,
            error: "A database error occurred",
          },
          "Failed to fetch existing connection row for unblock"
        );
        return reply.status(500).send({
          success: false,
          error: req.t("common.errors.unable_to_process"),
        });
      }

      if (!existing || !isPairBlocked(existing)) {
        const requestDurationMs =
          Number(process.hrtime.bigint() - requestStart) / 1_000_000;

        log.info(
          {
            event: "connection_unblock_idempotent",
            userId,
            targetUserId: target_user_id,
            requestId,
            durationMs: requestDurationMs,
          },
          "Unblock is idempotent; no blocked connection found"
        );

        return reply.status(200).send({
          success: true,
        });
      }

      const { requesterId, addresseeId } = getCanonicalPair(
        userId,
        target_user_id
      );
      const callerIsRequester = requesterId === userId;

      const currentRequesterBlocked = existing.requester_blocked === true;
      const currentAddresseeBlocked = existing.addressee_blocked === true;

      const callerHasBlock = callerIsRequester
        ? currentRequesterBlocked
        : currentAddresseeBlocked;

      if (!callerHasBlock) {
        log.info(
          {
            event: "connection_unblock_forbidden",
            userId,
            targetUserId: target_user_id,
            requestId,
          },
          "Caller attempted to unblock but does not own the block"
        );
        return reply.status(403).send({
          success: false,
          error: "Unable to perform this action",
        });
      }

      const nextRequesterBlocked = callerIsRequester
        ? false
        : currentRequesterBlocked;
      const nextAddresseeBlocked = callerIsRequester
        ? currentAddresseeBlocked
        : false;

      if (!nextRequesterBlocked && !nextAddresseeBlocked) {
        const { error: deleteError } = await supabase
          .from("connections")
          .delete()
          .eq("id", existing.id);

        if (deleteError) {
          log.error(
            {
              event: "connection_unblock_failure",
              userId,
              targetUserId: target_user_id,
              requestId,
              dbError: {
                message: deleteError.message,
                details: deleteError.details,
                hint: deleteError.hint,
                code: deleteError.code,
              },
            },
            "Failed to delete connection row on unblock"
          );
          return reply.status(500).send({
            success: false,
            error: "Unable to perform this action",
          });
        }
      } else {
        const { error: updateError } = await supabase
          .from("connections")
          .update({
            requester_id: requesterId,
            addressee_id: addresseeId,
            status: "blocked",
            requester_blocked: nextRequesterBlocked,
            addressee_blocked: nextAddresseeBlocked,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);

        if (updateError) {
          log.error(
            {
              event: "connection_unblock_failure",
              userId,
              targetUserId: target_user_id,
              requestId,
              dbError: {
                message: updateError.message,
                details: updateError.details,
                hint: updateError.hint,
                code: updateError.code,
              },
            },
            "Failed to update connection row on unblock"
          );
          return reply.status(500).send({
            success: false,
            error: "Unable to perform this action",
          });
        }
      }

      const requestDurationMs =
        Number(process.hrtime.bigint() - requestStart) / 1_000_000;

      log.info(
        {
          event: "connection_unblocked",
          userId,
          targetUserId: target_user_id,
          requestId,
          durationMs: requestDurationMs,
        },
        "Connection unblocked"
      );

      return reply.status(200).send({
        success: true,
      });
    } catch (err) {
      const requestDurationMs =
        Number(process.hrtime.bigint() - requestStart) / 1_000_000;

      req.log.error(
        {
          event: "connection_unblock_error",
          requestId,
          durationMs: requestDurationMs,
          err,
        },
        "Unexpected error in unblock connection handler"
      );
      return reply.status(500).send({
        success: false,
        error: "Unable to perform this action",
      });
    }
  });
}
}

export default createConnectionsRoutes();
