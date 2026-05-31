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
  imageUrl?: string;
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
  // Top-level lat/lng (returned without a ?fields param in some API versions)
  latitude?: number;
  longitude?: number;
  // Structured geocodes (returned when fields=geocodes is requested)
  geocodes?: { main?: { latitude?: number; longitude?: number } };
  categories?: RawFsqCategory[];
  location?: RawFsqLocation;
  rating?: number;
  website?: string;
  photos?: Array<{ prefix?: string; suffix?: string }>;
};

// Core fields are free-tier; photos is a Premium field (requires paid credits).
// We request photos by default and fall back to core-only if billing fails.
const FOURSQUARE_CORE_FIELDS =
  "fsq_place_id,name,location,geocodes,categories,rating,website";
const FOURSQUARE_PLACE_FIELDS = `${FOURSQUARE_CORE_FIELDS},photos`;

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

function buildPhotoUrl(
  photos: RawFsqPlace["photos"]
): string | undefined {
  if (!Array.isArray(photos)) return undefined;
  for (const photo of photos) {
    if (
      photo &&
      typeof photo.prefix === "string" &&
      photo.prefix.length > 0 &&
      typeof photo.suffix === "string" &&
      photo.suffix.length > 0
    ) {
      return `${photo.prefix}original${photo.suffix}`;
    }
  }
  return undefined;
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

  const lat =
    typeof raw.geocodes?.main?.latitude === "number"
      ? raw.geocodes.main.latitude
      : typeof raw.latitude === "number"
      ? raw.latitude
      : 0;
  const lng =
    typeof raw.geocodes?.main?.longitude === "number"
      ? raw.geocodes.main.longitude
      : typeof raw.longitude === "number"
      ? raw.longitude
      : 0;

  const out: Place = {
    placeId,
    name,
    address: buildAddress(raw.location),
    lat,
    lng,
    types,
  };
  if (typeof raw.rating === "number") out.rating = raw.rating;
  if (typeof raw.website === "string" && raw.website.length > 0) {
    out.website = raw.website;
  }
  const imageUrl = buildPhotoUrl(raw.photos);
  if (imageUrl) out.imageUrl = imageUrl;
  return out;
}

async function fsqFetch(
  apiKey: string,
  url: string
): Promise<{ data: unknown; status: number } | null> {
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
    const data = (await res.json()) as unknown;
    return { data, status: res.status };
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
  url.searchParams.set("fields", FOURSQUARE_PLACE_FIELDS);

  let resp = await fsqFetch(apiKey, url.toString());

  // If the fields param (photos is Premium) causes a billing error, retry
  // without any fields restriction so the free-tier defaults apply.
  if (resp && resp.status !== 200) {
    url.searchParams.delete("fields");
    resp = await fsqFetch(apiKey, url.toString());
  }

  const json = resp?.status === 200 ? resp.data : null;
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

  const url = new URL(`${FOURSQUARE_BASE}/places/${encodeURIComponent(placeId)}`);
  url.searchParams.set("fields", FOURSQUARE_PLACE_FIELDS);

  let resp = await fsqFetch(apiKey, url.toString());

  // If the fields param causes a billing error, retry without fields restriction.
  if (resp && resp.status !== 200) {
    url.searchParams.delete("fields");
    resp = await fsqFetch(apiKey, url.toString());
  }

  const json = resp?.status === 200 ? resp.data : null;
  if (!json || typeof json !== "object") return null;
  return normalizePlace(json as RawFsqPlace);
}
