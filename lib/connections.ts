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

export const REJECTION_COOLDOWN_MS = 3 * 60 * 60 * 1000;

export function getRejectionCooldownState(
  updatedAt: string | null,
  nowMs: number = Date.now(),
  cooldownMs: number = REJECTION_COOLDOWN_MS
): { withinCooldown: boolean; elapsedMs: number | null; cooldownMs: number } {
  if (updatedAt === null) {
    return { withinCooldown: false, elapsedMs: null, cooldownMs };
  }

  const updatedAtMs = new Date(updatedAt).getTime();
  const elapsedMs = nowMs - updatedAtMs;

  if (!Number.isFinite(elapsedMs)) {
    return { withinCooldown: false, elapsedMs: null, cooldownMs };
  }

  return { withinCooldown: elapsedMs < cooldownMs, elapsedMs, cooldownMs };
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

  return { row, error: null };
}

