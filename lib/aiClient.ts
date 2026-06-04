import type OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { getAzureClient, getAzureDeployment, isAzureConfigured } from "./azureClient.js";
import {
  searchNearbyPlaces,
  getPlaceDetails,
  type Place,
} from "./foursquareClient.js";
import { scrapeGoogleEvents, type EventResult } from "./eventsScraper.js";
import { midpoint, type ConnectionContext, type NearbyPerson } from "./connectionContext.js";

export type SuggestionCandidate = {
  userId: string;
  firstName: string;
  bio: string | null;
  interests: string[];
  signals: {
    isNearby: boolean;
    proximityCount: number;
    mutualConnections: number;
    sharedInterests: string[];
  };
};

export type SuggestionResult = {
  userId: string;
  reason: string;
};

const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  ar: "Arabic",
  bn: "Bangla (Bengali)",
  es: "Spanish",
  fr: "French",
  hi: "Hindi",
  ja: "Japanese",
  pt: "Portuguese",
  ru: "Russian",
  "zh-Hans": "Simplified Chinese",
  "zh-Hant": "Traditional Chinese",
};

function languageLabel(code: string | null | undefined): string {
  if (!code) return "English";
  return LANGUAGE_LABELS[code] ?? "English";
}

function languageInstruction(code: string | null | undefined): string {
  const label = languageLabel(code);
  if (label === "English") {
    return "Write every user-facing text field in English.";
  }
  return `Write every user-facing text field in ${label}. JSON keys and identifiers MUST stay in English; only the human-readable text values are translated.`;
}

function buildConnectionsSystemPrompt(languageCode: string | null | undefined): string {
  return `You are a connection suggestion assistant for a location-based privacy-focused social app.
Rank the candidates and provide a brief friendly reason (1-2 sentences) for each.
Base reasoning on: shared interests, location overlap, mutual connections.
${languageInstruction(languageCode)}
Return ONLY a valid JSON object with this exact shape: {"suggestions":[{"userId":"...","reason":"..."}]}
Sort by best match first. Omit candidates with no meaningful signals.
Do not include markdown, code fences, or any text outside the JSON object.`;
}

function fallbackReasons(candidates: SuggestionCandidate[]): SuggestionResult[] {
  return candidates.map((c) => {
    const parts: string[] = [];
    if (c.signals.sharedInterests.length > 0) {
      parts.push(`You both like ${c.signals.sharedInterests.slice(0, 2).join(" and ")}.`);
    }
    if (c.signals.mutualConnections > 0) {
      parts.push(
        `You have ${c.signals.mutualConnections} mutual connection${c.signals.mutualConnections === 1 ? "" : "s"}.`
      );
    }
    if (c.signals.isNearby || c.signals.proximityCount > 0) {
      parts.push("You've been in the same area recently.");
    }
    return {
      userId: c.userId,
      reason: parts.length > 0 ? parts.join(" ") : "Suggested based on activity nearby.",
    };
  });
}

function buildInterestsSystemPrompt(languageCode: string | null | undefined): string {
  return `You are a helpful assistant for a social app.
Given a user's bio, suggest 5 to 10 relevant personal interests.
${languageInstruction(languageCode)}
Return ONLY a valid JSON object with this exact shape: {"interests":["interest1","interest2",...]}
Each interest should be a short lowercase word or phrase (1-3 words). Be specific and personal.
Do not include markdown, code fences, or any text outside the JSON object.`;
}

export async function suggestInterests(bio: string, languageCode?: string | null): Promise<string[]> {
  const client = getAzureClient();
  if (!client) return [];

  try {
    const completion = await client.chat.completions.create({
      model: getAzureDeployment(),
      max_tokens: 256,
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildInterestsSystemPrompt(languageCode) },
        { role: "user", content: bio },
      ],
    });

    const text = completion.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(text) as unknown;

    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { interests?: unknown }).interests)
    ) {
      return ((parsed as { interests: unknown[] }).interests)
        .filter((i): i is string => typeof i === "string")
        .map((i) => i.trim())
        .filter((i) => i.length > 0)
        .slice(0, 10);
    }

    return [];
  } catch {
    return [];
  }
}

export async function suggestConnections(
  currentUser: { bio: string | null; interests: string[] },
  candidates: SuggestionCandidate[],
  languageCode?: string | null
): Promise<SuggestionResult[]> {
  if (candidates.length === 0) return [];

  const client = getAzureClient();
  if (!client) {
    return fallbackReasons(candidates);
  }

  try {
    const completion = await client.chat.completions.create({
      model: getAzureDeployment(),
      max_tokens: 1024,
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildConnectionsSystemPrompt(languageCode) },
        {
          role: "user",
          content: JSON.stringify({ currentUser, candidates }),
        },
      ],
    });

    const text = completion.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(text) as unknown;

    let arr: unknown;
    if (Array.isArray(parsed)) {
      arr = parsed;
    } else if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { suggestions?: unknown }).suggestions)
    ) {
      arr = (parsed as { suggestions: unknown[] }).suggestions;
    } else {
      return fallbackReasons(candidates);
    }

    const validIds = new Set(candidates.map((c) => c.userId));
    const cleaned: SuggestionResult[] = [];
    for (const item of arr as unknown[]) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as { userId?: unknown }).userId === "string" &&
        typeof (item as { reason?: unknown }).reason === "string" &&
        validIds.has((item as { userId: string }).userId)
      ) {
        cleaned.push({
          userId: (item as { userId: string }).userId,
          reason: (item as { reason: string }).reason,
        });
      }
    }

    return cleaned.length > 0 ? cleaned : fallbackReasons(candidates);
  } catch {
    return fallbackReasons(candidates);
  }
}

// ─── AI Assistant: chat with tool calling ─────────────────────────────────────

export type AssistantUserContext = {
  firstName: string;
  bio: string | null;
  interests: string[];
  language: string;
  coords: { lat: number; lng: number } | null;
};

export type ConnectionMatch = {
  userId: string;
  name: string;
  interests: string[];
};

export type AssistantCard =
  | { type: "places"; data: Place[] }
  | { type: "events"; data: EventResult[] }
  | { type: "place_detail"; data: Place }
  | { type: "connections"; data: ConnectionMatch[] }
  | { type: "people"; data: NearbyPerson[] };

/** A function the route injects to resolve a mentioned connection (bound to
 * supabase + the requesting user id). Keeps aiClient free of Supabase. */
export type ConnectionResolver = (ref: {
  name?: string | null;
  userId?: string | null;
}) => Promise<ConnectionContext[]>;

/** A meet-up suggestion the user tapped "Plan it" on. The fields are free text
 * from the suggestion engine (n8n), NOT Foursquare IDs, so the assistant opens
 * the conversation grounded in the idea and searches for the named spot. */
export type SuggestionSeed = {
  title?: string | null | undefined;
  place?: string | null | undefined;
  time?: string | null | undefined;
};

export type AssistantConnectionOptions = {
  /** Connections carried forward from prior turns (seeded from message metadata). */
  rememberedConnections?: ConnectionContext[];
  /** Resolver for connections newly named in this turn. */
  resolveConnections?: ConnectionResolver;
  /** Discover up to 10 people around the user with shared interests (bound to
   * supabase + the requesting user id). Keeps aiClient free of Supabase. */
  findNearbyPeople?: () => Promise<NearbyPerson[]>;
  /** When the user tapped "Plan it" on a meet-up suggestion, its details so the
   * assistant can open the conversation grounded in that specific idea. */
  suggestionSeed?: SuggestionSeed | undefined;
};

/**
 * Optional realtime introspection hook (additive). Lets a UI narrate the
 * assistant's inference as it happens. Steps are mapped onto the same four
 * agent roles used by the swarm so the demo can color them consistently:
 *   planner   → intent classification
 *   researcher→ connection resolution + live tool calls (places/events)
 *   executor  → reply composition
 *   critic    → grounding / no-fabrication note
 * Default is a no-op, so existing callers are unaffected.
 */
export type AssistantStep =
  | { type: "agent"; agent: "planner" | "researcher" | "executor" | "critic"; message: string }
  | { type: "token"; delta: string }
  | { type: "card"; card: AssistantCard };
export type AssistantStepEmit = (step: AssistantStep) => void;

/** Sentinel default so we can tell whether a caller actually wants introspection
 * (and thus live token streaming) vs the production no-op. */
const NOOP_STEP: AssistantStepEmit = () => {};

const SEARCH_PLACES_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_places",
    description:
      "Search for nearby places (restaurants, cafes, parks, venues, attractions, etc.). " +
      "Use when the user asks where to go, eat, drink, or hang out. " +
      "Returns a list of places with name, address, and coordinates. " +
      "Only call this tool ONCE per turn.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Short search phrase or category, e.g. 'coffee shop', 'pizza', 'park', 'museum', 'rooftop bar', 'gym'. " +
            "Keep it 1-3 words. Do not include location words — the server already knows the user's coordinates.",
        },
        radius: {
          type: "number",
          description: "Search radius in metres (default 5000, max 100000).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

const SEARCH_EVENTS_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_events",
    description:
      "Search for real-world events (concerts, festivals, meetups, sports, exhibitions). " +
      "Use when the user asks what's happening, what to do this weekend, or about specific event types. " +
      "Always include a city name in the query when one is known (the user's city or one mentioned in the conversation).",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Event topic plus a city name when available, e.g. 'live music Delhi', 'food festival Hyderabad', 'tech meetup Bangalore'. If no city is known, just the topic.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

const GET_PLACE_DETAILS_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_place_details",
    description:
      "Get detailed information about a specific place by its placeId. " +
      "Use this only after a previous search_places call returned a place the user is now asking more about.",
    parameters: {
      type: "object",
      properties: {
        placeId: {
          type: "string",
          description: "The placeId returned from a previous search_places result.",
        },
      },
      required: ["placeId"],
      additionalProperties: false,
    },
  },
};

function buildAssistantSystemPrompt(ctx: AssistantUserContext): string {
  const lines: string[] = [
    `You are a friendly, knowledgeable local guide assistant for ${ctx.firstName}.`,
    `You help them discover places, events, and things to do in their area.`,
  ];

  if (ctx.coords) {
    lines.push(
      `The user is currently near coordinates ${ctx.coords.lat.toFixed(
        4
      )}, ${ctx.coords.lng.toFixed(4)}.`
    );
  } else {
    lines.push(
      `The user's exact location is not available; keep place suggestions general and acknowledge if asked.`
    );
  }

  if (ctx.interests.length > 0) {
    lines.push(`Their stated interests include: ${ctx.interests.join(", ")}.`);
  }
  if (ctx.bio) {
    lines.push(`About the user: ${ctx.bio}`);
  }

  lines.push(
    ``,
    `Tool usage rules — read carefully:`,
    `- Call search_places when the user asks about a category of places to visit, eat, drink, or hang out.`,
    `- Call search_events when the user asks about events, concerts, festivals, meetups, or things happening at a date/time.`,
    `- Call get_place_details when the user asks for more information about a specific place that was already returned by search_places.`,
    `- When a tool is offered, call it for any place/event question instead of answering from memory, and never invent place names, addresses, or events.`,
    `- Tool arguments MUST exactly match the declared schema. Do NOT add extra fields like latitude, longitude, location — the server already knows the user's location.`,
    `- search_places.query should be a short phrase (1-3 words) like 'coffee shop', 'rooftop bar', 'park', 'gym'. Do not include location words — the server already knows the user's coordinates.`,
    `- If the user is just chatting or asking general advice, reply directly without calling any tool.`,
    ``,
    `After receiving tool results, write a warm, conversational reply that weaves in the specific names returned.`,
    `If no results were found, acknowledge it gracefully (e.g., "I couldn't find any nearby right now") and offer one or two general suggestions based on the user's interests. Do not retry or invent another search.`,
    ``,
    languageInstruction(ctx.language),
    `Keep replies concise (2-4 sentences). Never fabricate place names, addresses, ratings, or events.`,
    `Do not expose raw JSON, IDs, function-call syntax, or any technical details in your reply.`,
    `Never write text that looks like a tool call (no "<function=...>" or "function_call" strings) — your reply is plain conversational text only.`
  );

  return lines.join("\n");
}

type ToolFanOutResult = {
  toolMessage: {
    role: "tool";
    tool_call_id: string;
    content: string;
  };
  card: AssistantCard | null;
};

async function executeToolCall(
  toolCall: ChatCompletionMessageToolCall,
  ctx: AssistantUserContext,
  foursquareApiKey: string
): Promise<ToolFanOutResult> {
  // OpenAI SDK v6 tool calls always have function-shaped payloads under .function;
  // keep this defensive in case a custom tool type appears later.
  const fn = (toolCall as { function?: { name?: string; arguments?: string } }).function;
  const name = fn?.name ?? "";
  const argsRaw = fn?.arguments ?? "{}";

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsRaw);
  } catch {
    return {
      toolMessage: {
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify({ error: "Invalid tool arguments." }),
      },
      card: null,
    };
  }

  try {
    if (name === "search_places") {
      const query = typeof args["query"] === "string" ? args["query"] : "";
      const radius =
        typeof args["radius"] === "number" && args["radius"] > 0
          ? Math.min(args["radius"], 5000)
          : 5000;
      if (!ctx.coords || !query) {
        return {
          toolMessage: {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(
              !ctx.coords
                ? { message: "User location unavailable; cannot search nearby." }
                : { message: "No query provided." }
            ),
          },
          card: null,
        };
      }
      const places = await searchNearbyPlaces(
        foursquareApiKey,
        ctx.coords.lat,
        ctx.coords.lng,
        query,
        radius
      );
      const summary =
        places.length === 0
          ? { message: "No places found." }
          : {
              places: places.map((p) => ({
                placeId: p.placeId,
                name: p.name,
                address: p.address,
                rating: p.rating,
                types: p.types,
              })),
            };
      return {
        toolMessage: {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(summary),
        },
        card: places.length > 0 ? { type: "places", data: places } : null,
      };
    }

    if (name === "search_events") {
      const query = typeof args["query"] === "string" ? args["query"] : "";
      // Google's events search doesn't understand raw lat/lng as a query suffix;
      // it expects a city name. The model is told via the tool description to
      // include a city in the query itself, so we don't pass coords here.
      const locationStr: string | null = null;
      if (!query) {
        return {
          toolMessage: {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ message: "No query provided." }),
          },
          card: null,
        };
      }
      const events = await scrapeGoogleEvents(query, locationStr);
      const summary =
        events.length === 0
          ? { message: "No events found." }
          : {
              // Cap field lengths — scraped date/time strings are sometimes
              // malformed (e.g. repeated date ranges) and can seed a model
              // token-loop if passed verbatim.
              events: events.map((e) => ({
                title: cap(e.title, 80),
                date: cap(e.date, 40),
                time: cap(e.time, 40),
                venue: cap(e.venue, 80),
                address: cap(e.address, 120),
              })),
            };
      return {
        toolMessage: {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(summary),
        },
        card: events.length > 0 ? { type: "events", data: events } : null,
      };
    }

    if (name === "get_place_details") {
      const placeId = typeof args["placeId"] === "string" ? args["placeId"] : "";
      if (!placeId) {
        return {
          toolMessage: {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ message: "No placeId provided." }),
          },
          card: null,
        };
      }
      const detail = await getPlaceDetails(foursquareApiKey, placeId);
      const summary = detail
        ? {
            place: {
              placeId: detail.placeId,
              name: detail.name,
              address: detail.address,
              rating: detail.rating,
              types: detail.types,
            },
          }
        : { message: "Place not found." };
      return {
        toolMessage: {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(summary),
        },
        card: detail ? { type: "place_detail", data: detail } : null,
      };
    }

    return {
      toolMessage: {
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify({ error: `Unknown tool: ${name}` }),
      },
      card: null,
    };
  } catch {
    return {
      toolMessage: {
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify({ message: "Tool execution failed; no results." }),
      },
      card: null,
    };
  }
}

// Repetition penalties discourage the model from falling into a degenerate
// token-loop (e.g. "7 7 7 7 …") when tool results contain messy values.
const REPLY_FREQUENCY_PENALTY = 0.5;
const REPLY_PRESENCE_PENALTY = 0.3;

/** Truncate a possibly-undefined string to a max length (defensive). */
function cap(s: string | undefined, n: number): string | undefined {
  if (typeof s !== "string") return s;
  const t = s.trim();
  return t.length > n ? t.slice(0, n) : t;
}

/** True when the recent output has collapsed into a low-diversity loop. */
function looksLikeLoop(text: string): boolean {
  const toks = text.trim().split(/\s+/);
  if (toks.length < 40) return false;
  const last = toks.slice(-40);
  return new Set(last).size <= 3;
}

/** Collapse runaway repetition and trim a degenerate tail so a looped reply
 * never reaches the user even if the model misbehaves. */
function sanitizeReply(text: string): string {
  if (!text) return text;
  // Collapse 3+ consecutive repeats of the same short token to one.
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    out.push(words[i]!);
    let j = i + 1;
    while (j < words.length && words[j] === words[i]) j++;
    i = j - i >= 3 ? j : i + 1;
  }
  let cleaned = out.join(" ");
  // Drop a trailing low-diversity window (e.g. an alternating "7 2026 7 2026" tail).
  let toks = cleaned.split(/\s+/);
  while (toks.length > 12) {
    const w = toks.slice(-30);
    if (w.length >= 20 && new Set(w).size <= 3) toks = toks.slice(0, -1);
    else break;
  }
  cleaned = toks.join(" ").trim();
  return cleaned;
}

async function noToolsCompletion(
  messages: ChatCompletionMessageParam[],
  onToken?: (delta: string) => void
): Promise<string> {
  const client = getAzureClient();
  if (!client) return "";
  if (onToken) {
    const stream = await client.chat.completions.create({
      model: getAzureDeployment(),
      max_tokens: 1024,
      temperature: 0.6,
      frequency_penalty: REPLY_FREQUENCY_PENALTY,
      presence_penalty: REPLY_PRESENCE_PENALTY,
      stream: true,
      messages,
    });
    let full = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        full += delta;
        try { onToken(delta); } catch { /* ignore emitter errors */ }
        if (looksLikeLoop(full)) break; // stop a degenerate token-loop early
      }
    }
    if (full.trim()) return sanitizeReply(full);
    // Empty stream — fall through to a non-streamed completion below.
  }
  const c = await client.chat.completions.create({
    model: getAzureDeployment(),
    max_tokens: 1024,
    temperature: 0.6,
    frequency_penalty: REPLY_FREQUENCY_PENALTY,
    presence_penalty: REPLY_PRESENCE_PENALTY,
    messages,
  });
  return sanitizeReply(c.choices[0]?.message?.content ?? "");
}

type AssistantToolName = "search_places" | "search_events" | "get_place_details";

const ASSISTANT_TOOLS_BY_NAME: Record<AssistantToolName, ChatCompletionTool> = {
  search_places: SEARCH_PLACES_TOOL,
  search_events: SEARCH_EVENTS_TOOL,
  get_place_details: GET_PLACE_DETAILS_TOOL,
};

type TurnClassification = {
  tool: AssistantToolName | null;
  findPeople: boolean;
  /** When the user wants nearby people filtered by a name fragment. */
  peopleNameFilter: string | null;
  connection: { mentioned: boolean; name: string | null; userId: string | null };
};

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

// This Foundry deployment rejects any request that offers more than one tool
// (400 UnsupportedToolUse: "does not support more than one tool call"). So we
// classify the user's intent first and offer at most ONE tool on the main call.
// The same JSON pass also extracts any connection the user named, so connection
// awareness costs no extra LLM round-trip. A no-tools JSON completion never
// trips the one-tool limit.
async function classifyTurn(
  client: OpenAI,
  deployment: string,
  userMessage: string,
  history: Array<{ role: "user" | "assistant"; content: string }>
): Promise<TurnClassification> {
  const empty: TurnClassification = {
    tool: null,
    findPeople: false,
    peopleNameFilter: null,
    connection: { mentioned: false, name: null, userId: null },
  };
  const recent = history
    .slice(-4)
    .map((h) => `${h.role}: ${h.content}`)
    .join("\n");
  const system =
    `Classify the user's latest message for a local-guide assistant.\n` +
    `Return ONLY JSON: {"tool":"search_places"|"search_events"|"get_place_details"|"none","findPeople":boolean,"peopleNameFilter":string|null,"connection":{"mentioned":boolean,"name":string|null,"userId":string|null}}.\n` +
    `tool:\n` +
    `- search_places: they want somewhere to go, eat, drink, or visit (cafes, restaurants, parks, bars, gyms, attractions).\n` +
    `- search_events: they ask about events, concerts, festivals, gigs, or what's happening on a date.\n` +
    `- get_place_details: they ask for more detail about one specific place already mentioned.\n` +
    `- none: greetings, small talk, general advice, or anything not needing live place/event data.\n` +
    `findPeople: set true when the user wants to DISCOVER people around them or with similar interests ` +
    `(e.g. "who's around me", "who has similar interests like me", "find people near me", "anyone nearby into hiking"). ` +
    `This is about meeting NEW people, not an existing friend. When findPeople is true, set tool to "none".\n` +
    `peopleNameFilter: when findPeople is true AND the user is asking specifically for nearby people whose NAME matches something (e.g. "people with Ram in their name", "anyone called Priya nearby", "is there a Ravi around me"), put just that name fragment here (e.g. "Ram"); otherwise null.\n` +
    `connection: set mentioned=true when the user refers to a specific friend/connection they want to involve in plans (e.g. "meet John", "plan with Sarah", "somewhere near Alex"). ` +
    `Put the person's name in "name" (else null) and any UUID present in "userId" (else null). ` +
    `Do NOT treat place names, cities, or venues as connections.`;
  const user = (recent ? `Recent conversation:\n${recent}\n\n` : "") + `Latest message: ${userMessage}`;
  const uuidInMessage = userMessage.match(UUID_RE)?.[0] ?? null;
  try {
    const c = await client.chat.completions.create({
      model: deployment,
      max_tokens: 80,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const parsed = JSON.parse(c.choices[0]?.message?.content ?? "{}") as {
      tool?: unknown;
      findPeople?: unknown;
      peopleNameFilter?: unknown;
      connection?: { mentioned?: unknown; name?: unknown; userId?: unknown };
    };
    const findPeople = parsed.findPeople === true;
    const peopleNameFilter =
      typeof parsed.peopleNameFilter === "string" && parsed.peopleNameFilter.trim()
        ? parsed.peopleNameFilter.trim()
        : null;
    const t = parsed.tool;
    // Discovery short-circuits any place/event tool for this turn.
    const tool: AssistantToolName | null = findPeople
      ? null
      : t === "search_places" || t === "search_events" || t === "get_place_details"
        ? t
        : null;
    const conn = parsed.connection ?? {};
    const name = typeof conn.name === "string" && conn.name.trim() ? conn.name.trim() : null;
    const userId =
      (typeof conn.userId === "string" && UUID_RE.test(conn.userId) ? conn.userId : null) ??
      uuidInMessage;
    const mentioned = conn.mentioned === true || name !== null || userId !== null;
    return { tool, findPeople, peopleNameFilter, connection: { mentioned, name, userId } };
  } catch {
    // Even on classifier failure, honor a raw UUID in the message.
    if (uuidInMessage) {
      return { tool: null, findPeople: false, peopleNameFilter: null, connection: { mentioned: true, name: null, userId: uuidInMessage } };
    }
    return empty;
  }
}

export async function chatWithAssistant(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  userMessage: string,
  userContext: AssistantUserContext,
  foursquareApiKey: string,
  tappedPlace: Place | null = null,
  connectionOptions: AssistantConnectionOptions = {},
  onStep: AssistantStepEmit = NOOP_STEP
): Promise<{
  reply: string;
  cards: AssistantCard[];
  rememberedConnections: ConnectionContext[];
}> {
  if (!isAzureConfigured()) {
    throw new Error(
      "Azure OpenAI not configured. Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY."
    );
  }
  const client = getAzureClient()!;
  const deployment = getAzureDeployment();
  const systemPrompt = buildAssistantSystemPrompt(userContext);

  // Live token streaming for the user-visible reply — only when a caller actually
  // wants introspection (demo), so production stays on the non-streaming path.
  const uiAttached = onStep !== NOOP_STEP;
  const streamToken: ((delta: string) => void) | undefined = uiAttached
    ? (delta) => onStep({ type: "token", delta })
    : undefined;

  // Connections carried forward from earlier turns (deduped by userId).
  const remembered: ConnectionContext[] = [];
  for (const c of connectionOptions.rememberedConnections ?? []) {
    if (c && typeof c.userId === "string" && !remembered.some((r) => r.userId === c.userId)) {
      remembered.push(c);
    }
  }

  // Tap UX short-circuit: the user tapped a specific place card; the client
  // wants a focused reply about THAT place. Skip the tool-call pass entirely
  // and produce a single prose completion grounded in the pre-fetched detail.
  if (tappedPlace) {
    onStep({ type: "agent", agent: "researcher", message: `Loaded tapped place: ${tappedPlace.name}` });
    onStep({ type: "agent", agent: "executor", message: "Composing reply about the tapped place" });
    const tapSystem =
      `The user just tapped a place card in the app. Detail data already fetched:\n` +
      JSON.stringify({
        placeId: tappedPlace.placeId,
        name: tappedPlace.name,
        address: tappedPlace.address,
        rating: tappedPlace.rating,
        types: tappedPlace.types,
        website: tappedPlace.website,
      }) +
      `\nWrite a short, warm reply (2-3 sentences) about THIS place by name. Do not list other places. Do not call any tool. Do not reveal the placeId.`;

    const tapMessages: ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "system", content: tapSystem },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: userMessage },
    ];

    const reply = await noToolsCompletion(tapMessages, streamToken);
    onStep({ type: "card", card: { type: "place_detail", data: tappedPlace } });
    return {
      reply,
      cards: [{ type: "place_detail", data: tappedPlace }],
      rememberedConnections: remembered,
    };
  }

  // Classify intent + extract any named connection in a single JSON pass.
  onStep({ type: "agent", agent: "planner", message: "Classifying intent (tool + connection)…" });
  let { tool: selectedTool, findPeople, peopleNameFilter, connection } = await classifyTurn(
    client,
    deployment,
    userMessage,
    history
  );
  onStep({
    type: "agent",
    agent: "planner",
    message: `Intent → tool=${selectedTool ?? "none"}${findPeople ? ", findPeople=true" : ""}${connection.mentioned ? `, connection=${connection.name ?? connection.userId ?? "mentioned"}` : ""}`,
  });

  // "Who's around me / with similar interests" discovery short-circuit. Fetches
  // up to 10 nearby people via the injected resolver, surfaces a chooser card,
  // and invites the user to pick one to plan around. Handled here (not as an
  // OpenAI tool) so aiClient stays Supabase-free and we avoid the deployment's
  // one-tool-per-request limit.
  if (findPeople && connectionOptions.findNearbyPeople) {
    const filterNote = peopleNameFilter ? ` matching "${peopleNameFilter}"` : "";
    onStep({ type: "agent", agent: "researcher", message: `Searching for nearby people${filterNote || " with shared interests"}…` });
    let people: NearbyPerson[] = [];
    try {
      people = (await connectionOptions.findNearbyPeople()).slice(0, 10);
    } catch {
      people = [];
    }

    // Name filter: if the user asked for people whose name matches, narrow the
    // discovered set. This keeps the reply truthful instead of dumping unrelated
    // people when the user asked for a specific name.
    const discovered = people;
    if (peopleNameFilter) {
      const needle = peopleNameFilter.toLowerCase();
      people = people.filter((p) => p.name.toLowerCase().includes(needle));
    }
    onStep({
      type: "agent",
      agent: "researcher",
      message: peopleNameFilter
        ? `${people.length} of ${discovered.length} nearby match "${peopleNameFilter}"`
        : `Found ${people.length} nearby person(s)`,
    });

    let peopleSystem: string;
    if (people.length > 0) {
      peopleSystem =
        `The user asked to find people around them${peopleNameFilter ? ` whose name matches "${peopleNameFilter}"` : ""}. ` +
        `Here is the result (already fetched — do NOT call any tool):\n` +
        JSON.stringify({ people: people.map((p) => ({ name: p.name, sharedInterests: p.sharedInterests, nearby: p.isNearby })) }) +
        `\nWrite a warm 2-4 sentence reply that lists these people by name, mentioning a shared interest where there is one. ` +
        `End by inviting the user to pick someone (tap a name) so you can help plan a meetup. ` +
        `Use ONLY the names provided — never invent people, never claim a name matches if it doesn't, and do not reveal any IDs.`;
    } else if (peopleNameFilter) {
      // Asked for a specific name, none nearby matched — be clear, don't dump others.
      peopleSystem =
        `The user asked for nearby people whose name matches "${peopleNameFilter}", but NONE of the people around them match that name. ` +
        `Tell them plainly that you couldn't find anyone named "${peopleNameFilter}" nearby right now. ` +
        `${discovered.length > 0 ? `You may offer that there are ${discovered.length} other people nearby they could discover if they'd like. ` : ""}` +
        `Do NOT list names, and do NOT invent anyone.`;
    } else {
      peopleSystem =
        `No people are around the user right now. Gently let them know nobody nearby matched yet and suggest they check back later or widen their interests. Do not invent any names.`;
    }

    const peopleMessages: ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "system", content: peopleSystem },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: userMessage },
    ];
    onStep({ type: "agent", agent: "executor", message: "Composing the nearby-people list" });
    const reply = await noToolsCompletion(peopleMessages, streamToken);

    // Only surface the (clickable) people card when there is something to show.
    const cards: AssistantCard[] = people.length > 0 ? [{ type: "people", data: people }] : [];
    for (const card of cards) onStep({ type: "card", card });
    onStep({ type: "agent", agent: "critic", message: `Grounded in ${people.length} discovered profile(s); no fabricated names` });
    return { reply, cards, rememberedConnections: remembered };
  }

  // Resolve a newly named connection against the user's accepted connections.
  const connNotes: string[] = [];
  if (connection.mentioned && connectionOptions.resolveConnections) {
    onStep({ type: "agent", agent: "researcher", message: `Resolving connection "${connection.name ?? connection.userId ?? ""}" against accepted connections…` });
    const matches = await connectionOptions.resolveConnections({
      name: connection.name,
      userId: connection.userId,
    });
    if (matches.length > 1) {
      onStep({ type: "agent", agent: "researcher", message: `Ambiguous — ${matches.length} connections matched; asking user to choose` });
      // Ambiguous — offer a chooser card and ask which one. Don't remember,
      // don't run a place/event search this turn.
      const names = matches.map((m) => m.name).join(", ");
      const chooserMessages: ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
        {
          role: "system",
          content:
            `The user referred to a connection, but several accepted connections match: ${names}. ` +
            `Briefly ask which one they mean. Do not assume, and do not list any places or events yet.`,
        },
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: "user", content: userMessage },
      ];
      onStep({ type: "agent", agent: "executor", message: "Composing clarifying question" });
      const reply = await noToolsCompletion(chooserMessages, streamToken);
      const chooserCard: AssistantCard = {
        type: "connections",
        data: matches.map((m) => ({ userId: m.userId, name: m.name, interests: m.interests })),
      };
      onStep({ type: "card", card: chooserCard });
      return {
        reply,
        cards: [chooserCard],
        rememberedConnections: remembered,
      };
    }
    const [match] = matches;
    if (match) {
      if (!remembered.some((r) => r.userId === match.userId)) remembered.push(match);
      onStep({ type: "agent", agent: "researcher", message: `Resolved connection: ${match.name}${match.coords ? " (will plan around midpoint)" : ""}` });
    } else {
      onStep({ type: "agent", agent: "researcher", message: "No accepted connection matched" });
      connNotes.push(
        `Note: no accepted connection matched "${connection.name ?? connection.userId}". ` +
          `Tell the user you couldn't find that connection, then keep helping.`
      );
    }
  }

  const suggestionSeed = connectionOptions.suggestionSeed;

  // The connection we plan around this turn is the most recently remembered one.
  const activeConnection = remembered.length > 0 ? remembered[remembered.length - 1] : null;

  // "Plan it" with an exact venue: the suggestion named a real spot (free text,
  // not a placeId). Resolve it to a concrete Foursquare place near the
  // user↔connection midpoint and open the conversation on THAT exact place
  // (deterministic place_detail) instead of a fuzzy search. Falls back to a
  // place search only if the named spot can't be resolved.
  if (suggestionSeed?.place) {
    const center = midpoint(userContext.coords, activeConnection?.coords ?? null);
    let resolved: Place | null = null;
    if (center) {
      onStep({ type: "agent", agent: "researcher", message: `Resolving exact place "${suggestionSeed.place}"…` });
      const matches = await searchNearbyPlaces(
        foursquareApiKey,
        center.lat,
        center.lng,
        suggestionSeed.place
      );
      const wanted = suggestionSeed.place.trim().toLowerCase();
      // Prefer an exact (case-insensitive) name match; else the top-ranked hit.
      const top = matches.find((p) => p.name.trim().toLowerCase() === wanted) ?? matches[0] ?? null;
      // Enrich to full detail (website/photos) like a card tap would.
      if (top) resolved = (await getPlaceDetails(foursquareApiKey, top.placeId)) ?? top;
    }

    if (resolved) {
      onStep({ type: "agent", agent: "researcher", message: `Resolved to ${resolved.name}` });
      onStep({ type: "agent", agent: "executor", message: "Opening the plan around the exact spot" });
      const planBits: string[] = [];
      if (suggestionSeed.title) planBits.push(`"${suggestionSeed.title}"`);
      if (suggestionSeed.time) planBits.push(`around ${suggestionSeed.time}`);
      const withWhom = activeConnection ? ` with ${activeConnection.name}` : "";
      const seedSystem =
        `The user tapped "Plan it" on a meet-up suggestion${withWhom}` +
        `${planBits.length ? ` (${planBits.join(", ")})` : ""}. ` +
        `The suggested spot resolved to this exact place (already fetched — do NOT call any tool):\n` +
        JSON.stringify({
          name: resolved.name,
          address: resolved.address,
          types: resolved.types,
          rating: resolved.rating,
          website: resolved.website,
        }) +
        `\nWrite a warm 2-3 sentence reply that opens the plan: acknowledge the meet-up${withWhom}, ` +
        `confirm ${resolved.name} as the spot${suggestionSeed.time ? ` ${suggestionSeed.time}` : ""}, ` +
        `and invite them to refine it (time, or pick a different place). ` +
        `Do not list other places and do not reveal any IDs.`;
      const seedMessages: ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
        { role: "system", content: seedSystem },
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: "user", content: userMessage },
      ];
      const reply = await noToolsCompletion(seedMessages, streamToken);
      onStep({ type: "card", card: { type: "place_detail", data: resolved } });
      onStep({ type: "agent", agent: "critic", message: `Grounded in exact place: ${resolved.name}` });
      return {
        reply,
        cards: [{ type: "place_detail", data: resolved }],
        rememberedConnections: remembered,
      };
    }

    onStep({ type: "agent", agent: "researcher", message: `Couldn't resolve "${suggestionSeed.place}"; falling back to a place search` });
    // Named spot not found — still surface actionable options.
    if (!selectedTool) selectedTool = "search_places";
  } else if (!selectedTool && suggestionSeed?.title) {
    // A seed with no named place (e.g. a one-liner suggestion) still opens with
    // venue options rather than plain prose.
    selectedTool = "search_places";
  }

  // Place searches center on the midpoint between the user and the connection.
  let effectiveCoords = userContext.coords;
  if (activeConnection && selectedTool === "search_places") {
    effectiveCoords = midpoint(userContext.coords, activeConnection.coords);
  }
  const toolContext: AssistantUserContext = { ...userContext, coords: effectiveCoords };

  if (activeConnection) {
    const interestText = activeConnection.interests.length
      ? ` Their interests include: ${activeConnection.interests.join(", ")}.`
      : "";
    connNotes.push(
      `Planning context: the user is including their connection ${activeConnection.name} in plans.${interestText} ` +
        `Refer to ${activeConnection.name} by name and factor their interests into suggestions.`
    );
    if (selectedTool === "search_places" && effectiveCoords) {
      connNotes.push(
        `Place searches this turn are centered on the midpoint between the user and ${activeConnection.name}.`
      );
    }
    if (!selectedTool) {
      connNotes.push(
        `The user isn't asking for places or events right now — simply confirm you've noted ${activeConnection.name} for future planning.`
      );
    }
  }

  // Ground the opening turn in the tapped suggestion (independent of whether a
  // connection resolved, though one normally will).
  if (suggestionSeed && (suggestionSeed.title || suggestionSeed.place || suggestionSeed.time)) {
    const parts: string[] = [];
    if (suggestionSeed.title) parts.push(`titled "${suggestionSeed.title}"`);
    if (suggestionSeed.place) parts.push(`at ${suggestionSeed.place}`);
    if (suggestionSeed.time) parts.push(`around ${suggestionSeed.time}`);
    connNotes.push(
      `The user tapped "Plan it" on a meet-up suggestion ${parts.join(" ")}. ` +
        `Open the conversation grounded in this idea${activeConnection ? ` with ${activeConnection.name}` : ""} — ` +
        `acknowledge the plan warmly before anything else. ` +
        (suggestionSeed.place
          ? `Call search_places to find "${suggestionSeed.place}" or similar spots near them, and reference the suggested plan naturally.`
          : `Help them turn it into a concrete plan.`)
    );
  }

  const baseSystem: ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];
  if (connNotes.length > 0) {
    baseSystem.push({ role: "system", content: connNotes.join("\n") });
  }

  const pass1Messages: ChatCompletionMessageParam[] = [
    ...baseSystem,
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  // Pick at most one tool up front — the deployment 400s if we offer more than
  // one. If none is relevant (small talk, general advice, a pure connection
  // mention), answer directly.
  if (!selectedTool) {
    onStep({ type: "agent", agent: "executor", message: "No live data needed — replying directly" });
    const reply = await noToolsCompletion(pass1Messages, streamToken);
    return { reply, cards: [], rememberedConnections: remembered };
  }

  onStep({ type: "agent", agent: "researcher", message: `Calling tool: ${selectedTool}` });
  let pass1;
  try {
    pass1 = await client.chat.completions.create({
      model: deployment,
      max_tokens: 1024,
      temperature: 0.6,
      tools: [ASSISTANT_TOOLS_BY_NAME[selectedTool]],
      tool_choice: "auto",
      messages: pass1Messages,
    });
  } catch (err) {
    // If the model emits an unparseable tool call or the tool pass fails for
    // any reason, fall back to a tool-less prose reply rather than 500ing.
    void err;
    const reply = await noToolsCompletion(pass1Messages);
    return { reply, cards: [], rememberedConnections: remembered };
  }

  const choice = pass1.choices[0];
  const finishReason = choice?.finish_reason;
  const assistantMsg = choice?.message;
  const toolCalls = (assistantMsg?.tool_calls ?? []) as ChatCompletionMessageToolCall[];

  if (finishReason !== "tool_calls" || toolCalls.length === 0) {
    return {
      reply: assistantMsg?.content ?? "",
      cards: [],
      rememberedConnections: remembered,
    };
  }

  const fanOut = await Promise.all(
    toolCalls.map((tc) => executeToolCall(tc, toolContext, foursquareApiKey))
  );

  const cards: AssistantCard[] = fanOut
    .map((r) => r.card)
    .filter((c): c is AssistantCard => c !== null);

  for (const card of cards) onStep({ type: "card", card });
  const resultCount = cards.reduce((n, c) => n + (Array.isArray((c as { data?: unknown }).data) ? (c as { data: unknown[] }).data.length : 1), 0);
  onStep({ type: "agent", agent: "researcher", message: `Tool returned ${resultCount} result(s)` });
  onStep({ type: "agent", agent: "executor", message: "Composing grounded reply from tool results" });

  const pass2Messages: ChatCompletionMessageParam[] = [
    ...pass1Messages,
    {
      role: "assistant",
      content: assistantMsg?.content ?? "",
      tool_calls: toolCalls,
    },
    ...fanOut.map((r) => r.toolMessage),
  ];

  let reply: string;
  if (streamToken) {
    const stream = await client.chat.completions.create({
      model: deployment,
      max_tokens: 1024,
      temperature: 0.6,
      frequency_penalty: REPLY_FREQUENCY_PENALTY,
      presence_penalty: REPLY_PRESENCE_PENALTY,
      stream: true,
      messages: pass2Messages,
    });
    let full = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        full += delta;
        streamToken(delta);
        if (looksLikeLoop(full)) break; // stop a degenerate token-loop early
      }
    }
    // Guard against an occasional empty stream — fall back to non-streamed.
    if (full.trim()) {
      reply = sanitizeReply(full);
    } else {
      const pass2 = await client.chat.completions.create({
        model: deployment,
        max_tokens: 1024,
        temperature: 0.6,
        frequency_penalty: REPLY_FREQUENCY_PENALTY,
        presence_penalty: REPLY_PRESENCE_PENALTY,
        messages: pass2Messages,
      });
      reply = sanitizeReply(pass2.choices[0]?.message?.content ?? "");
    }
  } else {
    const pass2 = await client.chat.completions.create({
      model: deployment,
      max_tokens: 1024,
      temperature: 0.6,
      frequency_penalty: REPLY_FREQUENCY_PENALTY,
      presence_penalty: REPLY_PRESENCE_PENALTY,
      messages: pass2Messages,
    });
    reply = sanitizeReply(pass2.choices[0]?.message?.content ?? "");
  }
  onStep({ type: "agent", agent: "critic", message: `Grounded in ${cards.length} live card(s); no fabricated names` });
  return { reply, cards, rememberedConnections: remembered };
}

export { isAzureConfigured };
