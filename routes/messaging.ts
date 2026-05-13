import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { publishNewMessage } from "../lib/rabbitmq.js";
import type { MessageEnvelope } from "../shared/types.js";
import {
  messagesSentTotal,
  messagesPublishFailuresTotal,
} from "../lib/metrics.js";
import { verifyAccessToken, AuthError } from "../shared/auth.js";
import {
  findOrCreateConversation,
  insertMessage,
  getConversationMessages,
  verifyConversationParticipant,
  getOtherParticipant,
  type ConversationRow,
  type MessageRow,
} from "../lib/messaging.js";
import { findConnectionBetweenUsers, isPairBlocked } from "../lib/connections.js";
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
        senderIdentityKey:  z.string().min(1),
        senderEphemeralKey: z.string().min(1),
        pqCiphertext:       z.string().min(1),
        signedPrekeyId:     z.number().int().positive(),
        pqSignedPrekeyId:   z.number().int().positive(),
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
  } | undefined;
}): MessageEnvelope | null {
  const dhPublicKey = toUint8Array(envelope.header.dhPublicKey);
  const ciphertext  = toUint8Array(envelope.ciphertext);
  if (!dhPublicKey || !ciphertext) return null;

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
      signedPrekeyId:   envelope.bootstrap.signedPrekeyId,
      pqSignedPrekeyId: envelope.bootstrap.pqSignedPrekeyId,
    };
  }

  return result;
}

// ─── Dependency Injection ─────────────────────────────────────────────────────

export type MessagingRouteDeps = {
  supabase: typeof supabase;
  verifyAccessToken: typeof verifyAccessToken;
  AuthError: typeof AuthError;
  findConnectionBetweenUsers: typeof findConnectionBetweenUsers;
  isPairBlocked: typeof isPairBlocked;
  findOrCreateConversation: typeof findOrCreateConversation;
  insertMessage: typeof insertMessage;
  getConversationMessages: typeof getConversationMessages;
  verifyConversationParticipant: typeof verifyConversationParticipant;
  getOtherParticipant: typeof getOtherParticipant;
  publishNewMessage: typeof publishNewMessage;
};

export function createMessagingRoutes(
  overrides: Partial<MessagingRouteDeps> = {}
) {
  const deps: MessagingRouteDeps = {
    supabase,
    verifyAccessToken,
    AuthError,
    findConnectionBetweenUsers,
    isPairBlocked,
    findOrCreateConversation,
    insertMessage,
    getConversationMessages,
    verifyConversationParticipant,
    getOtherParticipant,
    publishNewMessage,
    ...overrides,
  };

  return async function messagingRoutes(app: FastifyInstance) {
    const {
      supabase,
      verifyAccessToken,
      AuthError,
      findConnectionBetweenUsers,
      isPairBlocked,
      findOrCreateConversation,
      insertMessage,
      getConversationMessages,
      verifyConversationParticipant,
      getOtherParticipant,
      publishNewMessage,
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
          supabase, userId, otherUserId
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
          supabase, userId, otherUserId, log
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

        return reply.status(created ? 201 : 200).send({
          success: true,
          conversation: {
            id: conversation.id,
            otherUserId,
            createdAt: conversation.created_at,
            updatedAt: conversation.updated_at,
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

        const { data, error } = await supabase
          .from("conversations")
          .select(`
            id,
            participant_one,
            participant_two,
            created_at,
            updated_at,
            p1:users!participant_one(first_name, last_name),
            p2:users!participant_two(first_name, last_name)
          `)
          .or(`participant_one.eq.${userId},participant_two.eq.${userId}`)
          .order("updated_at", { ascending: false });

        if (error) {
          log.error(
            { event: "conversations_list_failure", userId, requestId, err: error.message },
            "Failed to list conversations"
          );
          return reply.status(500).send({ success: false, error: req.t("common.errors.unable_to_process") });
        }

        const conversations = await Promise.all((data ?? []).map(async (conv: any) => {
          const isP1 = conv.participant_one === userId;
          const otherUserId = isP1 ? conv.participant_two : conv.participant_one;
          const otherUserProfile = isP1 ? conv.p2 : conv.p1;

          const { data: lastMsg } = await supabase
            .from("messages")
            .select("id, envelope, sender_id, created_at, attachment_url, attachment_type")
            .eq("conversation_id", conv.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          return {
            id: conv.id,
            otherUserId,
            otherUserFirstName: otherUserProfile?.first_name || null,
            otherUserLastName: otherUserProfile?.last_name || null,
            createdAt: conv.created_at,
            updatedAt: conv.updated_at,
            lastMessage: lastMsg ? {
              id: lastMsg.id,
              envelope: lastMsg.envelope,
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

    app.post("/messaging/conversations/:id/messages", async (req, reply) => {
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
          supabase, conversationId, userId
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

        const { message, error: insertError } = await insertMessage(
          supabase,
          conversationId,
          userId,
          normalizedEnvelope,
          attachmentUrl,
          attachmentType,
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
            const sseEvent = {
              type: "new_message",
              conversationId,
              messageId: message.id,
              senderId: userId,
              envelope: Buffer.from(message.envelope).toString("base64"),
              attachmentUrl: message.attachment_url,
              attachmentType: message.attachment_type,
              createdAt: message.created_at,
            };
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
          message: {
            id: message.id,
            conversationId,
            senderId: userId,
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

        const { isParticipant, isBlocked, error: verifyError } = await verifyConversationParticipant(
          supabase, conversationId, userId
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
          supabase, conversationId, cursor ?? null, limit
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

        return reply.status(200).send({ success: true, messages, nextCursor });
      } catch (err) {
        log.error(
          { event: "messages_fetch_error", requestId, err },
          "Unexpected error fetching messages"
        );
        return reply.status(500).send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });
  };
}

// Default export for use in routes/index.ts
export default createMessagingRoutes();
