# Agent Swarm Constitution

## Problem Statement

Helping users plan safe, meaningful in-person meetups with people they've crossed paths with requires more than a single LLM call. The task needs sequential reasoning: who should they meet, where should they go, is the suggestion safe and specific enough to be useful? A naive single-prompt approach produces generic, unverifiable suggestions. A swarm with specialized agents and adversarial validation produces auditable, privacy-safe, context-aware results.

---

## Agent Roster

### 1. Planner (Orchestrator)

| Field | Value |
|---|---|
| **Role** | Entry point; decomposes the user request into a structured execution plan |
| **Goal** | Produce a prioritized TaskPlan with named sub-tasks for Researcher and Executor |
| **Tooling** | Azure OpenAI (GPT-4o) via `lib/azureClient.ts` |
| **Input** | `taskType` ("meetup" or "connections") + user profile (firstName, bio, interests) |
| **Output** | `TaskPlan { intent: string, tasks: [{ id, description, priority }] }` |
| **Handoff** | Passes plan to Researcher via `SwarmState.plan` |
| **Fallback** | If LLM unavailable, uses a hardcoded 4-task default plan |

---

### 2. Researcher

| Field | Value |
|---|---|
| **Role** | Data gatherer; fetches all real-world signals needed for suggestion generation |
| **Goal** | Build a complete `ResearchData` bundle from live databases and APIs |
| **Tooling** | Supabase (user profiles, connections, notifications), Foursquare API (nearby venues), H3 spatial index |
| **Input** | `SwarmState.userId` + `SwarmState.plan` |
| **Output** | `ResearchData { userProfile, connections[], venues[] }` |
| **Handoff** | Passes research bundle to Executor via `SwarmState.research` |
| **Signals gathered** | Shared interests, proximity count (from notifications table), nearby (same H3 cell), friendship graph |

---

### 3. Executor

| Field | Value |
|---|---|
| **Role** | Suggestion generator; transforms research data into personalized, actionable suggestions |
| **Goal** | Generate 2–4 specific meetup cards or connection suggestions grounded in real data |
| **Tooling** | Azure OpenAI (GPT-4o) with structured JSON output |
| **Input** | `SwarmState.research` + optional `critiqueResult.feedback` (on retry) + optional human feedback |
| **Output** | `SuggestionOutput { meetupSuggestions[] | connectionSuggestions[] }` |
| **Handoff** | Passes output to Critic via `SwarmState.executorOutput` |
| **Constraint** | May only reference connectionIds and venue names that appear in `ResearchData` |

---

### 4. Critic (Validator)

| Field | Value |
|---|---|
| **Role** | Adversarial validator; tries to find safety, specificity, and relevance flaws |
| **Goal** | Approve only suggestions that are safe, specific to real data, and meaningfully personalized |
| **Tooling** | Azure OpenAI (GPT-4o) for evaluation; Azure AI Content Safety (optional, via `AZURE_CONTENT_SAFETY_KEY`) |
| **Input** | `SwarmState.executorOutput` + `SwarmState.research` (for ground-truth validation) |
| **Output** | `CritiqueResult { approved: boolean, feedback: string, issues: string[] }` |
| **Handoff** | If approved → `SwarmState.finalResult`; if rejected → back to Executor with `feedback` |
| **Fail-open rule** | If Critic itself errors, it approves the output to prevent user-facing failures |

---

## Rules of Engagement (Constitution)

1. **No fabrication** — Executor may only reference `connectionId` values and venue names present in `ResearchData`. The Critic rejects any suggestion that references a connection or venue not in the research bundle.

2. **Specificity rule** — Every meetup suggestion must name a specific person AND a specific venue. One-sentence generic suggestions ("You two might like coffee") are rejected.

3. **Privacy rule** — No PII (phone numbers, email addresses, last names) leaves the swarm in suggestion output. Only `connectionId` (UUID) references are used.

4. **Safety first** — Critic must reject content that is inappropriate, discriminatory, or unsafe. Azure AI Content Safety is integrated as an optional second check.

5. **Adversarial loop** — If Critic rejects, it passes specific `issues[]` back to Executor. Executor must address each issue in the next attempt. Maximum 3 attempts before human escalation.

6. **Human-in-the-loop** — After 3 failed critique cycles, the swarm pauses (`phase = "awaiting_human"`). A human may approve the current output via `POST /swarm/:runId/approve`, or reject it with feedback that triggers one final Executor pass.

7. **Full traceability** — Every agent step appends an `AgentTrace` entry: agent name, timestamp, input summary, output summary, duration, and status. The complete trace is accessible via `GET /swarm/trace/:runId` and returned inline with every swarm response.

8. **Fail gracefully** — If any agent's LLM call fails, the swarm continues rather than crashing. Planner falls back to a default plan; Critic fails open; Executor errors bubble up as phase `"error"` with the `error` field set.

---

## Handoff Protocol

All state is passed via a single `SwarmState` object persisted in Redis (Azure Cache for Redis in production). Each agent reads from and writes to this shared object — the "blackboard."

```
SwarmState {
  runId          string          — UUID for this execution
  userId         string          — Authenticated user
  taskType       meetup|connections
  phase          planning|research|execution|critique|complete|awaiting_human|error
  plan           TaskPlan        — Set by Planner
  research       ResearchData    — Set by Researcher
  executorOutput SuggestionOutput — Set by Executor
  critiqueResult CritiqueResult  — Set by Critic
  attempts       number          — Executor attempt counter
  maxAttempts    number          — Default: 3
  humanApprovalRequired boolean  — Set when max attempts exceeded
  finalResult    SuggestionOutput — Set when approved
  trace          AgentTrace[]    — Full audit log
  llmProvider    "azure"|"groq"  — Which LLM backend was used
  createdAt      ISO timestamp
  updatedAt      ISO timestamp
  error          string | null
}
```

Redis key: `swarm:run:{runId}` · TTL: 1800s (30 min)

---

## API Surface

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/swarm/meetup` | Run the full 4-agent meetup planning swarm |
| `POST` | `/swarm/connections` | Run the 4-agent connection suggestion swarm |
| `GET` | `/swarm/trace/:runId` | Inspect the full agent trace for any run |
| `POST` | `/swarm/:runId/approve` | Human-in-the-loop: approve or reject with feedback |
| `GET` | `/swarm/status` | LLM provider health check |

---

## Technology Stack

| Component | Technology |
|---|---|
| Orchestration framework | Custom TypeScript agent loop (`lib/agentSwarm.ts`) |
| LLM | Azure OpenAI (GPT-4o) · Groq (llama-3.3-70b) as fallback |
| State / Blackboard | Redis (Azure Cache for Redis) |
| Database | Supabase / PostgreSQL |
| Location signals | Uber H3 spatial indexing |
| Venue data | Foursquare Places API |
| Content safety | Azure AI Content Safety (optional) |
| API server | Fastify 5 / TypeScript |
