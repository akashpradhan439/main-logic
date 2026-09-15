import pg from "pg";
import { findConnectionBetweenUsers, isPairBlocked } from "./connections.js";

export interface ConversationRow {
  id: string;
  participant_one: string;
  participant_two: string;
  created_at: string;
  updated_at: string;
  initiator_user_id: string | null;
}

export interface BootstrapJson {
  senderIdentityKey:    string;
  senderEphemeralKey:   string;
  pqCiphertext:         string;
  signedPrekeyId:       number;
  pqSignedPrekeyId:     number;
  oneTimePrekeyId?:     number | undefined;
  pqOneTimePrekeyId?:   number | undefined;
  usedOTPPublicKey?:    string | undefined;
  usedPQOTPPublicKey?:  string | undefined;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  envelope: Uint8Array;
  attachment_url: string | null;
  attachment_type: string | null;
  created_at: string;
  bootstrap_json: BootstrapJson | null;
  initiator_user_id?: string | null;
}

export function getConversationParticipants(
  userIdA: string,
  userIdB: string
): { participantOne: string; participantTwo: string } {
  return userIdA < userIdB
    ? { participantOne: userIdA, participantTwo: userIdB }
    : { participantOne: userIdB, participantTwo: userIdA };
}

export function getOtherParticipant(
  conv: Pick<ConversationRow, "participant_one" | "participant_two">,
  currentUserId: string
): string | null {
  if (conv.participant_one === currentUserId) return conv.participant_two;
  if (conv.participant_two === currentUserId) return conv.participant_one;
  return null;
}

const CONVERSATION_COLS =
  "id, participant_one, participant_two, created_at, updated_at, initiator_user_id";

const MESSAGE_COLS =
  "id, conversation_id, sender_id, envelope, attachment_url, attachment_type, created_at, bootstrap_json";

export async function findOrCreateConversation(
  client: pg.Pool | pg.PoolClient,
  userIdA: string,
  userIdB: string,
  log: { info: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void }
): Promise<{ conversation: ConversationRow | null; error: Error | null; created: boolean }> {
  const { participantOne, participantTwo } = getConversationParticipants(userIdA, userIdB);

  try {
    // Try to find existing conversation first
    const { rows } = await client.query(
      `SELECT ${CONVERSATION_COLS}
       FROM conversations
       WHERE participant_one = $1 AND participant_two = $2
       LIMIT 1`,
      [participantOne, participantTwo]
    );

    const existing = rows[0] as ConversationRow | undefined;

    if (existing) {
      return { conversation: existing, error: null, created: false };
    }

    // Create new conversation
    const { rows: createdRows } = await client.query(
      `INSERT INTO conversations (participant_one, participant_two)
       VALUES ($1, $2)
       RETURNING ${CONVERSATION_COLS}`,
      [participantOne, participantTwo]
    );

    const created = createdRows[0] as ConversationRow;

    log.info(
      { event: "conversation_created", conversationId: created.id, participantOne, participantTwo },
      "New conversation created"
    );
    return { conversation: created, error: null, created: true };
  } catch (err: any) {
    // Handle race condition: if another request created it simultaneously (unique violation)
    if (err.code === "23505") {
      try {
        const { rows: raceRows } = await client.query(
          `SELECT ${CONVERSATION_COLS}
           FROM conversations
           WHERE participant_one = $1 AND participant_two = $2
           LIMIT 1`,
          [participantOne, participantTwo]
        );
        const raceResult = raceRows[0] as ConversationRow | undefined;
        if (!raceResult) {
          log.error(
            { event: "conversation_race_error", participantOne, participantTwo },
            "Failed to fetch conversation after race condition"
          );
          return { conversation: null, error: new Error("Not found"), created: false };
        }
        return { conversation: raceResult, error: null, created: false };
      } catch (raceErr) {
        log.error(
          { event: "conversation_race_error", participantOne, participantTwo },
          "Failed to fetch conversation after race condition"
        );
        return { conversation: null, error: raceErr as Error, created: false };
      }
    }

    log.error(
      { event: "conversation_create_error", participantOne, participantTwo, err: err.message },
      "Failed to create conversation"
    );
    return { conversation: null, error: err as Error, created: false };
  }
}

import { encodeEnvelope, type MessageEnvelope } from "../shared/types.js";

export async function insertMessage(
  client: pg.Pool | pg.PoolClient,
  conversationId: string,
  senderId: string,
  envelope: MessageEnvelope,
  attachmentUrl: string | null,
  attachmentType: string | null,
  bootstrapJson: BootstrapJson | null,
  log: { info: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void }
): Promise<{ message: MessageRow | null; initiatorUserId?: string | null; error: Error | null }> {
  const binaryEnvelope = encodeEnvelope(envelope);
  const envelopeBase64 = Buffer.from(binaryEnvelope).toString("base64");

  try {
    // Deduplication check
    const { rows: dedupRows } = await client.query(
      `SELECT id FROM messages
       WHERE conversation_id = $1 AND envelope = $2
       LIMIT 1`,
      [conversationId, envelopeBase64]
    );

    if (dedupRows[0]) {
      const existingId = dedupRows[0].id;
      log.info(
        { event: "message_dedup", conversationId, senderId, existingId },
        "Duplicate message detected, skipping insert"
      );

      const { rows: existingMsgRows } = await client.query(
        `SELECT ${MESSAGE_COLS} FROM messages WHERE id = $1`,
        [existingId]
      );
      const existingMsg = existingMsgRows[0];
      if (existingMsg) {
        const message: MessageRow = {
          id: existingMsg.id,
          conversation_id: existingMsg.conversation_id,
          sender_id: existingMsg.sender_id,
          envelope: Buffer.from(existingMsg.envelope, "base64"),
          attachment_url: existingMsg.attachment_url,
          attachment_type: existingMsg.attachment_type,
          created_at: existingMsg.created_at,
          bootstrap_json: (existingMsg.bootstrap_json as BootstrapJson | null) ?? null,
        };
        return { message, error: null };
      }
    }

    // Insert the message
    const { rows: insertRows } = await client.query(
      `INSERT INTO messages (conversation_id, sender_id, envelope, attachment_url, attachment_type, bootstrap_json)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${MESSAGE_COLS}`,
      [conversationId, senderId, envelopeBase64, attachmentUrl, attachmentType, bootstrapJson]
    );

    const data = insertRows[0];
    if (!data) {
      throw new Error("Insert returned no rows");
    }

    const message: MessageRow = {
      id: data.id,
      conversation_id: data.conversation_id,
      sender_id: data.sender_id,
      envelope: Buffer.from(data.envelope, "base64"),
      attachment_url: data.attachment_url,
      attachment_type: data.attachment_type,
      created_at: data.created_at,
      bootstrap_json: (data.bootstrap_json as BootstrapJson | null) ?? null,
    };

    // Set initiator_user_id on the FIRST message (set-once via the is-null guard)
    const now = new Date().toISOString();
    const { rows: updateRows } = await client.query(
      `UPDATE conversations
       SET initiator_user_id = $1, updated_at = $2
       WHERE id = $3 AND initiator_user_id IS NULL
       RETURNING initiator_user_id`,
      [senderId, now, conversationId]
    );

    const convUpdate = updateRows[0] as { initiator_user_id: string | null } | undefined;

    let initiatorUserId = senderId;
    if (!convUpdate?.initiator_user_id) {
      const { rows: convRows } = await client.query(
        `SELECT initiator_user_id FROM conversations WHERE id = $1`,
        [conversationId]
      );
      initiatorUserId = (convRows[0] as { initiator_user_id: string | null } | undefined)?.initiator_user_id ?? senderId;
    } else {
      initiatorUserId = convUpdate.initiator_user_id;
    }

    return { message, initiatorUserId, error: null };
  } catch (err) {
    log.error(
      { event: "message_insert_error", conversationId, senderId, err: (err as Error).message },
      "Failed to insert message"
    );
    return { message: null, error: err as Error };
  }
}

export async function getConversationMessages(
  client: pg.Pool | pg.PoolClient,
  conversationId: string,
  cursor: string | null,
  limit: number = 20
): Promise<{ messages: MessageRow[]; error: Error | null }> {
  try {
    let sql = `SELECT ${MESSAGE_COLS} FROM messages WHERE conversation_id = $1`;
    const params: any[] = [conversationId];
    let paramIdx = 2;

    if (cursor) {
      sql += ` AND created_at < $${paramIdx}`;
      params.push(cursor);
      paramIdx++;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${paramIdx}`;
    params.push(limit);

    const { rows } = await client.query(sql, params);

    const messages: MessageRow[] = rows.map((m: any) => ({
      ...m,
      envelope: Buffer.from(m.envelope, "base64"),
      bootstrap_json: (m.bootstrap_json as BootstrapJson | null) ?? null,
    }));

    return { messages, error: null };
  } catch (err) {
    return { messages: [], error: err as Error };
  }
}

export async function* getMessagesSinceCursor(
  client: pg.Pool | pg.PoolClient,
  userId: string,
  cursor: string,
  batchSize: number = 50
): AsyncGenerator<MessageRow[], void, unknown> {
  const { rows: convData } = await client.query(
    `SELECT id, initiator_user_id
     FROM conversations
     WHERE participant_one = $1 OR participant_two = $1`,
    [userId]
  );

  const conversationIds: string[] = convData.map((c: { id: string }) => c.id);
  if (conversationIds.length === 0) return;

  const initiatorByConv = new Map<string, string | null>();
  for (const c of convData as Array<{ id: string; initiator_user_id: string | null }>) {
    initiatorByConv.set(c.id, c.initiator_user_id ?? null);
  }

  let lastCursor = cursor;
  while (true) {
    const result = await client.query(
      `SELECT ${MESSAGE_COLS}
       FROM messages
       WHERE conversation_id = ANY($1)
         AND created_at > $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [conversationIds, lastCursor, batchSize]
    ).then(r => ({ rows: r.rows, error: undefined as Error | undefined })).catch(e => ({ rows: [] as any[], error: e as Error }));
    const { rows: data, error } = result;

    if ((error as Error | undefined) || !data || data.length === 0) break;

    const messages: MessageRow[] = (data as Array<{
      id: string;
      conversation_id: string;
      sender_id: string;
      envelope: string;
      attachment_url: string | null;
      attachment_type: string | null;
      created_at: string;
      bootstrap_json: BootstrapJson | null;
    }>).map((m) => ({
      ...m,
      envelope: Buffer.from(m.envelope, "base64"),
      bootstrap_json: m.bootstrap_json ?? null,
      initiator_user_id: initiatorByConv.get(m.conversation_id) ?? null,
    }));

    yield messages;

    const nextCursor = messages[messages.length - 1]!.created_at;
    if (data.length < batchSize || nextCursor === lastCursor) break;
    lastCursor = nextCursor;
  }
}

export async function getConversationBootstrap(
  client: pg.Pool | pg.PoolClient,
  conversationId: string
): Promise<{ bootstrap: BootstrapJson | null; senderId: string | null; error: Error | null }> {
  try {
    const { rows } = await client.query(
      `SELECT sender_id, bootstrap_json, created_at
       FROM messages
       WHERE conversation_id = $1 AND bootstrap_json IS NOT NULL
       ORDER BY created_at ASC
       LIMIT 1`,
      [conversationId]
    );

    const data = rows[0];
    if (!data) {
      return { bootstrap: null, senderId: null, error: null };
    }

    return {
      bootstrap: (data.bootstrap_json as BootstrapJson | null) ?? null,
      senderId: (data.sender_id as string | null) ?? null,
      error: null,
    };
  } catch (err) {
    return { bootstrap: null, senderId: null, error: err as Error };
  }
}

export async function verifyConversationParticipant(
  client: pg.Pool | pg.PoolClient,
  conversationId: string,
  userId: string
): Promise<{
  isParticipant: boolean;
  isBlocked: boolean;
  conversation: ConversationRow | null;
  error: Error | null
}> {
  try {
    const { rows } = await client.query(
      `SELECT ${CONVERSATION_COLS} FROM conversations WHERE id = $1`,
      [conversationId]
    );

    const data = rows[0] as ConversationRow | undefined;
    if (!data) {
      return { isParticipant: false, isBlocked: false, conversation: null, error: new Error("Conversation not found") };
    }

    const conv = data;
    const isParticipant = conv.participant_one === userId || conv.participant_two === userId;

    if (!isParticipant) {
      return { isParticipant: false, isBlocked: false, conversation: conv, error: null };
    }

    const otherUserId = conv.participant_one === userId ? conv.participant_two : conv.participant_one;
    const { row: connection, error: connError } = await findConnectionBetweenUsers(client, userId, otherUserId);

    if (connError) {
      return { isParticipant: true, isBlocked: false, conversation: conv, error: connError };
    }

    const blocked = isPairBlocked(connection);
    return { isParticipant: true, isBlocked: blocked, conversation: conv, error: null };
  } catch (err) {
    return { isParticipant: false, isBlocked: false, conversation: null, error: err as Error };
  }
}
