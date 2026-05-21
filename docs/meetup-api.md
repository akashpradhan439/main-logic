# Meet-up Spots API — Client Reference

## Overview

This API provides AI-powered meet-up spot suggestions based on the user's location, interests, and time of day. The Fastify server is a thin wrapper around an n8n workflow that orchestrates the multi-step pipeline:

1. Fetch user context (location, bio, interests)
2. Groq (llama-3.3-70b-versatile) converts the context into Ola Maps search parameters
3. Ola Maps Nearby Search returns nearby places
4. Groq ranks the places and writes a personalized one-line reason per spot

Transport is HTTPS. Both endpoints return JSON.

---

## Authentication

Same as the rest of the platform — JWT access token in the `Authorization` header:

```
Authorization: Bearer <access_token>
```

**Auth failure — 401 Unauthorized:**
```json
{ "success": false, "error": "common.errors.auth_required" }
```

---

## GET /ai/meetup/spots

Returns up to 5 ranked meet-up spots near the user, each with an AI-generated reason.

This is the **client-facing** endpoint. It calls the n8n workflow internally and caches the result in Redis for 30 minutes per `(userId, type)` pair.

### Request

```http
GET /ai/meetup/spots?type=coffee HTTP/1.1
Authorization: Bearer <access_token>
```

**Query params:**

| Param  | Type   | Required | Allowed values                                                | Default |
|--------|--------|----------|---------------------------------------------------------------|---------|
| `type` | string | optional | `coffee`, `food`, `outdoor`, `bar`, `shopping`, `fitness`, `any` | `any`   |

No request body.

### Success — 200 OK

```json
{
  "success": true,
  "cached": false,
  "type": "coffee",
  "spots": [
    {
      "name": "Third Wave Coffee",
      "address": "18th Cross Road, HSR Layout, Bengaluru, Karnataka, 560102, India",
      "distanceMeters": 271,
      "mapsUrl": "https://www.google.com/maps/search/?api=1&query=12.9123,77.6456",
      "reason": "A specialty coffee spot perfect for a focused catch-up — matches your love for coffee and quiet work spaces."
    },
    {
      "name": "Blue Tokai Coffee Roasters",
      "address": "27th Main, HSR Layout, Bengaluru, Karnataka",
      "distanceMeters": 540,
      "mapsUrl": "https://www.google.com/maps/search/?api=1&query=12.9145,77.6478",
      "reason": "Single-origin coffee and good seating — a solid spot for catching up over a weekend morning."
    }
  ]
}
```

**Top-level fields:**

| Field    | Type     | Notes                                                          |
|----------|----------|----------------------------------------------------------------|
| `success`| boolean  | Always `true` for 200                                          |
| `cached` | boolean  | `true` if served from Redis (30-min TTL), `false` if freshly computed |
| `type`   | string   | Echoes the query param (or `"any"` if omitted)                 |
| `spots`  | object[] | Up to 5 ranked spots. May be empty if Ola Maps returns no results. |

**Spot item fields:**

| Field            | Type   | Notes                                                                |
|------------------|--------|----------------------------------------------------------------------|
| `name`           | string | Place name from Ola Maps `structured_formatting.main_text`           |
| `address`        | string | Place address from Ola Maps `structured_formatting.secondary_text`   |
| `distanceMeters` | number | Distance from user in meters (Ola Maps `distance_meters`)            |
| `mapsUrl`        | string | Google Maps deep link (built from place coordinates when available)  |
| `reason`         | string | 1–2 sentence AI explanation, tailored to the user's profile + time   |

### Empty Result

If Ola Maps returns `status: "zero_results"` (no places matched), the response is:

```json
{ "success": true, "cached": false, "type": "coffee", "spots": [] }
```

This is **not** an error — display an empty state to the user (e.g. "No spots found nearby — try a different category.").

### Failures

| Status | `error` body                            | Cause                                                                   |
|--------|-----------------------------------------|-------------------------------------------------------------------------|
| 400    | Zod field-error object                  | `type` query param is invalid                                            |
| 400    | `"location_required"`                   | User has not set an `h3_cell` yet — client should prompt for location    |
| 401    | `"common.errors.auth_required"`         | Missing / invalid / expired token                                        |
| 500    | `"common.errors.unable_to_process"`     | Unexpected server / DB error                                             |
| 503    | `"suggestions_unavailable"`             | n8n webhook unreachable, timed out (>12s), returned non-2xx, or returned malformed JSON |

---

## GET /ai/meetup/spots/context  *(internal)*

> ⚠️ This endpoint is **internal** — it is called by the n8n workflow, not by clients. It is documented here for completeness and debugging.

Returns the structured context object that the n8n workflow uses to build its Ola Maps search.

### Request

```http
GET /ai/meetup/spots/context HTTP/1.1
Authorization: Bearer <access_token>
```

### Success — 200 OK

```json
{
  "success": true,
  "context": {
    "userId": "161a6dd6-5eda-419d-8e6e-153947d644f2",
    "lat": 12.9716,
    "lng": 77.5946,
    "h3Cell": "8428309ffffffff",
    "bio": "Software engineer who loves hiking on weekends.",
    "interests": ["hiking", "coffee", "photography"],
    "timeOfDay": "afternoon",
    "dayOfWeek": "Thursday"
  }
}
```

**Context fields:**

| Field        | Type            | Notes                                              |
|--------------|-----------------|----------------------------------------------------|
| `userId`     | string (UUID)   | The authenticated user's ID                        |
| `lat`        | number          | Centroid latitude of `h3_cell`                     |
| `lng`        | number          | Centroid longitude of `h3_cell`                    |
| `h3Cell`     | string          | Current H3 cell ID                                 |
| `bio`        | string \| null  | `null` if user has not set a bio                   |
| `interests`  | string[]        | Empty array if user has not set any                |
| `timeOfDay`  | string          | `morning` (6–11), `afternoon` (12–17), `evening` (18–21), `night` (22–5) |
| `dayOfWeek`  | string          | `Monday`–`Sunday` (server time)                    |

### Failures

| Status | `error` body                            | Cause                                                |
|--------|-----------------------------------------|------------------------------------------------------|
| 400    | `"location_required"`                   | User has not set an `h3_cell` yet                    |
| 400    | `"location_invalid"`                    | Stored `h3_cell` value isn't a valid H3 cell ID      |
| 401    | `"common.errors.auth_required"`         | Missing / invalid / expired token                    |
| 500    | `"common.errors.unable_to_process"`     | Database failure                                     |

---

## Server ↔ n8n Contract

### Fastify → n8n

```http
POST {N8N_MEETUP_WEBHOOK_URL} HTTP/1.1
Content-Type: application/json
X-N8N-Secret: <N8N_WEBHOOK_SECRET>

{ "jwt": "<user_access_token>", "type": "coffee" }
```

The n8n workflow verifies `X-N8N-Secret` matches the configured secret. If not, it responds with 401.

### n8n → Fastify

The workflow's Fetch Context node calls:

```http
GET {APP_BASE_URL}/ai/meetup/spots/context HTTP/1.1
Authorization: Bearer <jwt-from-webhook-body>
```

### n8n → Fastify (final response)

```json
{
  "success": true,
  "spots": [
    {
      "name": "...",
      "address": "...",
      "distanceMeters": 271,
      "mapsUrl": "https://www.google.com/maps/search/?api=1&query=...",
      "reason": "..."
    }
  ]
}
```

Fastify validates this shape via `extractSpots()` — any malformed response triggers a 503 to the client.

---

## Caching

- Cache key: `meetup:spots:{userId}:{type}`
- TTL: 1800 seconds (30 minutes)
- The cache is **not** invalidated when the user moves to a new H3 cell. The client should expect stale-up-to-30-minutes results, or call again after the TTL.
- `cached: true` on the response indicates the body came from cache.

---

## Configuration

`.env` additions:

```
N8N_MEETUP_WEBHOOK_URL=http://n8n:5678/webhook/meetup-spots
N8N_WEBHOOK_SECRET=<random-secret>
```

Inside n8n (Docker env vars):

```
N8N_WEBHOOK_SECRET=<same-as-above>
APP_BASE_URL=http://api:3000
OLA_MAPS_API_KEY=<ola-maps-key>
GROQ_API_KEY=<groq-key>   # used as Authorization: Bearer header by the HTTP nodes
```

See `n8n-workflows/README.md` for the full n8n setup walkthrough.

---

## Client Implementation Tips

- **Show a loading state** while waiting — pipeline runs ~3–8 seconds end-to-end (uncached).
- **Display the `reason` field verbatim** under each spot's name.
- **Pull-to-refresh** is mostly a no-op due to the 30-min cache; consider only enabling it after the cache TTL has elapsed.
- **Handle empty `spots[]`** as a normal state, not an error.
- **`mapsUrl` opens Google Maps** — on iOS this opens Google Maps app if installed, otherwise Apple Maps fallback can be configured client-side.
- **No `rating` field** — Ola Maps Nearby Search does not return ratings; do not expect or render star ratings.
