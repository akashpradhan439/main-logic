# n8n Workflows

This directory contains n8n workflow JSON files that orchestrate the AI features.

## meetup-spots.json

Pipeline behind `GET /ai/meetup/spots`. The Fastify server calls this workflow's
webhook synchronously; the workflow returns a ranked list of meet-up spots.

### Pipeline

```
Webhook (POST /webhook/meetup-spots, header X-N8N-Secret)
  → Verify Secret (IF node)
       ├─ pass → Fetch Context (HTTP, calls Fastify /ai/meetup/spots/context)
       │           → Groq: Format Search Params (HTTP → Groq llama-3.3-70b-versatile)
       │           → Parse Search Params (Code: JSON.parse)
       │           → Ola Maps Nearby Search (HTTP, https://api.olamaps.io/places/v1/nearbysearch)
       │           → Normalize Places (Code: map predictions)
       │           → Groq: Recommend Spots (HTTP → Groq llama-3.3-70b-versatile)
       │           → Build Response (Code: merge AI reasons with place data, build mapsUrl)
       │           → Respond Success
       └─ fail → Respond Unauthorized (401)
```

Both AI nodes use plain HTTP Request nodes calling `https://api.groq.com/openai/v1/chat/completions`
directly — no n8n-specific Groq integration is required, and the workflow works on any n8n version.
`response_format: { type: "json_object" }` is set on both calls so Groq guarantees parseable JSON.

### Setup

1. **Import** the JSON via n8n UI → Workflows → Import from File → `meetup-spots.json`.

2. **Set n8n environment variables** (Docker `-e` or `n8n` config):
   ```
   N8N_WEBHOOK_SECRET     — shared secret with the Fastify server (must match config.n8nWebhookSecret)
   APP_BASE_URL           — internal URL to reach your Fastify container, e.g. http://app:3000
   OLA_MAPS_API_KEY       — your Ola Maps API key
   GROQ_API_KEY           — your Groq API key (from https://console.groq.com/keys)
   ```
   In a Docker Compose setup, `APP_BASE_URL` is typically the service name of your Fastify app
   container, e.g. `http://api:3000` if your service is named `api`.

3. **No additional credentials needed** — both Groq HTTP calls authenticate via `Authorization: Bearer {{ $env.GROQ_API_KEY }}` header from the env var above. Just make sure `GROQ_API_KEY` is set in the n8n container's env.

4. **Activate** the workflow. Note the webhook URL shown by n8n — it will look like:
   ```
   http://<your-n8n-host>:5678/webhook/meetup-spots
   ```
   Set this URL on your Fastify server as `N8N_MEETUP_WEBHOOK_URL` in `.env`.

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
