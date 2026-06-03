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
 * A person surfaced by the assistant's "who's around me" discovery: someone the
 * requester is NOT yet connected to, ranked by shared interests and proximity.
 * Carries enough context (coords + interests) to plan around once selected.
 */
export type NearbyPerson = {
  userId: string;
  name: string;
  interests: string[];
  sharedInterests: string[];
  coords: { lat: number; lng: number } | null;
  isNearby: boolean;
  proximityCount: number;
};

const MAX_NEARBY_PEOPLE = 10;

function scoreNearby(p: { sharedInterests: string[]; isNearby: boolean; proximityCount: number }): number {
  return p.sharedInterests.length * 3 + p.proximityCount + (p.isNearby ? 1 : 0);
}

/**
 * Discover up to 10 people physically around the requester (same / neighboring
 * H3 cell, or recent proximity history) that they are NOT already connected to,
 * ranked by shared interests then proximity. Mirrors the signal gathering in
 * `routes/ai.ts` but stays self-contained so the assistant can call it as a tool.
 */
export async function findNearbyPeople(
  supabase: SupabaseClient,
  requesterId: string
): Promise<NearbyPerson[]> {
  const { data: meData } = await supabase
    .from("users")
    .select("h3_cell, h3_neighbors, interests")
    .eq("id", requesterId)
    .single();
  if (!meData) return [];
  const me = meData as {
    h3_cell: string | null;
    h3_neighbors: string[] | null;
    interests: string[] | null;
  };

  const myInterests = Array.isArray(me.interests) ? me.interests : [];
  const myCell = me.h3_cell ?? null;
  const myNeighbors = Array.isArray(me.h3_neighbors) ? me.h3_neighbors : [];

  // Exclude self and anyone the requester is already connected to (any status).
  const { data: connRows } = await supabase
    .from("connections")
    .select("requester_id, addressee_id")
    .or(`requester_id.eq.${requesterId},addressee_id.eq.${requesterId}`);
  const excludeIds = new Set<string>([requesterId]);
  for (const row of (connRows as Array<{ requester_id: string; addressee_id: string }> | null) ?? []) {
    const partner = row.requester_id === requesterId ? row.addressee_id : row.requester_id;
    if (partner) excludeIds.add(partner);
  }

  const signals = new Map<string, { isNearby: boolean; proximityCount: number }>();
  const ensure = (id: string) => {
    let s = signals.get(id);
    if (!s) {
      s = { isNearby: false, proximityCount: 0 };
      signals.set(id, s);
    }
    return s;
  };

  // Same / neighboring hex right now.
  const hexes = [myCell, ...myNeighbors].filter(
    (h): h is string => typeof h === "string" && h.length > 0
  );
  if (hexes.length > 0) {
    const { data: nearbyUsers } = await supabase
      .from("users")
      .select("id")
      .in("h3_cell", hexes)
      .limit(50);
    for (const u of (nearbyUsers as Array<{ id: string }> | null) ?? []) {
      if (!excludeIds.has(u.id)) ensure(u.id).isNearby = true;
    }
  }

  // Recent proximity history (hex-overlap notifications).
  const { data: notifRows } = await supabase
    .from("notifications")
    .select("user_a_id, user_b_id")
    .or(`user_a_id.eq.${requesterId},user_b_id.eq.${requesterId}`)
    .order("created_at", { ascending: false })
    .limit(100);
  for (const n of (notifRows as Array<{ user_a_id: string; user_b_id: string }> | null) ?? []) {
    const partner = n.user_a_id === requesterId ? n.user_b_id : n.user_a_id;
    if (partner && !excludeIds.has(partner)) ensure(partner).proximityCount += 1;
  }

  if (signals.size === 0) return [];

  const { data: users } = await supabase
    .from("users")
    .select("id, first_name, last_name, interests, h3_cell")
    .in("id", Array.from(signals.keys()));

  const people: NearbyPerson[] = ((users as RawUserRow[] | null) ?? []).map((u) => {
    const ctx = toContext(u);
    const sig = signals.get(u.id)!;
    const sharedInterests = myInterests.filter((i) => ctx.interests.includes(i));
    return {
      userId: ctx.userId,
      name: ctx.name,
      interests: ctx.interests,
      sharedInterests,
      coords: ctx.coords,
      isNearby: sig.isNearby,
      proximityCount: sig.proximityCount,
    };
  });

  people.sort((a, b) => scoreNearby(b) - scoreNearby(a));
  return people.slice(0, MAX_NEARBY_PEOPLE);
}

/**
 * Resolve a person the user selected from a "who's around me" list into a
 * planning context. Re-runs discovery and matches by id so a user can only
 * plan around someone genuinely surfaced as nearby (privacy guard).
 */
export async function findNearbyPersonContext(
  supabase: SupabaseClient,
  requesterId: string,
  personUserId: string
): Promise<ConnectionContext | null> {
  const people = await findNearbyPeople(supabase, requesterId);
  const match = people.find((p) => p.userId === personUserId);
  if (!match) return null;
  return {
    userId: match.userId,
    name: match.name,
    interests: match.interests,
    coords: match.coords,
  };
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
