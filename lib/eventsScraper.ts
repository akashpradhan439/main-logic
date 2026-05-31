import { config } from "../config.js";

const REQUEST_TIMEOUT_MS = 60000;

export interface EventResult {
  title: string;
  date: string;
  time?: string;
  venue?: string;
  address?: string;
  link?: string;
  source?: string;
  price?: string;
  imageUrl?: string;
}

type RawScraperEvent = {
  title?: unknown;
  date?: unknown;
  time?: unknown;
  venue?: unknown;
  address?: unknown;
  url?: unknown;
  source?: unknown;
  price?: unknown;
  imageUrl?: unknown;
};

function s(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return undefined;
  return trimmed;
}

function normalize(raw: RawScraperEvent): EventResult | null {
  const title = s(raw.title);
  const date = s(raw.date);
  if (!title || !date) return null;

  const result: EventResult = { title, date };
  const time = s(raw.time);
  const venue = s(raw.venue);
  const address = s(raw.address);
  const link = s(raw.url);
  const source = s(raw.source);
  const price = s(raw.price);
  const imageUrl = s(raw.imageUrl);

  if (time) result.time = time;
  if (venue) result.venue = venue;
  if (address) result.address = address;
  if (link) result.link = link;
  if (source) result.source = source;
  if (price) result.price = price;
  if (imageUrl) result.imageUrl = imageUrl;
  return result;
}

/**
 * Calls the n8n "Google Events Scraper" workflow. The workflow runs a Playwright
 * fetch with stealth headers + viewport rotation, then asks Groq to extract
 * structured events from the rendered HTML. Returns [] on any failure so the
 * caller (the AI assistant tool) degrades gracefully.
 */
export async function scrapeGoogleEvents(
  query: string,
  location: string | null
): Promise<EventResult[]> {
  if (!query || query.trim().length === 0) return [];
  if (!config.n8nEventsScraperWebhookUrl) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(config.n8nEventsScraperWebhookUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-N8N-Secret": config.n8nWebhookSecret,
      },
      body: JSON.stringify({ query, location: location ?? "" }),
    });

    if (!res.ok) return [];
    const data = (await res.json()) as unknown;

    if (!data || typeof data !== "object") return [];
    const events = (data as { events?: unknown }).events;
    if (!Array.isArray(events)) return [];

    const out: EventResult[] = [];
    const seen = new Set<string>();
    for (const e of events as RawScraperEvent[]) {
      const normalized = normalize(e);
      if (!normalized) continue;
      const key = `${normalized.title.toLowerCase()}|${normalized.date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
      if (out.length >= 10) break;
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
