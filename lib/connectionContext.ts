import pg from "pg";
import { cellToLatLngSafe } from "../shared/h3.js";

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

export async function findAcceptedConnections(
  client: pg.Pool | pg.PoolClient,
  requesterId: string,
  ref: { name?: string | null; userId?: string | null }
): Promise<ConnectionContext[]> {
  try {
    const { rows: connRows } = await client.query(
      "SELECT requester_id, addressee_id FROM connections WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)",
      [requesterId]
    );

    if (!connRows || connRows.length === 0) return [];

    const partnerIds = new Set<string>();
    for (const row of connRows as Array<{ requester_id: string; addressee_id: string }>) {
      const partner = row.requester_id === requesterId ? row.addressee_id : row.requester_id;
      if (partner && partner !== requesterId) partnerIds.add(partner);
    }
    if (partnerIds.size === 0) return [];

    const targetId = ref.userId?.trim();
    if (targetId) {
      if (!partnerIds.has(targetId)) return [];
      const { rows } = await client.query(
        "SELECT id, first_name, last_name, interests, h3_cell FROM users WHERE id = $1 LIMIT 1",
        [targetId]
      );
      return ((rows as RawUserRow[]) ?? []).map(toContext);
    }

    const needle = (ref.name ?? "").trim().toLowerCase();
    if (!needle) return [];

    const { rows: users } = await client.query(
      "SELECT id, first_name, last_name, interests, h3_cell FROM users WHERE id = ANY($1)",
      [Array.from(partnerIds)]
    );

    return ((users as RawUserRow[]) ?? [])
      .filter((u) => {
        const first = (u.first_name ?? "").toLowerCase();
        const last = (u.last_name ?? "").toLowerCase();
        const full = `${first} ${last}`.trim();
        return first.includes(needle) || last.includes(needle) || full.includes(needle);
      })
      .map(toContext);
  } catch {
    return [];
  }
}

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

export async function findNearbyPeople(
  client: pg.Pool | pg.PoolClient,
  requesterId: string
): Promise<NearbyPerson[]> {
  try {
    const { rows: meRows } = await client.query(
      "SELECT h3_cell, h3_neighbors, interests FROM users WHERE id = $1",
      [requesterId]
    );
    if (meRows.length === 0) return [];
    const me = meRows[0] as {
      h3_cell: string | null;
      h3_neighbors: string[] | null;
      interests: string[] | null;
    };

    const myInterests = Array.isArray(me.interests) ? me.interests : [];
    const myCell = me.h3_cell ?? null;
    const myNeighbors = Array.isArray(me.h3_neighbors) ? me.h3_neighbors : [];

    const { rows: connRows } = await client.query(
      "SELECT requester_id, addressee_id FROM connections WHERE requester_id = $1 OR addressee_id = $1",
      [requesterId]
    );
    const excludeIds = new Set<string>([requesterId]);
    for (const row of (connRows as Array<{ requester_id: string; addressee_id: string }>) ?? []) {
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

    const hexes = [myCell, ...myNeighbors].filter(
      (h): h is string => typeof h === "string" && h.length > 0
    );
    if (hexes.length > 0) {
      const { rows: nearbyUsers } = await client.query(
        "SELECT id FROM users WHERE h3_cell = ANY($1) LIMIT 50",
        [hexes]
      );
      for (const u of (nearbyUsers as Array<{ id: string }>) ?? []) {
        if (!excludeIds.has(u.id)) ensure(u.id).isNearby = true;
      }
    }

    const { rows: notifRows } = await client.query(
      "SELECT user_a_id, user_b_id FROM notifications WHERE user_a_id = $1 OR user_b_id = $1 ORDER BY created_at DESC LIMIT 100",
      [requesterId]
    );
    for (const n of (notifRows as Array<{ user_a_id: string; user_b_id: string }>) ?? []) {
      const partner = n.user_a_id === requesterId ? n.user_b_id : n.user_a_id;
      if (partner && !excludeIds.has(partner)) ensure(partner).proximityCount += 1;
    }

    if (signals.size === 0) return [];

    const { rows: users } = await client.query(
      "SELECT id, first_name, last_name, interests, h3_cell FROM users WHERE id = ANY($1)",
      [Array.from(signals.keys())]
    );

    const people: NearbyPerson[] = ((users as RawUserRow[]) ?? []).map((u) => {
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
  } catch {
    return [];
  }
}

export async function findNearbyPersonContext(
  client: pg.Pool | pg.PoolClient,
  requesterId: string,
  personUserId: string
): Promise<ConnectionContext | null> {
  const people = await findNearbyPeople(client, requesterId);
  const match = people.find((p) => p.userId === personUserId);
  if (!match) return null;
  return {
    userId: match.userId,
    name: match.name,
    interests: match.interests,
    coords: match.coords,
  };
}

export function midpoint(
  a: { lat: number; lng: number } | null,
  b: { lat: number; lng: number } | null
): { lat: number; lng: number } | null {
  if (a && b) return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
  return a ?? b ?? null;
}
