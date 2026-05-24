# Meet-up Suggestions API — Client Reference

## Overview

One endpoint powers the **Today** screen's mixed feed of meet-up cards: concrete plan suggestions and lighter conversation hooks tied to specific connections, places, and times.

Pipeline behind the scenes:

```
Client → GET /ai/meetup/suggestions
         ↓
       Fastify (cache check) → n8n webhook → Fastify /context (connections, location, time)
                                           → Ola Maps (nearby spots)
                                           → Groq (generation + supervisor loop, 1-3 attempts)
                                           → back to Fastify (15-min Redis cache)
         ↓
       Client renders mixed list of "detailed" and "one_liner" cards
```

Transport is HTTPS. All requests and responses are JSON.

---

## Authentication

```
Authorization: Bearer <access_token>
```

Same JWT format used everywhere else (see `ai-connections-api.md` for token-payload details). The user ID (`sub`) drives all signal lookups — connections, profile, location.

---

## Endpoint

### `GET /ai/meetup/suggestions`

Returns a mixed list of up to 5 personalised suggestions (2 detailed + 3 one_liners) for the authenticated user.

**Auth:** required.
**Query params:** none.
**Body:** none.
**Latency:** 4–9s on a cache miss; ~50ms on a cache hit.
**Cache:** server-side Redis, keyed `meetup:suggestions:{userId}`, **TTL 30 min**. No client controls.

---

## Response — success

### Top-level shape

```ts
type SuggestionsResponse = {
  success: true;
  cached: boolean;                 // true if served from Redis
  suggestions: SuggestionItem[];   // 0 to 5 items; may be empty
  supervisor?: {                   // omitted when cached === true
    approved: boolean;             // false => last-best fallback; UI may dim or offer refresh
    attempts: number;              // 1 to 3
    lastFeedback: string;          // empty when approved; debug string otherwise
  };
};
```

### `SuggestionItem` is a discriminated union on `type`

```ts
type SuggestionItem = DetailedSuggestion | OneLinerSuggestion;
```

#### `DetailedSuggestion` — concrete plan card

```ts
type DetailedSuggestion = {
  type: "detailed";
  connectionId: string;     // stable UUID — use this for navigation & dedup
  connectionName: string;   // first name only, for display (may collide across connections)
  title: string;            // 3-5 words, e.g. "Sunset walk with Aditya"
  place: string;            // exact name from a real nearby spot
  time: string;             // human-readable, e.g. "Tonight, 7:00 PM" or "Tomorrow, 10:00 AM"
  text: string;             // 40-110 chars, declarative tone, no question mark
};
```

#### `OneLinerSuggestion` — soft conversation hook

```ts
type OneLinerSuggestion = {
  type: "one_liner";
  connectionId: string;
  connectionName: string;
  text: string;             // 40-110 chars, ends with "?"
};
```

### Example response (fresh, supervisor approved)

```json
{
  "success": true,
  "cached": false,
  "suggestions": [
    {
      "type": "detailed",
      "connectionId": "17f473f7-363c-46fc-99a0-788747eca16d",
      "connectionName": "Kiara",
      "title": "Yoga coffee with Kiara",
      "place": "Barista",
      "time": "Saturday, 10:00 AM",
      "text": "Kiara's into yoga and coffee — Barista has a serene spot for both."
    },
    {
      "type": "detailed",
      "connectionId": "32f4b4af-e3ea-4c4d-9cf2-8da673cac540",
      "connectionName": "Rahul",
      "title": "Football talk with Rahul",
      "place": "Tanwar Market",
      "time": "Saturday, 6:30 PM",
      "text": "Rahul's a football fan — catch up over a snack at Tanwar Market."
    },
    {
      "type": "one_liner",
      "connectionId": "1187b6a4-f7a9-4b2a-8840-e127c2d03385",
      "connectionName": "Geeta",
      "text": "You and Geeta both love meditation — want to practice together this week?"
    },
    {
      "type": "one_liner",
      "connectionId": "0e5661d5-4ed0-4b50-82f4-f94956312c59",
      "connectionName": "Saanvi",
      "text": "Saanvi's into football like you — up for a match watch soon?"
    },
    {
      "type": "one_liner",
      "connectionId": "532829f4-e028-4b0a-b434-3e41d5c23b9a",
      "connectionName": "Meera",
      "text": "Meera's also into hiking — interested in planning a trek together?"
    }
  ],
  "supervisor": {
    "approved": true,
    "attempts": 1,
    "lastFeedback": ""
  }
}
```

### Example response (cached)

```json
{
  "success": true,
  "cached": true,
  "suggestions": [ ... same shape as above ... ]
}
```

`supervisor` is omitted on cache hits — the client should treat it as optional.

### Example response (no eligible connections)

```json
{
  "success": true,
  "cached": false,
  "suggestions": [],
  "supervisor": { "approved": true, "attempts": 0, "lastFeedback": "no_connections" }
}
```

---

## Response — errors

All errors share the same shape:

```ts
type ErrorResponse = { success: false; error: string };
```

| HTTP | `error` value                    | When                                                 | Client action                                                 |
|------|----------------------------------|------------------------------------------------------|---------------------------------------------------------------|
| 401  | localised auth-required string   | Missing/invalid/expired JWT                          | Trigger re-auth flow                                          |
| 400  | `"location_required"`            | User has no `h3_cell` set                            | Prompt the user to enable / share location, then retry        |
| 400  | `"location_invalid"`             | `h3_cell` exists but doesn't decode to valid lat/lng | Same as above — treat as "location not usable"                |
| 503  | `"suggestions_unavailable"`      | n8n webhook unreachable, timed out, or returned bad data | Show "couldn't generate suggestions, try again later"; no auto-retry needed |
| 500  | localised unable-to-process      | Unexpected server error                              | Generic error toast, allow manual retry                       |

`localised` means the server returns the user's locale-resolved string (i18n) for that key — display as-is.

---

## Behavioural notes for the client

### Two cards, two intents
- **`detailed`** → render as a "plan card": badge (`title.split(' ')[0].toUpperCase()` or the `time` if you prefer), `title` as headline, `place` as subtitle, `text` as body. The text is declarative — no question mark — so a primary CTA like *"I'm in"* or *"Plan it"* matches the tone.
- **`one_liner`** → render as a soft "Kith-style" card: `text` is the entire body, ending with a question. Primary CTA *"Plan it"*, secondary *"Not now"*.

### `connectionId` vs `connectionName`
- Use `connectionId` for navigation (open chat, fetch profile) and local dedup. It's a stable UUID.
- `connectionName` is **first-name only** and **may collide** across two real connections (e.g. two "Yash"). Never use it as an identifier.

### `approved: false` fallback
- If the LLM supervisor never approved the batch after 3 attempts, the server returns the last attempt anyway with `approved: false`. The data is still well-formed (validated mechanically) but may feel slightly more generic. The client can choose to:
  - Render normally and trust the next refresh, OR
  - Dim the cards / show a small "Refining…" affordance, OR
  - Auto-trigger a refresh button.
- `lastFeedback` is debug-quality (raw editor notes) — don't show it to users.

### `cached: true`
- Means the response came from Redis (30-min TTL). No `supervisor` object will be present.
- The TTL is server-controlled; no client cache-bust header is currently honoured. Pull-to-refresh just makes the same request — within 30 min the user will see the same content.

### Empty list
- `suggestions: []` is a valid successful response (e.g. user has 0 connections). Render an empty-state with a CTA to add connections.

### Place may include long official names
- The Ola Maps response can include verbose names like `"Mosaic - Fairlie Hotels & Resorts, Satbari, Chattarpur Delhi"`. Truncate at the comma or to a sensible width in the UI; don't try to normalise on the client (the place string is what was passed to Ola, so it's the same string a user would see on a map link).

---

## Example client integration (TypeScript)

```ts
type DetailedSuggestion = {
  type: "detailed";
  connectionId: string;
  connectionName: string;
  title: string;
  place: string;
  time: string;
  text: string;
};
type OneLinerSuggestion = {
  type: "one_liner";
  connectionId: string;
  connectionName: string;
  text: string;
};
type SuggestionItem = DetailedSuggestion | OneLinerSuggestion;
type SuggestionsResponse = {
  success: true;
  cached: boolean;
  suggestions: SuggestionItem[];
  supervisor?: { approved: boolean; attempts: number; lastFeedback: string };
};
type ErrorResponse = { success: false; error: string };

async function fetchTodayFeed(accessToken: string): Promise<SuggestionItem[]> {
  const res = await fetch(`${API_BASE}/ai/meetup/suggestions`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) throw new AuthError("re-auth required");
  if (res.status === 400) {
    const body = (await res.json()) as ErrorResponse;
    if (body.error === "location_required" || body.error === "location_invalid") {
      throw new LocationError(body.error);
    }
    throw new Error(body.error);
  }
  if (res.status === 503) {
    // server-side dependency failed; show "try again later"
    return [];
  }
  if (!res.ok) throw new Error(`unexpected status ${res.status}`);

  const body = (await res.json()) as SuggestionsResponse;
  return body.suggestions;
}

// Rendering a single card (framework-agnostic pseudocode)
function renderCard(item: SuggestionItem) {
  if (item.type === "detailed") {
    return {
      eyebrow: item.time.toUpperCase(),       // "TONIGHT, 7:00 PM"
      title: item.title,                       // "Sunset walk with Aditya"
      subtitle: item.place,                    // "Barista"
      body: item.text,                         // "Aditya's into ..."
      primaryCta: "Plan it",
      onPrimary: () => openPlanFlow(item.connectionId, item.place, item.time),
    };
  } else {
    return {
      eyebrow: "SUGGESTED",
      title: null,
      subtitle: null,
      body: item.text,                         // "You and Geeta both love..."
      primaryCta: "Plan it",
      secondaryCta: "Not now",
      onPrimary: () => openDraftFlow(item.connectionId),
    };
  }
}
```

---

## Refresh strategy

- **On Today screen mount** → fetch once.
- **On pull-to-refresh** → fetch again (will hit cache if < 30 min old; user sees same data, which is intentional).
- **When user dismisses a card** → keep it locally hidden for that session; the next fetch after cache expiry will rebuild the list.

There's no per-card dismissal endpoint; the next regeneration handles freshness.

---

## Out of scope (for now)

- No "next-page" pagination — the list is always ≤ 5.
- No per-card "regenerate" or "tell me more" endpoint.
- No write-back: the API doesn't know if the user actioned a card. If you want analytics on accepted suggestions, capture client-side and pipe through your own telemetry.
- The card itself is the AI output; the client cannot edit text, time, or place before sending it on.
