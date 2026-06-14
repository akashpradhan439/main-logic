# Profile & AI Connection Suggestions API — Client Reference

## Overview

This API surface adds two capabilities to the platform:

1. **Profile** — users store a free-text `bio` and a list of `interests`. These power discovery and connection matching.
2. **AI Connection Suggestions** — Azure AI Foundry (Llama-3.3-70B-Instruct) powered ranked list of users you might want to connect with, generated from your profile, location history, social graph, and proximity co-occurrences.

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

This response is returned when the `Authorization` header is missing, malformed, the token is expired, or the token type is not `"access"`.

---

## Common Response Envelope

All endpoints follow the same outer shape:

```json
{ "success": true,  ... }
```
or
```json
{ "success": false, "error": <string | object> }
```

`error` is either a translation key (e.g. `"common.errors.unable_to_process"`) or a Zod field-error object on 400 validation failures (see [Validation Errors](#validation-errors) below).

---

# Profile

## GET /profile

Fetch the authenticated user's own profile.

**Request:**

```http
GET /profile HTTP/1.1
Authorization: Bearer <access_token>
```

No request body. No query parameters.

**Success — 200 OK:**

```json
{
  "success": true,
  "profile": {
    "id": "9a4d2f7c-8a55-4e2f-9a8d-3f6e4a1b9c12",
    "firstName": "Akash",
    "lastName": "Pradhan",
    "bio": "Software engineer who loves hiking on weekends.",
    "interests": ["hiking", "coffee", "photography"]
  }
}
```

| Field         | Type            | Notes                                  |
|---------------|-----------------|----------------------------------------|
| `id`          | string (UUID)   | The user's own ID                      |
| `firstName`   | string          | From the `users` row                   |
| `lastName`    | string          | From the `users` row                   |
| `bio`         | string \| null  | `null` if user has not set a bio       |
| `interests`   | string[]        | Empty array if user has not set any    |

**Failures:**

| Status | `error` body                              | Cause                                |
|--------|-------------------------------------------|--------------------------------------|
| 401    | `"common.errors.auth_required"`           | Missing / invalid / expired token    |
| 500    | `"common.errors.unable_to_process"`       | Database failure                     |

---

## PATCH /profile

Update the authenticated user's `bio` and/or `interests`. Both fields are optional individually but the body must contain at least one of them.

**Request:**

```http
PATCH /profile HTTP/1.1
Authorization: Bearer <access_token>
Content-Type: application/json
```

**Body schema (strict — unknown keys are rejected):**

| Field       | Type                  | Required | Constraints                                                                 |
|-------------|-----------------------|----------|------------------------------------------------------------------------------|
| `bio`       | string \| null        | optional | Max 300 characters. Pass `null` to clear.                                    |
| `interests` | string[]              | optional | Max 15 items. Each item 1–50 chars. Server lowercases and trims each entry.  |

**Example body:**

```json
{
  "bio": "Software engineer who loves hiking on weekends.",
  "interests": ["Hiking", "  Coffee  ", "photography"]
}
```

The server will normalize `interests` to `["hiking", "coffee", "photography"]` (trimmed + lowercased) before saving.

**Success — 200 OK:**

```json
{
  "success": true,
  "profile": {
    "bio": "Software engineer who loves hiking on weekends.",
    "interests": ["hiking", "coffee", "photography"]
  }
}
```

The response echoes back the persisted values after normalization.

**Failures:**

| Status | `error` body                                          | Cause                                                                  |
|--------|-------------------------------------------------------|------------------------------------------------------------------------|
| 400    | Zod field-error object (see below)                    | Body fails validation (too long, wrong type, unknown key, etc.)         |
| 400    | `"common.errors.invalid_parameter"`                   | Body parses but contains no recognized fields (nothing to update)       |
| 401    | `"common.errors.auth_required"`                       | Missing / invalid / expired token                                       |
| 500    | `"common.errors.unable_to_process"`                   | Database failure                                                        |

### Validation Errors

When body validation fails, `error` is a Zod field-error object keyed by field name. Example:

```json
{
  "success": false,
  "error": {
    "bio": ["String must contain at most 300 character(s)"],
    "interests": ["Array must contain at most 15 element(s)"]
  }
}
```

Client should display these field-by-field. Unknown keys produce errors under the unrecognized key name.

---

# AI Connection Suggestions

## GET /ai/connections/suggestions

Returns a ranked list of suggested users to connect with, each with a short AI-generated reason.

Behind the scenes:
1. **Cache check** — the response is cached in Redis for 15 minutes per user. Subsequent calls within the window return the cached list.
2. **Candidate gathering** — the server combines three signal sources:
   - Users currently in your H3 cell or one of its neighbors (`isNearby`).
   - Users who have appeared with you in the proximity `notifications` table (`proximityCount`).
   - Friends-of-friends via your accepted `connections` (`mutualConnections`).
3. **Filtering** — excludes yourself and anyone you already have a connection row with (`pending`, `accepted`, `rejected`, or `blocked`).
4. **Pre-ranking** — local score `sharedInterests*3 + mutualConnections*2 + proximityCount + (isNearby ? 1 : 0)`, top 20 forwarded to Azure AI Foundry.
5. **Azure AI Foundry ranking + reasoning** — `Llama-3.3-70B-Instruct` returns a sorted JSON array with a 1–2 sentence reason for each suggestion. If Azure AI Foundry is unavailable or returns malformed output, the server falls back to deterministic reason strings.
6. **Top 10** are returned and cached.

**Request:**

```http
GET /ai/connections/suggestions HTTP/1.1
Authorization: Bearer <access_token>
```

No request body. No query parameters.

**Success — 200 OK:**

```json
{
  "success": true,
  "cached": false,
  "suggestions": [
    {
      "userId": "f1d2c3b4-5a6e-7f8a-9b0c-1d2e3f4a5b6c",
      "firstName": "Maya",
      "lastName": "Rao",
      "bio": "Trail runner and amateur photographer based in Bangalore.",
      "interests": ["hiking", "photography", "running"],
      "reason": "You both enjoy hiking and photography, and you've crossed paths twice nearby this week."
    },
    {
      "userId": "a7b8c9d0-1e2f-3a4b-5c6d-7e8f9a0b1c2d",
      "firstName": "Rohan",
      "lastName": "Iyer",
      "bio": null,
      "interests": ["coffee"],
      "reason": "You share an interest in coffee and have 2 mutual connections."
    }
  ]
}
```

**Top-level response fields:**

| Field         | Type      | Notes                                                                  |
|---------------|-----------|------------------------------------------------------------------------|
| `success`     | boolean   | Always `true` for 200 responses                                        |
| `cached`      | boolean   | `true` if served from the 15-min Redis cache, `false` if freshly computed |
| `suggestions` | object[]  | Up to 10 ranked suggestions. May be empty (see below).                 |

**Suggestion item fields:**

| Field         | Type              | Notes                                                          |
|---------------|-------------------|----------------------------------------------------------------|
| `userId`      | string (UUID)     | The suggested user's ID. Use this with `POST /connections/requests`. |
| `firstName`   | string            | From their `users` row                                         |
| `lastName`    | string            | From their `users` row                                         |
| `bio`         | string \| null    | `null` if the suggested user has not set a bio                 |
| `interests`   | string[]          | The suggested user's interests; empty if not set               |
| `reason`      | string            | 1–2 sentence AI-generated explanation, suitable for direct display |

### Empty Result

If no candidates pass filtering (e.g. new user with no nearby activity and no connections):

```json
{
  "success": true,
  "cached": false,
  "suggestions": []
}
```

This is **not** an error — the client should display an empty-state message such as "No suggestions yet — try updating your location or interests."

### Cold-Start Behaviour

| State                                  | Likely outcome                                                  |
|----------------------------------------|-----------------------------------------------------------------|
| User has no bio/interests, no h3_cell  | `suggestions: []`                                               |
| User has h3_cell but no connections    | Nearby users (if any) appear, ranked by proximity & shared interests |
| User has connections but no profile    | Friends-of-friends appear, ranked by mutual count               |
| Azure AI Foundry not configured        | Suggestions still returned with deterministic fallback reasons  |
| Redis unavailable                      | Cache is silently skipped — Azure AI Foundry is called on every request |

### Caching Semantics

- Cache key: `ai:suggestions:{userId}`, TTL 900 seconds (15 minutes).
- The cache is **not** invalidated automatically when you accept/reject/block users or update your profile. The client should expect stale-up-to-15-minutes behavior, or call again after the TTL.
- `cached: true` on the response indicates the body came from cache.

**Failures:**

| Status | `error` body                          | Cause                                                                    |
|--------|---------------------------------------|--------------------------------------------------------------------------|
| 401    | `"common.errors.auth_required"`       | Missing / invalid / expired token                                        |
| 500    | `"common.errors.unable_to_process"`   | Database failure fetching profile/connections/candidates, or unexpected server error |

> Note: Azure AI Foundry API failures do **not** produce a 500. The server falls back to deterministic reasons and still returns 200.

---

# Example Flows

## A. First-time profile setup

```http
PATCH /profile HTTP/1.1
Authorization: Bearer eyJhbGc...
Content-Type: application/json

{
  "bio": "Coffee + code + climbing.",
  "interests": ["coffee", "climbing", "javascript"]
}
```

Response:
```json
{
  "success": true,
  "profile": {
    "bio": "Coffee + code + climbing.",
    "interests": ["coffee", "climbing", "javascript"]
  }
}
```

## B. Discover and connect

1. Client calls `GET /ai/connections/suggestions`.
2. UI renders the `suggestions[]` list. For each card, show `firstName`, `bio`, `interests`, and the `reason` string verbatim under the user's name.
3. When the user taps "Connect", call the existing `POST /connections/requests` with `{ "target_user_id": <suggestion.userId> }`.
4. Optionally refresh suggestions; the next call within 15 min will return the cached list (the just-requested user is **not** removed from the cache until it expires). If the client wants live updates, filter out users it has just acted on locally.

## C. Clearing the bio

```http
PATCH /profile HTTP/1.1
Authorization: Bearer eyJhbGc...
Content-Type: application/json

{ "bio": null }
```

Response:
```json
{ "success": true, "profile": { "bio": null, "interests": ["coffee", "climbing", "javascript"] } }
```

---

# Client Implementation Tips

- **Display the AI `reason` field verbatim** — it is already short, friendly, and tailored. Do not try to re-render or parse it.
- **Treat the suggestions list as advisory** — `userId` should always be used as the canonical identifier; do not key UI off `firstName`.
- **Show a refresh affordance** — because the response is cached for 15 minutes, give the user a pull-to-refresh that's expected to often return the same data.
- **Handle `bio: null` and empty `interests`** — both are valid states for any user including the current one.
- **No `users` directory endpoint exists** — the only way to discover users (besides QR scan or an inbound connection request) is via this suggestions endpoint. Treat it as the primary discovery surface.

---

# Error Code Reference

| HTTP | `error` value                          | When                                                |
|------|----------------------------------------|-----------------------------------------------------|
| 400  | Zod field-error object                 | `PATCH /profile` body fails schema validation        |
| 400  | `"common.errors.invalid_parameter"`    | `PATCH /profile` body has no updatable fields        |
| 401  | `"common.errors.auth_required"`        | Any endpoint, bad/missing token                      |
| 500  | `"common.errors.unable_to_process"`    | Any endpoint, DB or unexpected server error          |

Translation keys (`common.errors.*`) are resolved through the server's i18n layer; the exact human-readable text depends on the `Accept-Language` header.
