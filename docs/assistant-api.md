# AI Assistant API — Client Reference

## Overview

A conversational assistant personalized to each user (name, bio, interests, H3 location, language preference). Replies are always prose text plus an optional `cards` array of structured data that the client renders inline with the chat bubble. Three card types exist:

| Card type      | Source                                              | UI shape                                  |
|----------------|-----------------------------------------------------|-------------------------------------------|
| `places`       | Foursquare Places API                               | Horizontally scrollable list of place tiles |
| `events`       | Google Events (via n8n + Playwright + Groq parser)  | Vertical list of event tiles               |
| `place_detail` | Foursquare Places API (`/places/{id}`)              | Full-bleed detail sheet (one place)        |

Chat history is persisted server-side per user in the `assistant_messages` table. Two endpoints:

- `POST /assistant/chat` — send a turn, get a reply + cards.
- `GET  /assistant/history` — paginated history retrieval.

Transport is HTTPS. All requests and responses are JSON.

---

## Authentication

Every endpoint requires a JWT access token in the `Authorization` header.

```
Authorization: Bearer <access_token>
```

**Token payload:**

| Field   | Type           | Description                  |
|---------|----------------|------------------------------|
| `sub`   | string (UUID)  | Authenticated user ID        |
| `phone` | string         | User's phone number          |
| `type`  | `"access"`     | Must be `"access"`           |
| `iat`   | number         | Issued-at (Unix timestamp)   |
| `exp`   | number         | Expiry (Unix timestamp)      |

**Auth failure — 401 Unauthorized:**

```json
{ "success": false, "error": "common.errors.auth_required" }
```

Returned when the `Authorization` header is missing, malformed, the token is expired, or the token type is not `"access"`.

---

## Common Response Envelope

Every response follows the same outer shape:

**Success:**
```json
{ "success": true, ... }
```

**Failure:**
```json
{ "success": false, "error": <string | object> }
```

`error` is either:
- A **translation key** (e.g. `"common.errors.unable_to_process"`) — show it via your i18n layer.
- A **Zod field-error object** on 400 validation failures — see [Validation Errors](#validation-errors).

---

## Card Type Reference

`cards` is a discriminated union keyed by `type`. The shape of `data` depends on `type`.

### `places` card

```ts
{
  type: "places",
  data: Place[]
}
```

### `events` card

```ts
{
  type: "events",
  data: EventResult[]
}
```

### `place_detail` card

```ts
{
  type: "place_detail",
  data: Place    // single object, not an array
}
```

### `Place` object

| Field      | Type     | Required | Notes                                                                  |
|------------|----------|----------|------------------------------------------------------------------------|
| `placeId`  | string   | yes      | Stable Foursquare ID. **Use this when the user taps the card.**        |
| `name`     | string   | yes      | Display name.                                                          |
| `address`  | string   | yes      | Formatted address. May be a single token like `"IN"` for low-detail records — render conservatively. |
| `lat`      | number   | yes      | May be `0` if Foursquare didn't return coords. Treat `0,0` as "missing". |
| `lng`      | number   | yes      | Same caveat as `lat`.                                                  |
| `rating`   | number   | no       | Only present on enriched calls; usually absent on default-tier results. |
| `types`    | string[] | yes      | Foursquare category names, e.g. `["Coffee Shop","Café"]`. May be `[]`. |
| `website`  | string   | no       | URL. Present mostly on `place_detail` results.                         |

### `EventResult` object

| Field     | Type           | Required | Notes                                                       |
|-----------|----------------|----------|-------------------------------------------------------------|
| `title`   | string         | yes      | Event name.                                                 |
| `date`    | string         | yes      | Human-readable. Examples: `"Sat, Jun 7"`, `"May 30"`, `"Thu, 2 – Sat, 4 Jul"`. **Not** a parseable date — render as-is. |
| `time`    | string \| null | no       | E.g. `"7:00 PM"`, `"12:30 – 2:30 pm"`, or omitted.          |
| `venue`   | string \| null | no       | Venue name.                                                 |
| `address` | string \| null | no       | Free-form address.                                          |
| `link`    | string \| null | no       | Ticket/info URL.                                            |
| `source`  | string \| null | no       | Source label (e.g. `"BookMyShow"`, `"Insider"`).            |
| `price`   | string \| null | no       | Free-form price string (e.g. `"From ₹500"`).                |

> Optional string fields may be absent OR explicitly `null`. Render them only when present and non-empty.

---

## `POST /assistant/chat`

Send a user turn. Returns prose `reply` + optional `cards` + the assistant row id (`messageId`).

### Request

```http
POST /assistant/chat HTTP/1.1
Authorization: Bearer <access_token>
Content-Type: application/json
```

**Body schema:**

```ts
{
  message: string,        // 1-500 chars, trimmed server-side
  placeId?: string        // 1-120 chars; pass when the user taps a Place card
}
```

| Field     | Type   | Required | Constraints / semantics                                                       |
|-----------|--------|----------|-------------------------------------------------------------------------------|
| `message` | string | yes      | The user's text. Min 1 char, max 500 chars. Trimmed before processing.        |
| `placeId` | string | no       | Foursquare `placeId` from a previously-returned card. **Pass this whenever the user taps a card** — the server short-circuits the LLM tool path, fetches the detail synchronously, and always returns a `place_detail` card with a focused reply. |

#### Example A — free-text turn (no tap)

```http
POST /assistant/chat
Authorization: Bearer eyJ...
Content-Type: application/json

{ "message": "Find me a coffee shop nearby" }
```

#### Example B — tap UX

```http
POST /assistant/chat
Authorization: Bearer eyJ...
Content-Type: application/json

{
  "message": "Show me details",
  "placeId": "576f8dfacd10921479a5ed2d"
}
```

> `message` is still required when tapping. Send a short canned string (e.g. `"Show me details"` or `"Tell me about this one"`) — the server prompts the model to ignore the literal text and focus on the tapped place. Localize this canned string on the client; the server does not.

### Success — 200 OK

```ts
{
  success: true,
  reply: string,                // always present, may be empty string on rare LLM errors
  cards: AssistantCard[],       // 0+ cards, see Card Type Reference
  messageId: string | null      // UUID of the persisted assistant row; null if DB insert failed
}
```

**Notes:**

- `reply` is the model's conversational text. Render in a chat bubble.
- `cards` may be empty (`[]`) when the model decided no tool was needed (e.g. a general advice question), or when all tool calls returned empty results.
- A request can return multiple cards of different types in one turn (e.g. `[{type:"places",...}, {type:"events",...}]`) when the model fans out tools in parallel.
- `messageId` references the assistant row's `id` and can be used as a stable key for de-duplication or as a cursor base for paging.
- The `reply` text never contains placeIds, raw IDs, or tool-call markup — it is safe to render directly.

#### Example response — text-only (no cards)

```json
{
  "success": true,
  "reply": "Meeting new people in a new city can be challenging. Joining local groups around your interests is a great way to start.",
  "cards": [],
  "messageId": "354eaf27-21cd-4392-a839-ef64b313c825"
}
```

#### Example response — places card

```json
{
  "success": true,
  "reply": "You could try Cafe Dori @ Nappa Dori Warehouse, Barista, or Quick Brown Fox Coffee Roasters.",
  "cards": [
    {
      "type": "places",
      "data": [
        {
          "placeId": "59e343c7f0ca95526bf08ebc",
          "name": "Cafe Dori @ Nappa Dori Warehouse",
          "address": "100 Chattarpur Hills 100 Feet Road Nappa Dori Warehouse, New Delhi 110030, Delhi",
          "lat": 28.503955,
          "lng": 77.184991,
          "types": ["Coffee Shop", "Café"]
        },
        {
          "placeId": "576f8dfacd10921479a5ed2d",
          "name": "Barista",
          "address": "IN",
          "lat": 28.500948,
          "lng": 77.166245,
          "types": ["Coffee Shop"]
        }
      ]
    }
  ],
  "messageId": "cad19c89-7955-4d33-9f24-cbf494b74bfd"
}
```

#### Example response — events card

```json
{
  "success": true,
  "reply": "You can check out Blind Date at Rage Room Mumbai or Fresh India Show 2026.",
  "cards": [
    {
      "type": "events",
      "data": [
        {
          "title": "Blind Date at Rage Room Mumbai",
          "date": "Sun, May 31",
          "time": null,
          "venue": "Rage Room Mumbai",
          "address": null,
          "link": null,
          "source": null,
          "price": null
        },
        {
          "title": "Fresh India Show 2026",
          "date": "Sat, May 28",
          "time": null,
          "venue": null,
          "address": null,
          "link": null,
          "source": null,
          "price": null
        }
      ]
    }
  ],
  "messageId": "fd5e38fd-2bf9-4c49-88bf-5764328130b9"
}
```

#### Example response — combined places + events

```json
{
  "success": true,
  "reply": "There are a few cafes nearby like Cafe Dori and Barista, and a comedy event happening this weekend.",
  "cards": [
    { "type": "places", "data": [ /* ...Place[] */ ] },
    { "type": "events", "data": [ /* ...EventResult[] */ ] }
  ],
  "messageId": "..."
}
```

#### Example response — tap UX (`placeId` in request)

```json
{
  "success": true,
  "reply": "Barista is a coffee shop with a website at https://www.barista.co.in.",
  "cards": [
    {
      "type": "place_detail",
      "data": {
        "placeId": "576f8dfacd10921479a5ed2d",
        "name": "Barista",
        "address": "IN",
        "lat": 28.500948,
        "lng": 77.166245,
        "types": ["Coffee Shop"],
        "website": "https://www.barista.co.in"
      }
    }
  ],
  "messageId": "..."
}
```

> When the request includes `placeId`, the server **always** returns exactly one `place_detail` card (no `places` or `events` mixed in). If `placeId` doesn't resolve via Foursquare, the request falls back to the normal conversational path and `cards` may contain anything or be empty.

### Errors

#### 400 Bad Request — invalid body

Returned when Zod validation fails. `error` is a field-map.

```json
{
  "success": false,
  "error": {
    "message": ["Too small: expected string to have >=1 characters"]
  }
}
```

```json
{
  "success": false,
  "error": {
    "message": ["Too big: expected string to have <=500 characters"]
  }
}
```

Possible field keys: `message`, `placeId`. Show field-specific errors next to your inputs.

#### 401 Unauthorized — missing/invalid JWT

```json
{ "success": false, "error": "common.errors.auth_required" }
```

#### 500 Internal Server Error — unexpected failure

```json
{ "success": false, "error": "common.errors.unable_to_process" }
```

Returned when:
- The user row could not be fetched from Supabase.
- The Groq API call failed for a reason other than `tool_use_failed` (which is handled internally with a graceful fallback).
- Any other unhandled exception.

> The DB insert failing is **not** a 500. The server still returns 200 with `messageId: null` and a valid `reply`/`cards`. Client must handle `messageId === null`.

---

## `GET /assistant/history`

Paginated retrieval of past chat turns for the authenticated user, newest-first.

### Request

```http
GET /assistant/history?limit=20&cursor=<uuid> HTTP/1.1
Authorization: Bearer <access_token>
```

**Query parameters:**

| Field    | Type   | Required | Constraints / semantics                                                       |
|----------|--------|----------|-------------------------------------------------------------------------------|
| `limit`  | number | no       | Default `20`, min `1`, max `50`. Coerced from string.                         |
| `cursor` | string | no       | UUID of a previously-returned message `id`. Returns messages strictly **older** than this row's `created_at`. |

The cursor row must belong to the authenticated user; otherwise the cursor is silently ignored (no error). Use the **oldest** message's `id` from the previous page as the cursor for the next page.

### Success — 200 OK

```ts
{
  success: true,
  messages: AssistantMessage[],
  hasMore: boolean
}
```

where

```ts
AssistantMessage = {
  id: string,                                  // UUID, stable
  role: "user" | "assistant",
  content: string,                             // raw user/LLM text, safe to render
  metadata: { cards?: AssistantCard[] } | {},  // assistant rows carry cards; user rows are usually empty {}
  createdAt: string                            // ISO 8601 UTC timestamp
}
```

- **Order is descending** (newest first), matching most chat UIs that load the bottom of the timeline first.
- `hasMore` is `true` when more rows exist before the oldest one in this page. Pass `messages.at(-1).id` as the next `cursor`.
- `metadata.cards` carries the exact same card array that was returned in the original `/chat` reply. Render history bubbles the same way you rendered them live.

#### Example response

```json
{
  "success": true,
  "messages": [
    {
      "id": "3e67b083-a9ac-4188-92d2-ae7d69745b0b",
      "role": "assistant",
      "content": "Cafe Dori @ Nappa Dori Warehouse is a charming cafe located at ...",
      "metadata": {
        "cards": [
          {
            "type": "place_detail",
            "data": {
              "placeId": "59e343c7f0ca95526bf08ebc",
              "name": "Cafe Dori @ Nappa Dori Warehouse",
              "address": "...",
              "lat": 28.503955,
              "lng": 77.184991,
              "types": ["Coffee Shop", "Café"]
            }
          }
        ]
      },
      "createdAt": "2026-05-27T18:48:50.123Z"
    },
    {
      "id": "f2a48a91-eb0b-46c0-b1f1-2c6b3c6d2f80",
      "role": "user",
      "content": "Tell me about Cafe Dori",
      "metadata": {},
      "createdAt": "2026-05-27T18:48:25.000Z"
    }
  ],
  "hasMore": true
}
```

### Errors

#### 400 Bad Request — invalid query

```json
{
  "success": false,
  "error": {
    "limit": ["Too big: expected number to be <=50"]
  }
}
```

```json
{
  "success": false,
  "error": {
    "cursor": ["Invalid UUID format"]
  }
}
```

#### 401 Unauthorized

```json
{ "success": false, "error": "common.errors.auth_required" }
```

#### 500 Internal Server Error

```json
{ "success": false, "error": "common.errors.unable_to_process" }
```

---

## Validation Errors

Both endpoints return Zod's `fieldErrors` shape on 400. The error map's keys are the failing fields; values are arrays of human-readable messages.

```ts
type ValidationErrors = {
  [field: string]: string[]
}
```

Recommended client handling:

1. Detect by `response.status === 400 && typeof body.error === "object"`.
2. Surface field-level messages next to the offending input.
3. If you don't have a per-field UI, join all messages and show as a single toast.

---

## Common Error Translation Keys

The server returns translation keys, not localized text. Map them in your i18n layer.

| Key                                | When                                                            | Suggested user message                       |
|------------------------------------|-----------------------------------------------------------------|----------------------------------------------|
| `common.errors.auth_required`      | Missing/invalid/expired Bearer token                            | "Please sign in again."                      |
| `common.errors.unable_to_process`  | DB or LLM failure on the server, generic 500                    | "Something went wrong. Please try again."    |
| `common.errors.invalid_parameter`  | Used elsewhere on the platform, may surface here in edge cases  | "Check the inputs and try again."            |

---

## Client Implementation Patterns

### Sending a turn

```ts
async function sendChat(
  message: string,
  placeId?: string
): Promise<ChatResponse> {
  const res = await fetch(`${API_BASE}/assistant/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify(placeId ? { message, placeId } : { message }),
  });

  const body = await res.json();
  if (!res.ok || body.success !== true) {
    throw new AssistantApiError(res.status, body.error);
  }
  return body as ChatResponse;
}
```

### Card → tap → detail flow

```ts
// 1. Render the places card. Each tile stores its placeId.
function PlaceTile({ place }: { place: Place }) {
  return (
    <Pressable onPress={() => onTapPlace(place)}>
      <Text>{place.name}</Text>
      <Text>{place.address}</Text>
    </Pressable>
  );
}

// 2. On tap, send a follow-up turn with the placeId.
async function onTapPlace(place: Place) {
  appendUserMessage("Show me details"); // localized
  const res = await sendChat("Show me details", place.placeId);
  appendAssistantMessage(res.reply, res.cards);
}
```

> The server short-circuits the LLM tool path when `placeId` is present, so this is fast (~1 LLM call instead of two) and deterministic — you'll always get a single `place_detail` card.

### Organic follow-ups (no `placeId`)

If the user types something like `"tell me more about Cafe Dori"` (without tapping), just send the message normally:

```ts
await sendChat("Tell me more about Cafe Dori");
```

The server augments the LLM's view of past assistant turns with the placeIds it returned earlier, so the model can call `get_place_details` itself. The marker is invisible to the user — `content` stored in the DB and returned from `/history` stays clean.

### Paginated history loading

```ts
async function loadOlderMessages(): Promise<void> {
  const params = new URLSearchParams({ limit: "20" });
  if (oldestKnownId) params.set("cursor", oldestKnownId);

  const res = await fetch(`${API_BASE}/assistant/history?${params}`, {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });
  const body = await res.json();
  if (!res.ok || body.success !== true) {
    throw new AssistantApiError(res.status, body.error);
  }

  // messages are newest-first; reverse for chat-UI append order.
  prependMessages(body.messages.slice().reverse());
  hasMoreOlder = body.hasMore;
  oldestKnownId = body.messages.at(-1)?.id ?? oldestKnownId;
}
```

### Card rendering recommendations

| Card type      | UI suggestion                                                                                              |
|----------------|------------------------------------------------------------------------------------------------------------|
| `places`       | Horizontal scroll of small tiles inside the bubble. Tap → call `/chat` with `placeId`. Hide tiles where `lat=0` if you need map pins. |
| `events`       | Vertical list inside the bubble. `link` (when present) becomes a "Buy tickets" button. Render `date` as-is — it is not machine-parseable. |
| `place_detail` | Larger inline card or a modal sheet. Show `website` (when present) as a tappable link.                     |

### Mixed `places` + `events`

When a turn returns both, render them as two separate cards stacked vertically inside the same chat bubble, in the order the server sent them. The order reflects the model's emphasis.

### Empty `cards` array

A turn with `cards: []` means the model decided no tool was needed (general advice, small-talk, error acknowledgements). Render just the prose reply.

### Handling `messageId === null`

`messageId` is `null` only when persistence failed but the reply was still produced. Display the reply normally; just don't store the id for paging. Don't error.

### Loading state UX

A typical turn takes:
- **Text-only reply:** ~3 s (single Groq pass-1 call).
- **Tap UX (`placeId`):** ~3 s (single Groq pass-1 call + sync Foursquare details).
- **Places / events / combined:** ~10–25 s (Groq pass-1 → tool fan-out → Groq pass-2). Events can be slower than places because of the Playwright fetch.

Show a typing indicator until the response arrives. Don't time out before 30 s.

### Rate-limiting note (graceful degradation)

The platform uses Groq's free tier; the events parser shares the user's TPM budget. When the parser hits a 429, the server gracefully returns `cards: []` instead of failing the turn. The reply text will still be coherent. No special client handling required.

---

## TypeScript types (drop-in)

```ts
export type Place = {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  rating?: number;
  types: string[];
  website?: string;
};

export type EventResult = {
  title: string;
  date: string;
  time?: string | null;
  venue?: string | null;
  address?: string | null;
  link?: string | null;
  source?: string | null;
  price?: string | null;
};

export type AssistantCard =
  | { type: "places"; data: Place[] }
  | { type: "events"; data: EventResult[] }
  | { type: "place_detail"; data: Place };

export type ChatRequest = {
  message: string;
  placeId?: string;
};

export type ChatResponse = {
  success: true;
  reply: string;
  cards: AssistantCard[];
  messageId: string | null;
};

export type AssistantMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  metadata: { cards?: AssistantCard[] } | Record<string, never>;
  createdAt: string;
};

export type HistoryResponse = {
  success: true;
  messages: AssistantMessage[];
  hasMore: boolean;
};

export type ValidationErrors = Record<string, string[]>;

export type ApiError =
  | { success: false; error: string }
  | { success: false; error: ValidationErrors };
```

---

## Versioning

These endpoints are unversioned. Breaking changes will be announced via release notes. New optional fields may be added to responses at any time — clients must ignore unknown fields rather than fail on them.
