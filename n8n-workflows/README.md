# n8n Workflows

This directory contains n8n workflow JSON files that orchestrate the AI features.

## events-scraper.json

Pipeline behind the AI assistant's `search_events` tool. The Fastify server (`lib/eventsScraper.ts`) calls this workflow's webhook; the workflow does the actual Google Events scraping with a headless Playwright browser and uses Azure AI Foundry to extract structured events from the rendered HTML.

### Pipeline

```
Webhook (POST /webhook/events-scraper, header X-N8N-Secret)
  → Verify Secret (IF node)
       ├─ pass → Validate Input (Code: trim + length checks on query/location)
       │           → Playwright Scraper (Execute Command → python3 scripts/scrape.py)
       │                   ↳ SQLite cache (4h TTL) → returns cached events OR raw HTML
       │           → Parse Scraper Output (Code: route cache vs live)
       │           → Cache Hit? (IF node)
       │                ├─ hit  → Webhook Response (success, fromCache=true)
       │                └─ miss → Azure: Parse Events (HTTP → Azure AI Foundry, Llama-3.3-70B-Instruct, JSON mode)
       │                        → Validate + Clean Events (Code: schema check, cap to 20)
       │                        → Webhook Response (success, fromCache=false)
       └─ fail → Respond Unauthorized (401)
```

### Setup

The scraping runs in a dedicated `scraper` sidecar container (Python + Playwright + Chromium) that exposes `POST /scrape` on port `8080`. The n8n workflow's "Playwright Scraper" node is an HTTP Request node that calls `${SCRAPER_SERVICE_URL}/scrape`. This keeps the n8n image lean and means the Linux-only browser dependencies live in one place.

**With docker-compose.prod.yml (recommended):**
The stack already wires this up — `docker compose -f docker-compose.prod.yml up -d --build` brings up:
- `mainlogic-scraper` → built from `scraper-service/Dockerfile`, mounts `scraper_cache` volume at `/data`
- `mainlogic-n8n` → gets `SCRAPER_SERVICE_URL=http://scraper:8080` and auto-imports + publishes the events-scraper workflow on start

**Required environment variables (in `.env` consumed by docker-compose):**
```
N8N_WEBHOOK_SECRET   — shared secret with Fastify (must match config.n8nWebhookSecret)
```

**Manual / non-Docker setup:**
1. Build & run the scraper service: `cd scraper-service && docker build -t mainlogic-scraper . && docker run -p 8080:8080 mainlogic-scraper`
2. Set `SCRAPER_SERVICE_URL=http://localhost:8080` (and `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, `N8N_WEBHOOK_SECRET`) on your n8n process.
3. Import `events-scraper.json` via n8n UI and activate it.

In every case, point the Fastify server at the n8n webhook URL:
```
N8N_EVENTS_SCRAPER_WEBHOOK_URL=http://<n8n-host>:5678/webhook/events-scraper
```

### Testing the workflow manually

```bash
curl -X POST http://localhost:5678/webhook/events-scraper \
  -H "Content-Type: application/json" \
  -H "X-N8N-Secret: $N8N_WEBHOOK_SECRET" \
  -d '{"query":"live music concerts","location":"New Delhi"}'
```

Expected response:
```json
{
  "success": true,
  "count": 6,
  "fromCache": false,
  "events": [
    {
      "title": "Indie Night ft. Local Bands",
      "date": "Sat, Jun 7",
      "time": "8:00 PM",
      "venue": "Antisocial",
      "address": "Hauz Khas Village, New Delhi",
      "url": "https://insider.in/...",
      "source": "Insider",
      "price": "From ₹499"
    }
  ]
}
```

## meetup-spots.json

Pipeline behind `GET /ai/meetup/spots`. The Fastify server calls this workflow's
webhook synchronously; the workflow returns a ranked list of meet-up spots.

### Pipeline

```
Webhook (POST /webhook/meetup-spots, header X-N8N-Secret)
  → Verify Secret (IF node)
       ├─ pass → Fetch Context (HTTP, calls Fastify /ai/meetup/spots/context)
        │           → Azure: Format Search Params (HTTP → Azure AI Foundry, Llama-3.3-70B-Instruct)
       │           → Parse Search Params (Code: JSON.parse)
       │           → Foursquare Places Search (HTTP, https://places-api.foursquare.com/places/search)
       │           → Normalize Places (Code: map results)
        │           → Azure: Recommend Spots (HTTP → Azure AI Foundry, Llama-3.3-70B-Instruct)
       │           → Build Response (Code: merge AI reasons with place data, build mapsUrl)
       │           → Respond Success
       └─ fail → Respond Unauthorized (401)
```

Both AI nodes use plain HTTP Request nodes calling Azure AI Foundry (OpenAI-compatible endpoint)
directly — no n8n-specific integration is required, and the workflow works on any n8n version.
`response_format: { type: "json_object" }` is set on both calls so the model guarantees parseable JSON.

### Setup

1. **Import** the JSON via n8n UI → Workflows → Import from File → `meetup-spots.json`.

2. **Set n8n environment variables** (Docker `-e` or `n8n` config):
   ```
   N8N_WEBHOOK_SECRET            — shared secret with the Fastify server (must match config.n8nWebhookSecret)
   APP_BASE_URL                  — internal URL to reach your Fastify container, e.g. http://app:3000
   FOURSQUARE_API_KEY            — your Foursquare Places API key
   AZURE_OPENAI_ENDPOINT         — Azure AI Foundry endpoint (OpenAI-compatible)
   AZURE_OPENAI_API_KEY          — Azure AI Foundry API key
   AZURE_OPENAI_DEPLOYMENT       — model deployment name (default: Llama-3.3-70B-Instruct)
   N8N_BLOCK_ENV_ACCESS_IN_NODE  — must be `false` (default is `true` in recent n8n versions)
   ```
   In a Docker Compose setup, `APP_BASE_URL` is typically the service name of your Fastify app
   container, e.g. `http://api:3000` if your service is named `api`.

   > **Why `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` is required:** the workflow's `Verify Secret` IF node and HTTP nodes resolve credentials via `{{ $env.* }}` expressions. Recent n8n versions block expression access to environment variables by default, which causes the first execution to fail with `ExpressionError: access to env vars denied`.

3. **No additional credentials needed** — both AI calls authenticate via `Authorization: Bearer {{ $env.AZURE_OPENAI_API_KEY }}` header. Foursquare authenticates via `Authorization: Bearer {{ $env.FOURSQUARE_API_KEY }}` header.

4. **Activate** the workflow. Note the webhook URL shown by n8n — it will look like:
   ```
   http://<your-n8n-host>:5678/webhook/meetup-spots
   ```
   Set this URL on your Fastify server as `N8N_MEETUP_WEBHOOK_URL` in `.env`.

## meetup-suggestions.json

Pipeline behind `GET /ai/meetup/suggestions`. The Fastify server calls this workflow's
webhook synchronously; the workflow returns personalized meet-up suggestion cards. It runs
Foursquare venue search and the events scraper in parallel, then feeds both into an
LLM generate-then-validate loop.

### Pipeline

```
Webhook (POST /webhook/meetup-suggestions, header X-N8N-Secret)
  → Verify Secret (IF node)
       ├─ pass → Fetch Context (HTTP, calls Fastify /ai/meetup/suggestions/context)
       │           ├─→ Foursquare Places Search (HTTP, https://places-api.foursquare.com/places/search)
       │           │       → Normalize Places (Code: map results)
       │           │       ──────────────┐
       │           └─→ Events Scraper Call (HTTP, POST /webhook/events-scraper)
       │                   → Normalize Events (Code: extract events array)
       │                   ──────────────┤
       │                                 ├→ Merge Results (Append)
       │                                 │   → Prepare Input (Code: combine context+places+events)
       │                                 │       → Generate + Supervisor Loop (Code: LLM gen + deterministic + supervisor)
       │                                 │           → Build Response → Respond Success
       └─ fail → Respond Unauthorized (401)
```

The Generate + Supervisor Loop runs up to 4 iterations of:
1. LLM generation (Azure AI Foundry, Llama-3.3-70B, temperature 0.85)
2. Deterministic validation (connectionId existence, type match, name match, text rules, banned phrases)
3. LLM supervisor review (temperature 0.1, APPROVE/REJECT)
4. If REJECTED, feedback feeds back into the next generation attempt

Events data is passed to the LLM so it can reference real upcoming events in suggestions
(e.g. "There's a jazz night at Blue Tokai this Saturday you'd both love").

### Setup

1. **Import** the JSON via n8n UI → Workflows → Import from File → `meetup-suggestions.json`.

2. **Set n8n environment variables** (Docker `-e` or `n8n` config):
   ```
   N8N_WEBHOOK_SECRET            — shared secret with the Fastify server
   APP_BASE_URL                  — internal URL to reach your Fastify container
   FOURSQUARE_API_KEY            — your Foursquare Places API key
   AZURE_OPENAI_ENDPOINT         — Azure AI Foundry endpoint
   AZURE_OPENAI_API_KEY          — Azure AI Foundry API key
   AZURE_OPENAI_DEPLOYMENT       — model deployment name (default: Llama-3.3-70B-Instruct)
   N8N_EVENTS_SCRAPER_WEBHOOK_URL — internal URL to call the events scraper webhook on this n8n instance (e.g. http://localhost:5678/webhook/events-scraper)
   N8N_BLOCK_ENV_ACCESS_IN_NODE  — must be `false`
   ```

3. The events scraper workflow must also be imported and activated on the same n8n instance.
   `N8N_EVENTS_SCRAPER_WEBHOOK_URL` must point to the events scraper webhook on this n8n instance.
   If the scraper is unreachable or the env var is not set, the workflow continues gracefully without events data.

4. **Activate** the workflow. Set the webhook URL on your Fastify server as
   `N8N_MEETUP_SUGGESTIONS_WEBHOOK_URL` in `.env`.

### Network Notes (Docker)

If both Fastify and n8n run in the same Docker network:
- Fastify → n8n: use the n8n container's service name (e.g. `http://n8n:5678/webhook/meetup-spots`)
- n8n → Fastify: use the Fastify service name (e.g. `APP_BASE_URL=http://api:3000`)

If you're running n8n separately, expose it publicly and point Fastify at its public URL.

### Testing the workflow manually

You can hit the webhook directly with curl using any valid JWT from your app:

```bash
curl -X POST http://localhost:5678/webhook/meetup-spots \
  -H "Content-Type: application/json" \
  -H "X-N8N-Secret: $N8N_WEBHOOK_SECRET" \
  -d '{"jwt":"<user_access_token>","type":"coffee"}'
```

Expected response:
```json
{
  "success": true,
  "spots": [
    {
      "name": "Third Wave Coffee",
      "address": "MG Road, Bangalore",
      "distanceMeters": 850,
      "mapsUrl": "https://www.google.com/maps/search/?api=1&query=12.97,77.59",
      "reason": "A quiet specialty coffee spot — fits your love of coffee and coding."
    }
  ]
}
```
