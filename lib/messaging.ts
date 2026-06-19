import type { SupabaseClient } from "@supabase/supabase-js";
import { findConnectionBetweenUsers, isPairBlocked } from "./connections.js";

// Removed duplicate import

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
  envelope: Uint8Array; // Protobuf encoded envelope
  attachment_url: string | null;
  attachment_type: string | null;
  created_at: string;
  bootstrap_json: BootstrapJson | null;
  // Canonical conversation initiator. Populated by the SSE catch-up generator so
  // replayed events carry the same initiatorUserId the live send path emits.
  initiator_user_id?: string | null;
}

/**
 * Returns canonical participant ordering (smaller UUID first).
 * Mirrors the getCanonicalPair pattern from lib/connections.ts.
 */
export function getConversationParticipants(
  userIdA: string,
  userIdB: string
): { participantOne: string; participantTwo: string } {
  return userIdA < userIdB
    ? { participantOne: userIdA, participantTwo: userIdB }
    : { participantOne: userIdB, participantTwo: userIdA };
}

/**
 * Returns the other participant's ID in a conversation.
 */
export function getOtherParticipant(
  conv: Pick<ConversationRow, "participant_one" | "participant_two">,
  currentUserId: string
): string | null {
  if (conv.participant_one === currentUserId) return conv.participant_two;
  if (conv.participant_two === currentUserId) return conv.participant_one;
  return null;
}

/**
 * Finds an existing conversation or creates one between two users.
 */
export async function findOrCreateConversation(
  client: SupabaseClient,
  userIdA: string,
  userIdB: string,
  log: { info: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void }
): Promise<{ conversation: ConversationRow | null; error: Error | null; created: boolean }> {
  const { participantOne, participantTwo } = getConversationParticipants(userIdA, userIdB);

  // Try to find existing conversation first
  const { data: existing, error: findError } = await client
    .from("conversations")
    .select("id, participant_one, participant_two, created_at, updated_at, initiator_user_id")
    .eq("participant_one", participantOne)
    .eq("participant_two", participantTwo)
    .maybeSingle();

  if (findError) {
    log.error(
      { event: "conversation_find_error", participantOne, participantTwo, err: findError.message },
      "Failed to find conversation"
    );
    return { conversation: null, error: findError as unknown as Error, created: false };
  }

  if (existing) {
    return { conversation: existing as ConversationRow, error: null, created: false };
  }

  // Create new conversation
  const { data: created, error: createError } = await client
    .from("conversations")
    .insert({ participant_one: participantOne, participant_two: participantTwo })
    .select("id, participant_one, participant_two, created_at, updated_at, initiator_user_id")
    .single();

  if (createError) {
    // Handle race condition: if another request created it simultaneously
    if (createError.code === "23505") {
      const { data: raceResult, error: raceError } = await client
        .from("conversations")
        .select("id, participant_one, participant_two, created_at, updated_at, initiator_user_id")
        .eq("participant_one", participantOne)
        .eq("participant_two", participantTwo)
        .single();

      if (raceError || !raceResult) {
        log.error(
          { event: "conversation_race_error", participantOne, participantTwo },
          "Failed to fetch conversation after race condition"
        );
        return { conversation: null, error: (raceError ?? new Error("Not found")) as Error, created: false };
      }
      return { conversation: raceResult as ConversationRow, error: null, created: false };
    }

    log.error(
      { event: "conversation_create_error", participantOne, participantTwo, err: createError.message },
      "Failed to create conversation"
    );
    return { conversation: null, error: createError as unknown as Error, created: false };
  }

  log.info(
    { event: "conversation_created", conversationId: created.id, participantOne, participantTwo },
    "New conversation created"
  );
  return { conversation: created as ConversationRow, error: null, created: true };
}

import { encodeEnvelope, type MessageEnvelope } from "../shared/types.js";

/**
 * Inserts an E2EE message into a conversation.
 */
export async function insertMessage(
  client: SupabaseClient,
  conversationId: string,
  senderId: string,
  envelope: MessageEnvelope,
  attachmentUrl: string | null,
  attachmentType: string | null,
  bootstrapJson: BootstrapJson | null,
  log: { info: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void }
): Promise<{ message: MessageRow | null; initiatorUserId?: string | null; error: Error | null }> {
  // Encode the structured envelope to Protobuf binary
  const binaryEnvelope = encodeEnvelope(envelope);
  const envelopeBase64 = Buffer.from(binaryEnvelope).toString("base64");

  // Deduplication: check if a message with the same envelope already exists in this conversation.
  // This prevents duplicate messages from client retries after network timeouts.
  const { data: existing } = await client
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("envelope", envelopeBase64)
    .limit(1)
    .maybeSingle();

  if (existing) {
    log.info(
      { event: "message_dedup", conversationId, senderId, existingId: existing.id },
      "Duplicate message detected, skipping insert"
    );
    // Return the existing message instead of inserting a duplicate
    const { data: existingMsg } = await client
      .from("messages")
      .select("id, conversation_id, sender_id, envelope, attachment_url, attachment_type, created_at, bootstrap_json")
      .eq("id", existing.id)
      .single();

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

  const { data, error } = await client
    .from("messages")
    .insert({
      conversation_id: conversationId,
      sender_id: senderId,
      envelope: envelopeBase64,
      attachment_url: attachmentUrl,
      attachment_type: attachmentType,
      bootstrap_json: bootstrapJson,
    })
    .select("id, conversation_id, sender_id, envelope, attachment_url, attachment_type, created_at, bootstrap_json")
    .single();

  if (error) {
    log.error(
      { event: "message_insert_error", conversationId, senderId, err: error.message },
      "Failed to insert message"
    );
    return { message: null, error: error as unknown as Error };
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

  // Set initiator_user_id on the FIRST message (set-once via the is-null guard —
  // concurrent first-messages serialize on the row lock so the earliest INSERT
  // wins). This is the canonical tie-breaker that lets both clients agree on who
  // is the PQXDH initiator vs responder, preventing the simultaneous-initiation
  // deadlock where both sides flip to responder onto opposite master secrets.
  const now = new Date().toISOString();
  const { data: convUpdate, error: updateError } = await client
    .from("conversations")
    .update({ initiator_user_id: senderId, updated_at: now })
    .eq("id", conversationId)
    .is("initiator_user_id", null)
    .select("initiator_user_id")
    .maybeSingle();

  if (updateError) {
    log.error(
      { event: "conversation_updated_at_error", conversationId, err: updateError.message },
      "Failed to update conversation timestamp"
    );
  }

  // If the update didn't match (another first-message won), read the canonical initiator.
  let initiatorUserId = senderId;
  if (!convUpdate?.initiator_user_id) {
    const { data: convRow } = await client
      .from("conversations")
      .select("initiator_user_id")
      .eq("id", conversationId)
      .maybeSingle();
    initiatorUserId = (convRow as { initiator_user_id: string | null } | null)?.initiator_user_id ?? senderId;
  } else {
    initiatorUserId = convUpdate.initiator_user_id;
  }

  return { message, initiatorUserId, error: null };
}

/**
 * Fetches paginated messages for a conversation using cursor-based pagination.
 */
export async function getConversationMessages(
  client: SupabaseClient,
  conversationId: string,
  cursor: string | null,
  limit: number = 20
): Promise<{ messages: MessageRow[]; error: Error | null }> {
  let query = client
    .from("messages")
    .select("id, conversation_id, sender_id, envelope, attachment_url, attachment_type, created_at, bootstrap_json")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cursor) {
    query = query.lt("created_at", cursor);
  }

  const { data, error } = await query;

  if (error) {
    return { messages: [], error: error as unknown as Error };
  }

  const messages: MessageRow[] = (data ?? []).map((m: any) => ({
    ...m,
    envelope: Buffer.from(m.envelope, "base64"),
    bootstrap_json: (m.bootstrap_json as BootstrapJson | null) ?? null,
  }));

  return { messages: messages, error: null };
}

/**
 * Async generator that yields missed messages for a user across all their conversations,
 * ordered by created_at ASC, in batches. Used by the SSE catch-up phase on reconnect.
 */
export async function* getMessagesSinceCursor(
  client: SupabaseClient,
  userId: string,
  cursor: string,
  batchSize: number = 50
): AsyncGenerator<MessageRow[], void, unknown> {
  const { data: convData } = await client
    .from("conversations")
    .select("id, initiator_user_id")
    .or(`participant_one.eq.${userId},participant_two.eq.${userId}`);

  const conversationIds = (convData ?? []).map((c: { id: string }) => c.id);
  if (conversationIds.length === 0) return;

  // Canonical initiator per conversation, so catch-up/replay events carry
  // initiatorUserId exactly like the live send path. Without it, a peer's n=0
  // bootstrap replayed on reconnect leaves both clients unable to agree on the
  // initiator role → simultaneous-initiation deadlock (both become responders).
  const initiatorByConv = new Map<string, string | null>();
  for (const c of (convData ?? []) as Array<{ id: string; initiator_user_id: string | null }>) {
    initiatorByConv.set(c.id, c.initiator_user_id ?? null);
  }

  // Keyset pagination: advance the cursor by the last row's created_at each batch
  // instead of using a fixed cursor + offset. Offset pagination over a set that
  // can grow mid-catch-up (new messages keep arriving) silently skips or
  // duplicates rows; keyset is stable under concurrent inserts.
  let lastCursor = cursor;
  while (true) {
    const { data, error } = await client
      .from("messages")
      .select("id, conversation_id, sender_id, envelope, attachment_url, attachment_type, created_at, bootstrap_json")
      .in("conversation_id", conversationIds)
      .gt("created_at", lastCursor)
    .order("created_at", { ascending: false })
      .limit(batchSize);

    if (error || !data || data.length === 0) break;

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
    // Guard against a non-advancing cursor (would loop forever if a full batch
    // shared one timestamp — not expected with microsecond insert timestamps).
    if (data.length < batchSize || nextCursor === lastCursor) break;
    lastCursor = nextCursor;
  }
}

/**
 * Returns the conversation's bootstrap (PQXDH handshake material), independent of
 * message-history pagination (Bug 2). The bootstrap rides only on the initiator's
 * first message; a responder that never established a session must be able to fetch
 * it even after that message scrolls out of the recent-history window. Returns the
 * EARLIEST message that carries a bootstrap_json.
 */
export async function getConversationBootstrap(
  client: SupabaseClient,
  conversationId: string
): Promise<{ bootstrap: BootstrapJson | null; senderId: string | null; error: Error | null }> {
  const { data, error } = await client
    .from("messages")
    .select("sender_id, bootstrap_json, created_at")
    .eq("conversation_id", conversationId)
    .not("bootstrap_json", "is", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    return { bootstrap: null, senderId: null, error: error as unknown as Error };
  }
  if (!data) {
    return { bootstrap: null, senderId: null, error: null };
  }
  return {
    bootstrap: (data.bootstrap_json as BootstrapJson | null) ?? null,
    senderId: (data.sender_id as string | null) ?? null,
    error: null,
  };
}

/**
 * Verifies a user is a participant in a conversation and checks if they are blocked.
 */
export async function verifyConversationParticipant(
  client: SupabaseClient,
  conversationId: string,
  userId: string
): Promise<{ 
  isParticipant: boolean; 
  isBlocked: boolean;
  conversation: ConversationRow | null; 
  error: Error | null 
}> {
  const { data, error } = await client
    .from("conversations")
    .select("id, participant_one, participant_two, created_at, updated_at, initiator_user_id")
    .eq("id", conversationId)
    .single();

  if (error) {
    return { isParticipant: false, isBlocked: false, conversation: null, error: error as unknown as Error };
  }

  const conv = data as ConversationRow;
  const isParticipant = conv.participant_one === userId || conv.participant_two === userId;
  
  if (!isParticipant) {
    return { isParticipant: false, isBlocked: false, conversation: conv, error: null };
  }

  // Check if blocked
  const otherUserId = conv.participant_one === userId ? conv.participant_two : conv.participant_one;
  const { row: connection, error: connError } = await findConnectionBetweenUsers(client, userId, otherUserId);

  if (connError) {
    return { isParticipant: true, isBlocked: false, conversation: conv, error: connError };
  }

  const blocked = isPairBlocked(connection);
  return { isParticipant: true, isBlocked: blocked, conversation: conv, error: null };
}
