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

export type AssistantCard =
  | { type: "places"; data: Place[] }
  | { type: "events"; data: EventResult[] }
  | { type: "place_detail"; data: Place };

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
              events: events.map((e) => ({
                title: e.title,
                date: e.date,
                time: e.time,
                venue: e.venue,
                address: e.address,
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

async function noToolsCompletion(messages: ChatCompletionMessageParam[]): Promise<string> {
  const client = getAzureClient();
  if (!client) return "";
  const c = await client.chat.completions.create({
    model: getAzureDeployment(),
    max_tokens: 1024,
    temperature: 0.6,
    messages,
  });
  return c.choices[0]?.message?.content ?? "";
}

type AssistantToolName = "search_places" | "search_events" | "get_place_details";

const ASSISTANT_TOOLS_BY_NAME: Record<AssistantToolName, ChatCompletionTool> = {
  search_places: SEARCH_PLACES_TOOL,
  search_events: SEARCH_EVENTS_TOOL,
  get_place_details: GET_PLACE_DETAILS_TOOL,
};

// This Foundry deployment rejects any request that offers more than one tool
// (400 UnsupportedToolUse: "does not support more than one tool call"). So we
// classify the user's intent first and offer at most ONE tool on the main call.
// A no-tools JSON completion never trips that limit.
async function selectAssistantTool(
  client: OpenAI,
  deployment: string,
  userMessage: string,
  history: Array<{ role: "user" | "assistant"; content: string }>
): Promise<AssistantToolName | null> {
  const recent = history
    .slice(-4)
    .map((h) => `${h.role}: ${h.content}`)
    .join("\n");
  const system =
    `Classify the user's latest message to pick which single tool (if any) should run.\n` +
    `Return ONLY JSON: {"tool":"search_places"|"search_events"|"get_place_details"|"none"}.\n` +
    `- search_places: they want somewhere to go, eat, drink, or visit (cafes, restaurants, parks, bars, gyms, attractions).\n` +
    `- search_events: they ask about events, concerts, festivals, gigs, or what's happening on a date.\n` +
    `- get_place_details: they ask for more detail about one specific place already mentioned.\n` +
    `- none: greetings, small talk, general advice, or anything not needing live place/event data.`;
  const user = (recent ? `Recent conversation:\n${recent}\n\n` : "") + `Latest message: ${userMessage}`;
  try {
    const c = await client.chat.completions.create({
      model: deployment,
      max_tokens: 30,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const parsed = JSON.parse(c.choices[0]?.message?.content ?? "{}") as { tool?: unknown };
    const t = parsed.tool;
    if (t === "search_places" || t === "search_events" || t === "get_place_details") {
      return t;
    }
    return null;
  } catch {
    return null;
  }
}

export async function chatWithAssistant(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  userMessage: string,
  userContext: AssistantUserContext,
  foursquareApiKey: string,
  tappedPlace: Place | null = null
): Promise<{ reply: string; cards: AssistantCard[] }> {
  if (!isAzureConfigured()) {
    throw new Error(
      "Azure OpenAI not configured. Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY."
    );
  }
  const client = getAzureClient()!;
  const deployment = getAzureDeployment();
  const systemPrompt = buildAssistantSystemPrompt(userContext);

  // Tap UX short-circuit: the user tapped a specific place card; the client
  // wants a focused reply about THAT place. Skip the tool-call pass entirely
  // and produce a single prose completion grounded in the pre-fetched detail.
  if (tappedPlace) {
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

    const reply = await noToolsCompletion(tapMessages);
    return {
      reply,
      cards: [{ type: "place_detail", data: tappedPlace }],
    };
  }

  const pass1Messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  // Pick at most one tool up front — the deployment 400s if we offer more than
  // one. If none is relevant (small talk, general advice), answer directly.
  const selectedTool = await selectAssistantTool(client, deployment, userMessage, history);
  if (!selectedTool) {
    const reply = await noToolsCompletion(pass1Messages);
    return { reply, cards: [] };
  }

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
    return { reply, cards: [] };
  }

  const choice = pass1.choices[0];
  const finishReason = choice?.finish_reason;
  const assistantMsg = choice?.message;
  const toolCalls = (assistantMsg?.tool_calls ?? []) as ChatCompletionMessageToolCall[];

  if (finishReason !== "tool_calls" || toolCalls.length === 0) {
    return {
      reply: assistantMsg?.content ?? "",
      cards: [],
    };
  }

  const fanOut = await Promise.all(
    toolCalls.map((tc) => executeToolCall(tc, userContext, foursquareApiKey))
  );

  const cards: AssistantCard[] = fanOut
    .map((r) => r.card)
    .filter((c): c is AssistantCard => c !== null);

  const pass2Messages: ChatCompletionMessageParam[] = [
    ...pass1Messages,
    {
      role: "assistant",
      content: assistantMsg?.content ?? "",
      tool_calls: toolCalls,
    },
    ...fanOut.map((r) => r.toolMessage),
  ];

  const pass2 = await client.chat.completions.create({
    model: deployment,
    max_tokens: 1024,
    temperature: 0.6,
    messages: pass2Messages,
  });

  const reply = pass2.choices[0]?.message?.content ?? "";
  return { reply, cards };
}

export { isAzureConfigured };
