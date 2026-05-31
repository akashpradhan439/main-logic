import type { SupabaseClient } from "@supabase/supabase-js";
import { cellToLatLngSafe } from "../shared/h3.js";

/**
 * A resolved connection the assistant can fold into place/event planning:
 * who they are, what they're into, and roughly where they are.
 */
export type ConnectionContext = {
  userId: string;
  name: string;
  interests: string[];
  coords: { lat: number; lng: number } | null;
};

type RawUserRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  interests: string[] | null;
  h3_cell: string | null;
};

function toContext(u: RawUserRow): ConnectionContext {
  const first = (u.first_name ?? "").trim();
  const last = (u.last_name ?? "").trim();
  const name = `${first} ${last}`.trim() || "your connection";
  return {
    userId: u.id,
    name,
    interests: Array.isArray(u.interests) ? u.interests : [],
    coords: u.h3_cell ? cellToLatLngSafe(u.h3_cell) : null,
  };
}

/**
 * Resolve a mentioned connection to one or more accepted partners of the
 * requesting user. Matching is restricted to mutually-accepted connections
 * (privacy). When `ref.userId` is supplied (raw id in the prompt, or a chooser
 * tap) it must belong to the accepted set; otherwise `ref.name` is matched
 * case-insensitively as a substring of first / last / "First Last".
 *
 * Returns [] when nothing matches. Returns >1 when a name is ambiguous so the
 * caller can offer a chooser.
 */
export async function findAcceptedConnections(
  supabase: SupabaseClient,
  requesterId: string,
  ref: { name?: string | null; userId?: string | null }
): Promise<ConnectionContext[]> {
  const { data: connRows, error } = await supabase
    .from("connections")
    .select("requester_id, addressee_id")
    .eq("status", "accepted")
    .or(`requester_id.eq.${requesterId},addressee_id.eq.${requesterId}`);

  if (error || !connRows) return [];

  const partnerIds = new Set<string>();
  for (const row of connRows as Array<{ requester_id: string; addressee_id: string }>) {
    const partner = row.requester_id === requesterId ? row.addressee_id : row.requester_id;
    if (partner && partner !== requesterId) partnerIds.add(partner);
  }
  if (partnerIds.size === 0) return [];

  // Direct id path: raw userId in the prompt, or a chooser-card tap.
  const targetId = ref.userId?.trim();
  if (targetId) {
    if (!partnerIds.has(targetId)) return [];
    const { data } = await supabase
      .from("users")
      .select("id, first_name, last_name, interests, h3_cell")
      .eq("id", targetId)
      .limit(1);
    return ((data as RawUserRow[] | null) ?? []).map(toContext);
  }

  // Name path: substring match across the accepted set.
  const needle = (ref.name ?? "").trim().toLowerCase();
  if (!needle) return [];

  const { data: users } = await supabase
    .from("users")
    .select("id, first_name, last_name, interests, h3_cell")
    .in("id", Array.from(partnerIds));

  return ((users as RawUserRow[] | null) ?? [])
    .filter((u) => {
      const first = (u.first_name ?? "").toLowerCase();
      const last = (u.last_name ?? "").toLowerCase();
      const full = `${first} ${last}`.trim();
      return first.includes(needle) || last.includes(needle) || full.includes(needle);
    })
    .map(toContext);
}

/**
 * Geographic midpoint of two coordinate pairs (plain average — accurate enough
 * at city scale). Falls back to whichever side has coords; null if neither does.
 */
export function midpoint(
  a: { lat: number; lng: number } | null,
  b: { lat: number; lng: number } | null
): { lat: number; lng: number } | null {
  if (a && b) return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
  return a ?? b ?? null;
}
