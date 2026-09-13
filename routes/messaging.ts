import type { FastifyInstance } from "fastify";
import pg from "pg";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { publishNewMessage } from "../lib/rabbitmq.js";
import type { MessageEnvelope } from "../shared/types.js";
import { decodeEnvelope } from "../shared/types.js";
import type { BootstrapJson } from "../lib/messaging.js";
import {
  messagesSentTotal,
  messagesPublishFailuresTotal,
} from "../lib/metrics.js";
import { verifyAccessToken, AuthError } from "../shared/auth.js";
import {
  findOrCreateConversation,
  insertMessage,
  getConversationMessages,
  getConversationBootstrap,
  verifyConversationParticipant,
  getOtherParticipant,
  type ConversationRow,
  type MessageRow,
} from "../lib/messaging.js";
import { findConnectionBetweenUsers, isPairBlocked } from "../lib/connections.js";
import { usersWithUsableBundles } from "../lib/keys.js";
import { getConnection } from "../lib/sseManager.js";

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const CreateConversationSchema = z.object({
  otherUserId: z.string().uuid(),
});

const MessageHistoryQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const SendMessageSchema = z.object({
  envelope: z.object({
    header: z.object({
      dhPublicKey: z.any(),
      n: z.number(),
      pn: z.number(),
    }),
    ciphertext: z.any(),
    bootstrap: z
      .object({
        senderIdentityKey:   z.string().min(1),
        senderEphemeralKey:  z.string().min(1),
        pqCiphertext:        z.string().min(1),
        signedPrekeyId:      z.number().int().positive(),
        pqSignedPrekeyId:    z.number().int().positive(),
        oneTimePrekeyId:     z.number().int().nonnegative().optional(),
        pqOneTimePrekeyId:   z.number().int().nonnegative().optional(),
        usedOTPPublicKey:    z.string().min(1).optional(),
        usedPQOTPPublicKey:  z.string().min(1).optional(),
      })
      .optional(),
  }),
  attachmentUrl: z.string().url().nullable().default(null),
  attachmentType: z.string().nullable().default(null),
});

function toUint8Array(input: unknown): Uint8Array | null {
  if (input instanceof Uint8Array) return input;

  if (typeof input === "string") {
    try {
      return Uint8Array.from(Buffer.from(input, "base64"));
    } catch {
      return null;
    }
  }

  if (Array.isArray(input)) {
    if (input.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
      return Uint8Array.from(input as number[]);
    }
    return null;
  }

  if (input && typeof input === "object") {
    const maybeBuffer = input as { type?: unknown; data?: unknown };
    if (
      maybeBuffer.type === "Buffer" &&
      Array.isArray(maybeBuffer.data) &&
      maybeBuffer.data.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
    ) {
      return Uint8Array.from(maybeBuffer.data as number[]);
    }
  }

  return null;
}

function normalizeEnvelopeForStorage(envelope: {
  header: { dhPublicKey: unknown; n: number; pn: number };
  ciphertext: unknown;
  bootstrap?: {
    senderIdentityKey:  string;
    senderEphemeralKey: string;
    pqCiphertext:       string;
    signedPrekeyId:     number;
    pqSignedPrekeyId:   number;
    oneTimePrekeyId?:   number | undefined;
    pqOneTimePrekeyId?: number | undefined;
  } | undefined;
}): MessageEnvelope | null {
  const dhPublicKey = toUint8Array(envelope.header.dhPublicKey);
  const ciphertext  = toUint8Array(envelope.ciphertext);
  if (!dhPublicKey || !ciphertext) return null;

  const MAX_ENVELOPE_SIZE = 65536;
  if (dhPublicKey.length !== 32) return null;
  if (ciphertext.length > MAX_ENVELOPE_SIZE) return null;

  const result: MessageEnvelope = {
    header:    { dhPublicKey, n: envelope.header.n, pn: envelope.header.pn },
    ciphertext,
  };

  if (envelope.bootstrap) {
    const senderIdentityKey  = toUint8Array(envelope.bootstrap.senderIdentityKey);
    const senderEphemeralKey = toUint8Array(envelope.bootstrap.senderEphemeralKey);
    const pqCiphertext       = toUint8Array(envelope.bootstrap.pqCiphertext);
    if (!senderIdentityKey || !senderEphemeralKey || !pqCiphertext) return null;
    result.bootstrap = {
      senderIdentityKey,
      senderEphemeralKey,
      pqCiphertext,
      signedPrekeyId:    envelope.bootstrap.signedPrekeyId,
      pqSignedPrekeyId:  envelope.bootstrap.pqSignedPrekeyId,
      oneTimePrekeyId:   envelope.bootstrap.oneTimePrekeyId ?? 0,
      pqOneTimePrekeyId: envelope.bootstrap.pqOneTimePrekeyId ?? 0,
    };
  }

  return result;
}

// ─── Dependency Injection ─────────────────────────────────────────────────────

export type MessagingRouteDeps = {
  pool: pg.Pool;
  verifyAccessToken: typeof verifyAccessToken;
  AuthError: typeof AuthError;
  findConnectionBetweenUsers: typeof findConnectionBetweenUsers;
  isPairBlocked: typeof isPairBlocked;
  findOrCreateConversation: typeof findOrCreateConversation;
  insertMessage: typeof insertMessage;
  getConversationMessages: typeof getConversationMessages;
  getConversationBootstrap: typeof getConversationBootstrap;
  verifyConversationParticipant: typeof verifyConversationParticipant;
  getOtherParticipant: typeof getOtherParticipant;
  publishNewMessage: typeof publishNewMessage;
  usersWithUsableBundles: typeof usersWithUsableBundles;
};

export function createMessagingRoutes(
  overrides: Partial<MessagingRouteDeps> = {}
) {
  const deps: MessagingRouteDeps = {
    pool,
    verifyAccessToken,
    AuthError,
    findConnectionBetweenUsers,
    isPairBlocked,
    findOrCreateConversation,
    insertMessage,
    getConversationMessages,
    getConversationBootstrap,
    verifyConversationParticipant,
    getOtherParticipant,
    publishNewMessage,
    usersWithUsableBundles,
    ...overrides,
  };

  return async function messagingRoutes(app: FastifyInstance) {
    const {
      pool,
      verifyAccessToken,
      AuthError,
      findConnectionBetweenUsers,
      isPairBlocked,
      findOrCreateConversation,
      insertMessage,
      getConversationMessages,
      getConversationBootstrap,
      verifyConversationParticipant,
      getOtherParticipant,
      publishNewMessage,
      usersWithUsableBundles,
    } = deps;

    // ─── REST: Create / Get Conversation ──────────────────────────────────

    app.post("/messaging/conversations", async (req, reply) => {
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
            log.info({ event: "auth_failed", requestId }, "Authentication failed");
            return reply.status(err.status).send({ success: false, error: req.t("common.errors.auth_required") });
          }
          throw err;
        }

        const parsed = CreateConversationSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.status(400).send({ success: false, error: parsed.error.flatten().fieldErrors });
        }

        const { otherUserId } = parsed.data;

        if (otherUserId === userId) {
          return reply.status(400).send({ success: false, error: req.t("messaging.errors.self_conversation") });
        }

        log.info(
          { event: "conversation_create_start", userId, otherUserId, requestId },
          "Creating conversation"
        );

        const { row: connection, error: connError } = await findConnectionBetweenUsers(
          pool, userId, otherUserId
        );

        if (connError) {
          log.error(
            { event: "conversation_create_failure", userId, otherUserId, requestId, err: connError.message },
            "Failed to check connection"
          );
          return reply.status(500).send({ success: false, error: req.t("messaging.errors.generic_failure") });
        }

        if (!connection || connection.status !== "accepted" || isPairBlocked(connection)) {
          return reply.status(403).send({ success: false, error: req.t("messaging.errors.not_connected") });
        }

        const { conversation, error, created } = await findOrCreateConversation(
          pool, userId, otherUserId, log
        );

        if (error || !conversation) {
          log.error(
            { event: "conversation_create_failure", userId, otherUserId, requestId },
            "Failed to create conversation"
          );
          return reply.status(500).send({ success: false, error: req.t("messaging.errors.generic_failure") });
        }

        const requestDurationMs = Number(process.hrtime.bigint() - requestStart) / 1_000_000;
        log.info(
          { event: "conversation_create_success", conversationId: conversation.id, userId, otherUserId, created, requestId, durationMs: requestDurationMs },
          "Conversation ready"
        );

        const readySet = await usersWithUsableBundles(pool, [otherUserId]);

        return reply.status(created ? 201 : 200).send({
          success: true,
          conversation: {
            id: conversation.id,
            otherUserId,
            createdAt: conversation.created_at,
            updatedAt: conversation.updated_at,
            signalReady: readySet.has(otherUserId),
          }
        });
      } catch (err) {
        const requestDurationMs = Number(process.hrtime.bigint() - requestStart) / 1_000_000;
        log.error(
          { event: "conversation_create_error", requestId, durationMs: requestDurationMs, err },
          "Unexpected error creating conversation"
        );
        return reply.status(500).send({ success: false, error: req.t("messaging.errors.generic_failure") });
      }
    });

    // ─── REST: List Conversations ─────────────────────────────────────────

    app.get("/messaging/conversations", async (req, reply) => {
      const requestId = req.id;
      const log = req.log;

      try {
        let userId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          userId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            return reply.status(err.status).send({ success: false, error: req.t("common.errors.auth_required") });
          }
          throw err;
        }

        log.info({ event: "conversations_list_start", userId, requestId }, "Listing conversations");

        const { rows: data } = await pool.query(
          `SELECT c.id, c.participant_one, c.participant_two, c.initiator_user_id, c.created_at, c.updated_at,
                  p1.first_name as p1_first_name, p1.last_name as p1_last_name,
                  p2.first_name as p2_first_name, p2.last_name as p2_last_name
           FROM conversations c
           LEFT JOIN users p1 ON c.participant_one = p1.id
           LEFT JOIN users p2 ON c.participant_two = p2.id
           WHERE c.participant_one = $1 OR c.participant_two = $1
           ORDER BY c.updated_at DESC`,
          [userId]
        );

        const otherUserIds = (data ?? []).map((conv) =>
          conv.participant_one === userId ? conv.participant_two : conv.participant_one
        );
        const readySet = await usersWithUsableBundles(pool, otherUserIds);

        const conversations = await Promise.all((data ?? []).map(async (conv) => {
          const isP1 = conv.participant_one === userId;
          const otherUserId = isP1 ? conv.participant_two : conv.participant_one;
          const otherUserProfile = isP1
            ? { first_name: conv.p2_first_name, last_name: conv.p2_last_name }
            : { first_name: conv.p1_first_name, last_name: conv.p1_last_name };

          const { rows: lastMsgRows } = await pool.query(
            `SELECT id, envelope, sender_id, created_at, attachment_url, attachment_type
             FROM messages
             WHERE conversation_id = $1
             ORDER BY created_at DESC
             LIMIT 1`,
            [conv.id]
          );
          const lastMsg = lastMsgRows[0] ?? null;

          let decodedEnvelope: MessageEnvelope | null = null;
          if (lastMsg?.envelope) {
            try {
              if (typeof lastMsg.envelope === "string") {
                const raw = Uint8Array.from(Buffer.from(lastMsg.envelope, "base64"));
                decodedEnvelope = decodeEnvelope(raw);
              } else if (lastMsg.envelope instanceof Uint8Array) {
                decodedEnvelope = decodeEnvelope(lastMsg.envelope);
              } else if (lastMsg.envelope.header && lastMsg.envelope.ciphertext) {
                decodedEnvelope = lastMsg.envelope;
              }
            } catch {
              decodedEnvelope = null;
            }
          }

          return {
            id: conv.id,
            otherUserId,
            otherUserFirstName: otherUserProfile?.first_name || null,
            otherUserLastName: otherUserProfile?.last_name || null,
            initiatorUserId: conv.initiator_user_id ?? null,
            createdAt: conv.created_at,
            updatedAt: conv.updated_at,
            signalReady: readySet.has(otherUserId),
            lastMessage: lastMsg ? {
              id: lastMsg.id,
              envelope: decodedEnvelope,
              senderId: lastMsg.sender_id,
              createdAt: lastMsg.created_at,
              attachmentUrl: lastMsg.attachment_url,
              attachmentType: lastMsg.attachment_type,
            } : null,
          };
        }));

        log.info(
          { event: "conversations_list_success", userId, requestId, count: conversations.length },
          "Conversations listed"
        );

        return reply.status(200).send({ success: true, conversations });
      } catch (err) {
        log.error(
          { event: "conversations_list_error", requestId, err },
          "Unexpected error listing conversations"
        );
        return reply.status(500).send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });

    // ─── REST: Send Message ───────────────────────────────────────────────

    app.post("/messaging/conversations/:id/messages", {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    }, async (req, reply) => {
      const requestId = req.id;
      const log = req.log;
      const { id: conversationId } = req.params as { id: string };

      try {
        let userId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          userId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            return reply.status(err.status).send({ success: false, error: req.t("common.errors.auth_required") });
          }
          throw err;
        }

        const parsed = SendMessageSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.status(400).send({ success: false, error: parsed.error.flatten().fieldErrors });
        }

        const { envelope, attachmentUrl, attachmentType } = parsed.data;
        const normalizedEnvelope = normalizeEnvelopeForStorage(envelope);
        if (!normalizedEnvelope) {
          return reply.status(400).send({ success: false, error: req.t("messaging.errors.invalid_envelope") });
        }

        const { isParticipant, isBlocked, conversation, error: verifyError } = await verifyConversationParticipant(
          pool, conversationId, userId
        );

        if (verifyError) {
          log.error(
            { event: "send_message_verify_error", conversationId, userId, requestId, err: verifyError.message },
            "Failed to verify participant"
          );
          return reply.status(500).send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

        if (!isParticipant || !conversation) {
          return reply.status(403).send({ success: false, error: req.t("messaging.errors.not_participant") });
        }

        if (isBlocked) {
          return reply.status(403).send({ success: false, error: req.t("messaging.errors.blocked_send") });
        }

        // C4: when a bootstrap is present, the sender claims an identity key the
        // recipient will trust as the conversation initiator. Bind it to the JWT
        // user by checking it matches the IK on record, so a sender cannot forge
        // the conversation as if started by someone else.
        if (envelope.bootstrap) {
          const { rows: senderPrekeyRows } = await pool.query(
            `SELECT identity_key_public FROM user_prekeys WHERE user_id = $1 LIMIT 1`,
            [userId]
          );
          const senderPrekeys = senderPrekeyRows[0] ?? null;

          if (!senderPrekeys?.identity_key_public || senderPrekeys.identity_key_public !== envelope.bootstrap.senderIdentityKey) {
            log.warn(
              { event: "send_message_ik_mismatch", conversationId, userId, requestId },
              "Bootstrap sender identity key does not match the authenticated user"
            );
            return reply.status(403).send({ success: false, error: req.t("messaging.errors.identity_mismatch") });
          }
        }

        const bootstrapJson: BootstrapJson | null = envelope.bootstrap ?? null;

        const { message, initiatorUserId, error: insertError } = await insertMessage(
          pool,
          conversationId,
          userId,
          normalizedEnvelope,
          attachmentUrl,
          attachmentType,
          bootstrapJson,
          log
        );

        if (insertError || !message) {
          log.error(
            { event: "send_message_insert_error", conversationId, userId, requestId },
            "Failed to insert message"
          );
          return reply.status(500).send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

        messagesSentTotal.inc();

        const recipientId = getOtherParticipant(conversation, userId);
        if (recipientId) {
          const sseConn = getConnection(recipientId);
          let sseSent = false;
          if (sseConn) {
            const sseEvent: Record<string, unknown> = {
              type: "new_message",
              conversationId,
              messageId: message.id,
              senderId: userId,
              // Canonical initiator so the recipient can deterministically choose
              // initiator vs responder role and avoid the simultaneous-init deadlock.
              initiatorUserId: initiatorUserId ?? null,
              envelope: Buffer.from(message.envelope).toString("base64"),
              attachmentUrl: message.attachment_url,
              attachmentType: message.attachment_type,
              createdAt: message.created_at,
            };
            if (message.bootstrap_json) {
              sseEvent.bootstrap = message.bootstrap_json;
            }
            if (sseConn.isLive) {
              sseSent = sseConn.send("message", sseEvent, message.id);
              if (!sseSent) {
                log.warn(
                  { event: "send_message_sse_stream_dead", userId, recipientId, messageId: message.id, requestId },
                  "SSE stream was dead; falling back to RabbitMQ"
                );
              }
            } else {
              sseConn.buffer.push({ eventId: message.id, data: sseEvent });
              sseSent = true;
            }
            if (sseSent) {
              log.info(
                { event: "send_message_sse_delivered", userId, recipientId, messageId: message.id, requestId, buffered: !sseConn.isLive },
                "Message delivered via SSE"
              );
            }
          }

          if (!sseSent) {
            try {
              const published = await publishNewMessage(
                {
                  conversationId,
                  messageId: message.id,
                  senderId: userId,
                  recipientId,
                  envelope,
                  attachmentUrl: message.attachment_url,
                  attachmentType: message.attachment_type,
                  createdAt: message.created_at,
                  requestId,
                },
                log
              );

              if (!published) {
                messagesPublishFailuresTotal.inc();
                log.error(
                  { event: "send_message_publish_failed", userId, recipientId, messageId: message.id, requestId },
                  "Failed to publish message to RabbitMQ"
                );
              }
            } catch (publishErr) {
              messagesPublishFailuresTotal.inc();
              log.error(
                { event: "send_message_publish_error", userId, recipientId, messageId: message.id, requestId, err: publishErr },
                "Error publishing message to RabbitMQ"
              );
            }
          }
        }

        log.info(
          { event: "send_message_success", conversationId, userId, messageId: message.id, requestId },
          "Message sent"
        );

        return reply.status(201).send({
          success: true,
          initiatorUserId: initiatorUserId ?? null,
          message: {
            id: message.id,
            conversationId,
            senderId: userId,
            initiatorUserId: initiatorUserId ?? null,
            envelope,
            attachmentUrl: message.attachment_url,
            attachmentType: message.attachment_type,
            createdAt: message.created_at,
          },
        });
      } catch (err) {
        log.error(
          { event: "send_message_error", requestId, err },
          "Unexpected error sending message"
        );
        return reply.status(500).send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });

    // ─── REST: Get Messages ───────────────────────────────────────────────

    app.get("/messaging/conversations/:id/messages", async (req, reply) => {
      const requestId = req.id;
      const log = req.log;
      const { id: conversationId } = req.params as { id: string };

      try {
        let userId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          userId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            return reply.status(err.status).send({ success: false, error: req.t("common.errors.auth_required") });
          }
          throw err;
        }

        const { isParticipant, isBlocked, conversation, error: verifyError } = await verifyConversationParticipant(
          pool, conversationId, userId
        );

        if (verifyError) {
          log.error(
            { event: "messages_fetch_failure", conversationId, userId, requestId, err: verifyError.message },
            "Failed to verify participant"
          );
          return reply.status(500).send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

        if (!isParticipant) {
          return reply.status(403).send({ success: false, error: req.t("messaging.errors.not_participant") });
        }

        if (isBlocked) {
          return reply.status(403).send({ success: false, error: req.t("messaging.errors.blocked_view") });
        }

        const parsed = MessageHistoryQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          return reply.status(400).send({ success: false, error: parsed.error.flatten().fieldErrors });
        }

        const { cursor, limit } = parsed.data;

        const { messages, error } = await getConversationMessages(
          pool, conversationId, cursor ?? null, limit
        );

        if (error) {
          log.error(
            { event: "messages_fetch_failure", conversationId, userId, requestId, err: error.message },
            "Failed to fetch messages"
          );
          return reply.status(500).send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

        log.info(
          { event: "messages_fetch_success", conversationId, userId, requestId, count: messages.length },
          "Messages fetched"
        );

        const lastMessage = messages.length === limit ? messages[messages.length - 1] : undefined;
        const nextCursor = lastMessage ? lastMessage.created_at : null;

        const structuredMessages = messages.map((msg) => {
          let structuredEnvelope: Record<string, unknown>;
          try {
            const decoded = decodeEnvelope(msg.envelope);
            structuredEnvelope = {
              header: {
                dhPublicKey: Buffer.from(decoded.header.dhPublicKey).toString("base64"),
                n: decoded.header.n,
                pn: decoded.header.pn,
              },
              ciphertext: Buffer.from(decoded.ciphertext).toString("base64"),
            };
          } catch {
            structuredEnvelope = { ciphertext: Buffer.from(msg.envelope).toString("base64") };
          }
          if (msg.bootstrap_json) {
            structuredEnvelope.bootstrap = msg.bootstrap_json;
          }
          return {
            id: msg.id,
            conversationId: msg.conversation_id,
            senderId: msg.sender_id,
            envelope: structuredEnvelope,
            attachmentUrl: msg.attachment_url,
            attachmentType: msg.attachment_type,
            createdAt: msg.created_at,
          };
        });

        return reply.status(200).send({
          success: true,
          initiatorUserId: conversation?.initiator_user_id ?? null,
          messages: structuredMessages,
          nextCursor,
        });
      } catch (err) {
        log.error(
          { event: "messages_fetch_error", requestId, err },
          "Unexpected error fetching messages"
        );
        return reply.status(500).send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });

    // ─── REST: Get Conversation Bootstrap (Bug 2) ─────────────────────────
    // Pagination-independent retrieval of the PQXDH handshake material so a
    // responder can always establish a session, even after the bootstrap message
    // (n=0) has scrolled out of the recent-history window.

    app.get("/messaging/conversations/:id/bootstrap", async (req, reply) => {
      const requestId = req.id;
      const log = req.log;
      const { id: conversationId } = req.params as { id: string };

      try {
        let userId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          userId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            return reply.status(err.status).send({ success: false, error: req.t("common.errors.auth_required") });
          }
          throw err;
        }

        const { isParticipant, isBlocked, conversation, error: verifyError } = await verifyConversationParticipant(
          pool, conversationId, userId
        );

        if (verifyError) {
          return reply.status(500).send({ success: false, error: req.t("common.errors.unable_to_process") });
        }
        if (!isParticipant) {
          return reply.status(403).send({ success: false, error: req.t("messaging.errors.not_participant") });
        }
        if (isBlocked) {
          return reply.status(403).send({ success: false, error: req.t("messaging.errors.blocked_send") });
        }

        const { bootstrap, senderId, error } = await getConversationBootstrap(pool, conversationId);
        if (error) {
          log.error({ event: "bootstrap_fetch_failure", conversationId, userId, requestId, err: error.message }, "Failed to fetch bootstrap");
          return reply.status(500).send({ success: false, error: req.t("common.errors.unable_to_process") });
        }
        if (!bootstrap) {
          return reply.status(404).send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

        return reply.status(200).send({
          success: true,
          bootstrap,
          senderId,
          initiatorUserId: conversation?.initiator_user_id ?? senderId ?? null,
        });
      } catch (err) {
        log.error({ event: "bootstrap_fetch_error", requestId, err }, "Unexpected error fetching bootstrap");
        return reply.status(500).send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });
  };
}

// Default export for use in routes/index.ts
export default createMessagingRoutes();
