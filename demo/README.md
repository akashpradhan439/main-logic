# Lokaal — Agent Swarm Live Demo

A self-contained web app that drives the project's **real 4-agent swarm**
(Planner → Researcher → Executor → Critic) and the continuous-chat AI assistant
against **live Azure AI Foundry inference** (Llama-3.3-70B-Instruct) and real
Supabase / Foursquare data — streaming every agent step to the browser.

Built for the Microsoft Build AI Hackathon submission as the live interaction surface.

## Run

```bash
npm run demo
# → http://localhost:4505
```

Uses the repo's existing `.env` (Azure, Supabase, Redis, Foursquare).

**Login:** `microsoft` / `microsoft`

## The three features

| Feature | Type | What it shows |
|---|---|---|
| **Connection Suggestions** | one-shot swarm | Planner→Researcher→Executor→Critic produce ranked connection suggestions, with the adversarial Critic approving/rejecting. |
| **Meetup Suggestions** | one-shot swarm | Same swarm, plus Foursquare venue grounding at the **midpoint** between you and each connection (person + venue + time cards). |
| **AI Assistant** | continuous chat | Live tool-calling (places/events) narrated with the same 4 roles; has a **Reset** button. |

Each agent has a fixed color: **Planner** cyan · **Researcher** amber ·
**Executor** green · **Critic** red. Every agent output is logged live in the
workflow panel. The two swarm features have a **Stop** button that aborts the
run mid-flight.

### Live model inference

Beyond the step log, the demo streams the **raw token output of the Azure AI
Foundry model (Llama-3.3-70B-Instruct)** as it generates — each swarm agent
shows a live "🧠 streaming" block of the actual model output, and the assistant
types its reply token-by-token. This uses Azure's streaming completions
(`stream: true`); the full text is still accumulated so the swarm's JSON parsing
is unaffected. Streaming is enabled only for the demo surface — production code
paths remain non-streaming.

## Security model

> The demo credential is intentionally visible in client JS (a shared demo
> credential — the requested "leak"), **but the server independently enforces it.**

- `POST /api/login` re-checks the credential with a constant-time compare and
  mints an **HMAC-signed, 8-hour session token**.
- **Every** `/api/*` route except login requires a valid token → no token = `401`.
  The swarm, the assistant, and the demo user are unreachable anonymously.
- Failed logins are rate-limited per IP.
- Static files are served only from `demo/public/` with path-traversal guards.
- Strict security headers (CSP `default-src 'self'`, `X-Frame-Options: DENY`,
  `nosniff`, no CORS) — browsers block cross-origin API calls.

## Demo user

The server auto-selects a well-connected Supabase user whose location has the
**densest Foursquare venue coverage** (probed once at first request), so the
meetup swarm has real venues to ground on. Pin a specific user with
`DEMO_USER_ID=<uuid>` in the environment.

## Exposing a public live link

The server binds `0.0.0.0:4505`. To get a shareable URL:

- **Tunnel:** `cloudflared tunnel --url http://localhost:4505` (or `ngrok http 4505`)
- **Oracle VM:** deploy alongside the existing stack and reverse-proxy `/` to `:4505`.

## Implementation notes

The demo reuses the production swarm/assistant code unchanged in behavior. Two
**additive, default-noop** hooks were added so a UI can observe inference live:

- `runSwarm({ …, hooks: { emit, signal } })` in `lib/agentSwarm.ts` — streams
  `agent_start` / `trace` / `phase` / `result` events and supports `AbortSignal`.
- `chatWithAssistant(…, onStep)` in `lib/aiClient.ts` — emits classify / tool /
  reply / grounding steps and card events.

Existing callers pass neither argument, so production behavior is identical.
