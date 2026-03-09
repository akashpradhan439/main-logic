import type { SupabaseClient } from "@supabase/supabase-js";

export type ConnectionStatus = "pending" | "accepted" | "rejected" | "blocked";

export interface ConnectionRow {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: ConnectionStatus;
  requester_blocked?: boolean | null;
  addressee_blocked?: boolean | null;
  updated_at: string | null;
}

export function getCanonicalPair(
  userIdA: string,
  userIdB: string
): { requesterId: string; addresseeId: string } {
  if (userIdA === userIdB) {
    return { requesterId: userIdA, addresseeId: userIdB };
  }
  return userIdA < userIdB
    ? { requesterId: userIdA, addresseeId: userIdB }
    : { requesterId: userIdB, addresseeId: userIdA };
}

export function isPairBlocked(row: ConnectionRow | null | undefined): boolean {
  if (!row) return false;

  if (row.status === "blocked") {
    return true;
  }

  return Boolean(row.requester_blocked) || Boolean(row.addressee_blocked);
}

export function getOtherUserId(
  row: Pick<ConnectionRow, "requester_id" | "addressee_id">,
  currentUserId: string
): string | null {
  if (row.requester_id === currentUserId) return row.addressee_id;
  if (row.addressee_id === currentUserId) return row.requester_id;
  return null;
}

export async function findConnectionBetweenUsers(
  client: SupabaseClient,
  userIdA: string,
  userIdB: string
): Promise<{ row: ConnectionRow | null; error: Error | null }> {
  const { requesterId, addresseeId } = getCanonicalPair(userIdA, userIdB);

  const { data, error } = await client
    .from("connections")
    .select(
      "id, requester_id, addressee_id, status, requester_blocked, addressee_blocked, updated_at"
    )
    .or(
      `and(requester_id.eq.${userIdA},addressee_id.eq.${userIdB}),and(requester_id.eq.${userIdB},addressee_id.eq.${userIdA})`
    )
    .limit(1)
    .maybeSingle();

  if (error) {
    return { row: null, error: error as Error };
  }

  const row = (data as ConnectionRow | null) ?? null;

  if (!row) {
    return { row: null, error: null };
  }

  if (
    row.requester_id === requesterId &&
    row.addressee_id === addresseeId
  ) {
    return { row, error: null };
  }

  const { data: updated, error: updateError } = await client
    .from("connections")
    .update({
      requester_id: requesterId,
      addressee_id: addresseeId,
    })
    .eq("id", row.id)
    .select(
      "id, requester_id, addressee_id, status, requester_blocked, addressee_blocked, updated_at"
    )
    .single();

  if (updateError) {
    return { row, error: updateError as Error };
  }

  return { row: updated as ConnectionRow, error: null };
}

