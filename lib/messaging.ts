import type { SupabaseClient } from "@supabase/supabase-js";

export interface ConversationRow {
  id: string;
  participant_one: string;
  participant_two: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string | null;
  attachment_url: string | null;
  attachment_type: string | null;
  created_at: string;
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
    .select("id, participant_one, participant_two, created_at, updated_at")
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
    .select("id, participant_one, participant_two, created_at, updated_at")
    .single();

  if (createError) {
    // Handle race condition: if another request created it simultaneously
    if (createError.code === "23505") {
      const { data: raceResult, error: raceError } = await client
        .from("conversations")
        .select("id, participant_one, participant_two, created_at, updated_at")
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

/**
 * Inserts a message into a conversation and bumps the conversation's updated_at.
 */
export async function insertMessage(
  client: SupabaseClient,
  conversationId: string,
  senderId: string,
  content: string | null,
  attachmentUrl: string | null,
  attachmentType: string | null,
  log: { info: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void }
): Promise<{ message: MessageRow | null; error: Error | null }> {
  const { data, error } = await client
    .from("messages")
    .insert({
      conversation_id: conversationId,
      sender_id: senderId,
      content,
      attachment_url: attachmentUrl,
      attachment_type: attachmentType,
    })
    .select("id, conversation_id, sender_id, content, attachment_url, attachment_type, created_at")
    .single();

  if (error) {
    log.error(
      { event: "message_insert_error", conversationId, senderId, err: error.message },
      "Failed to insert message"
    );
    return { message: null, error: error as unknown as Error };
  }

  // Bump conversation updated_at
  const { error: updateError } = await client
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);

  if (updateError) {
    log.error(
      { event: "conversation_updated_at_error", conversationId, err: updateError.message },
      "Failed to update conversation timestamp"
    );
    // Non-fatal: the message was still inserted successfully
  }

  return { message: data as MessageRow, error: null };
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
    .select("id, conversation_id, sender_id, content, attachment_url, attachment_type, created_at")
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

  return { messages: (data ?? []) as MessageRow[], error: null };
}

/**
 * Verifies a user is a participant in a conversation.
 */
export async function verifyConversationParticipant(
  client: SupabaseClient,
  conversationId: string,
  userId: string
): Promise<{ isParticipant: boolean; conversation: ConversationRow | null; error: Error | null }> {
  const { data, error } = await client
    .from("conversations")
    .select("id, participant_one, participant_two, created_at, updated_at")
    .eq("id", conversationId)
    .single();

  if (error) {
    return { isParticipant: false, conversation: null, error: error as unknown as Error };
  }

  const conv = data as ConversationRow;
  const isParticipant = conv.participant_one === userId || conv.participant_two === userId;
  return { isParticipant, conversation: conv, error: null };
}
