const FOURSQUARE_BASE = "https://places-api.foursquare.com";
const FOURSQUARE_API_VERSION = "2025-06-17";
const REQUEST_TIMEOUT_MS = 5000;

export interface Place {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  rating?: number;
  types: string[];
  website?: string;
}

type RawFsqCategory = {
  name?: string;
  short_name?: string;
};

type RawFsqLocation = {
  address?: string;
  formatted_address?: string;
  locality?: string;
  region?: string;
  postcode?: string;
  country?: string;
};

type RawFsqPlace = {
  fsq_place_id?: string;
  fsq_id?: string;
  name?: string;
  latitude?: number;
  longitude?: number;
  categories?: RawFsqCategory[];
  location?: RawFsqLocation;
  rating?: number;
  website?: string;
};

function buildAddress(loc: RawFsqLocation | undefined): string {
  if (!loc) return "";
  if (loc.formatted_address) return loc.formatted_address;
  const parts = [
    loc.address,
    loc.locality,
    loc.region,
    loc.postcode,
    loc.country,
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
  return parts.join(", ");
}

function normalizePlace(raw: RawFsqPlace): Place | null {
  const placeId = raw.fsq_place_id ?? raw.fsq_id;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!placeId || !name) return null;

  const types =
    Array.isArray(raw.categories)
      ? raw.categories
          .map((c) => (typeof c.name === "string" ? c.name : c.short_name))
          .filter((t): t is string => typeof t === "string" && t.length > 0)
      : [];

  const out: Place = {
    placeId,
    name,
    address: buildAddress(raw.location),
    lat: typeof raw.latitude === "number" ? raw.latitude : 0,
    lng: typeof raw.longitude === "number" ? raw.longitude : 0,
    types,
  };
  if (typeof raw.rating === "number") out.rating = raw.rating;
  if (typeof raw.website === "string" && raw.website.length > 0) {
    out.website = raw.website;
  }
  return out;
}

async function fsqFetch(apiKey: string, url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "X-Places-Api-Version": FOURSQUARE_API_VERSION,
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchNearbyPlaces(
  apiKey: string,
  lat: number,
  lng: number,
  query: string,
  radiusMeters: number = 5000
): Promise<Place[]> {
  if (!apiKey || !query.trim()) return [];

  const url = new URL(`${FOURSQUARE_BASE}/places/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("ll", `${lat},${lng}`);
  url.searchParams.set("radius", String(Math.min(Math.max(radiusMeters, 1), 100000)));
  url.searchParams.set("limit", "10");

  const json = await fsqFetch(apiKey, url.toString());
  if (!json || typeof json !== "object") return [];

  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  return (results as RawFsqPlace[])
    .map(normalizePlace)
    .filter((p): p is Place => p !== null)
    .slice(0, 10);
}

export async function getPlaceDetails(
  apiKey: string,
  placeId: string
): Promise<Place | null> {
  if (!apiKey || !placeId) return null;

  const url = `${FOURSQUARE_BASE}/places/${encodeURIComponent(placeId)}`;
  const json = await fsqFetch(apiKey, url);
  if (!json || typeof json !== "object") return null;
  return normalizePlace(json as RawFsqPlace);
}
