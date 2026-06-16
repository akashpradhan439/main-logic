import { randomUUID } from "crypto";
import { supabase as defaultSupabase } from "./supabase.js";
import { redisGet, redisSet } from "./redis.js";
import { agentLLMClient } from "./azureClient.js";
import { searchNearbyPlaces } from "./foursquareClient.js";
import { midpoint } from "./connectionContext.js";
import { cellToLatLngSafe } from "../shared/h3.js";
import { analyzeTextSafety, isContentSafetyConfigured } from "./contentSafety.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskType = "meetup" | "connections";
export type AgentName = "planner" | "researcher" | "executor" | "critic";

export type AgentTrace = {
  agent: AgentName;
  timestamp: string;
  phase: string;
  inputSummary: string;
  outputSummary: string;
  durationMs: number;
  status: "completed" | "failed" | "approved" | "rejected";
  attempt?: number;
};

export type TaskPlan = {
  intent: string;
  tasks: Array<{ id: string; description: string; priority: number }>;
};

export type ConnectionCandidate = {
  userId: string;
  firstName: string;
  lastName: string;
  bio: string | null;
  interests: string[];
  sharedInterests: string[];
  nearby: boolean;
  proximityCount: number;
  mutualConnections: number;
  coords: { lat: number; lng: number } | null;
};

export type ResearchData = {
  userProfile: {
    userId: string;
    firstName: string;
    bio: string | null;
    interests: string[];
    language: string;
    coords: { lat: number; lng: number } | null;
  };
  connections: ConnectionCandidate[];
  venues: Array<{
    placeId: string;
    name: string;
    address: string;
    types: string[];
    rating: number | null;
    /** The connection this venue sits roughly halfway to (midpoint-grounded). */
    nearConnectionId?: string;
    nearConnectionName?: string;
  }>;
};

export type MeetupSuggestion = {
  type: "detailed";
  connectionId: string;
  connectionName: string;
  title: string;
  place: string;
  time: string;
  text: string;
};

export type ConnectionSuggestion = {
  userId: string;
  reason: string;
};

export type SuggestionOutput = {
  taskType: TaskType;
  meetupSuggestions?: MeetupSuggestion[];
  connectionSuggestions?: ConnectionSuggestion[];
};

export type CritiqueResult = {
  approved: boolean;
  feedback: string;
  issues: string[];
};

export type SwarmState = {
  runId: string;
  userId: string;
  taskType: TaskType;
  phase: "planning" | "research" | "execution" | "critique" | "complete" | "awaiting_human" | "error";
  plan: TaskPlan | null;
  research: ResearchData | null;
  executorOutput: SuggestionOutput | null;
  critiqueResult: CritiqueResult | null;
  attempts: number;
  maxAttempts: number;
  humanApprovalRequired: boolean;
  humanApproved: boolean | null;
  humanFeedback: string | null;
  finalResult: SuggestionOutput | null;
  trace: AgentTrace[];
  llmProvider: string;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  /** When set, the researcher narrows its candidate pool to this single connection. */
  targetConnectionId: string | null;
  /** When empty suggestions, details the reason (e.g. "too far", "no location shared"). */
  emptyReason: string | null;
};

// ─── Streaming hooks (additive — enables realtime demo surfaces) ──────────────
//
// runSwarm accepts an optional emitter + AbortSignal so a UI can observe the
// swarm as it runs and stop it mid-flight. When omitted, behavior is identical
// to before (no-op emitter, no abort). Events are plain JSON-serializable
// objects so they map straight onto SSE frames.

export type SwarmEvent =
  | { type: "agent_start"; agent: AgentName; phase: SwarmState["phase"]; attempt?: number }
  | { type: "agent"; agent: AgentName; message: string }
  | { type: "inference"; agent: AgentName; delta: string }
  | { type: "trace"; entry: AgentTrace }
  | { type: "phase"; phase: SwarmState["phase"] }
  | { type: "result"; taskType: TaskType; result: SuggestionOutput | null; approved: boolean; attempts: number; humanApprovalRequired: boolean; feedback: string }
  | { type: "error"; message: string }
  | { type: "aborted" };

export type SwarmEmit = (event: SwarmEvent) => void;

export type SwarmHooks = {
  emit?: SwarmEmit;
  signal?: AbortSignal;
};

/** Raised internally when a caller aborts a run via AbortSignal. */
export class SwarmAbortError extends Error {
  constructor() {
    super("swarm_aborted");
    this.name = "SwarmAbortError";
  }
}

// ─── Terminal colors per agent (visual fidelity for demo logs) ────────────────

const COLORS: Record<AgentName, string> = {
  planner: "\x1b[36m",    // Cyan
  researcher: "\x1b[33m", // Yellow
  executor: "\x1b[32m",   // Green
  critic: "\x1b[31m",     // Red
};
const RESET = "\x1b[0m";

// Language labels for multilingual suggestion output (the from-user's preference).
const LANG_LABELS: Record<string, string> = {
  hi: "Hindi", bn: "Bangla (Bengali)", es: "Spanish", fr: "French", ar: "Arabic",
  ja: "Japanese", pt: "Portuguese", ru: "Russian", "zh-Hans": "Simplified Chinese", "zh-Hant": "Traditional Chinese",
};
function swarmLanguageLabel(code: string | null | undefined): string {
  return code ? (LANG_LABELS[code] ?? "English") : "English";
}

function agentLog(agent: AgentName, msg: string): void {
  console.log(`${COLORS[agent]}[${agent.toUpperCase()}]${RESET} ${msg}`);
}

// ─── State persistence (Redis blackboard) ─────────────────────────────────────

const STATE_TTL = 1800;
const STATE_KEY = (runId: string) => `swarm:run:${runId}`;

async function saveState(state: SwarmState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await redisSet(STATE_KEY(state.runId), JSON.stringify(state), STATE_TTL);
}

export async function loadSwarmState(runId: string): Promise<SwarmState | null> {
  const raw = await redisGet(STATE_KEY(runId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SwarmState;
  } catch {
    return null;
  }
}

function trace(
  state: SwarmState,
  agent: AgentName,
  phase: string,
  inputSummary: string,
  outputSummary: string,
  durationMs: number,
  status: AgentTrace["status"],
  attempt?: number
): void {
  const entry: AgentTrace = { agent, timestamp: new Date().toISOString(), phase, inputSummary, outputSummary, durationMs, status };
  if (attempt !== undefined) entry.attempt = attempt;
  state.trace.push(entry);
}

// ─── LLM helper ───────────────────────────────────────────────────────────────

async function llm(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2048,
  onToken?: (delta: string) => void
): Promise<unknown> {
  const text = await agentLLMClient.complete({
    systemPrompt,
    userPrompt,
    maxTokens,
    ...(onToken ? { onToken } : {}),
  });
  return JSON.parse(text);
}

// ─── Agent: Planner ──────────────────────────────────────────────────────────

async function plannerAgent(
  state: SwarmState,
  userProfile: { firstName: string; bio: string | null; interests: string[] },
  onToken?: (delta: string) => void
): Promise<void> {
  const t0 = Date.now();
  agentLog("planner", `Decomposing task: ${state.taskType} for ${userProfile.firstName}`);
  state.phase = "planning";

  const sys = `You are the Orchestrator agent for a privacy-first social platform.
Decompose the user's request into concrete sub-tasks for a Researcher and Executor agent.
Return ONLY valid JSON: { "intent": "string", "tasks": [{ "id": "string", "description": "string", "priority": 1|2|3 }] }`;

  const usr = JSON.stringify({ taskType: state.taskType, user: userProfile });

  try {
    const parsed = await llm(sys, usr, 512, onToken) as { intent?: string; tasks?: unknown[] };
    state.plan = {
      intent: typeof parsed.intent === "string" ? parsed.intent : `Plan ${state.taskType}`,
      tasks: (Array.isArray(parsed.tasks) ? parsed.tasks : []).map((t) => {
        const task = t as Record<string, unknown>;
        return {
          id: typeof task.id === "string" ? task.id : randomUUID(),
          description: typeof task.description === "string" ? task.description : "",
          priority: typeof task.priority === "number" ? task.priority : 2,
        };
      }),
    };
  } catch {
    state.plan = {
      intent: `Generate ${state.taskType} suggestions for ${userProfile.firstName}`,
      tasks: [
        { id: "t1", description: "Fetch user connections and proximity signals", priority: 1 },
        { id: "t2", description: "Find relevant venues and events nearby", priority: 1 },
        { id: "t3", description: "Generate personalized suggestions", priority: 2 },
        { id: "t4", description: "Validate safety and quality", priority: 2 },
      ],
    };
  }

  const ms = Date.now() - t0;
  agentLog("planner", `Plan ready — "${state.plan.intent}" (${state.plan.tasks.length} tasks, ${ms}ms)`);
  trace(state, "planner", "planning", `taskType=${state.taskType}`, `intent="${state.plan.intent}", tasks=${state.plan.tasks.length}`, ms, "completed");
}

function getDistanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371; // Radius of the earth in km
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const val = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.sin(dLng/2) * Math.sin(dLng/2) * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(val), Math.sqrt(1-val));
  return R * c;
}

// ─── Agent: Researcher ────────────────────────────────────────────────────────

async function researcherAgent(
  state: SwarmState,
  supabaseClient: typeof defaultSupabase,
  foursquareApiKey: string
): Promise<void> {
  const t0 = Date.now();
  agentLog("researcher", `Fetching data for user ${state.userId}`);
  state.phase = "research";

  const { data: me } = await supabaseClient
    .from("users")
    .select("id, first_name, bio, interests, h3_cell, language_preference")
    .eq("id", state.userId)
    .single();

  if (!me) throw new Error("User profile not found");

  const h3Cell = (me.h3_cell as string | null) ?? null;
  const coords = h3Cell ? cellToLatLngSafe(h3Cell) : null;
  const myInterests = (me.interests as string[] | null) ?? [];

  // Accepted connections
  const { data: connRows } = await supabaseClient
    .from("connections")
    .select("requester_id, addressee_id")
    .or(`requester_id.eq.${state.userId},addressee_id.eq.${state.userId}`)
    .eq("status", "accepted");

  const rawPartnerIds = (connRows ?? []).map((r) =>
    r.requester_id === state.userId ? r.addressee_id : r.requester_id
  ) as string[];

  let partnerIds = [...rawPartnerIds];

  // When a target connection is specified, narrow the candidate pool to just
  // that person (if they are in the accepted set). This powers the demo
  // connection-picker without changing the overall swarm logic.
  if (state.targetConnectionId) {
    if (!rawPartnerIds.includes(state.targetConnectionId)) {
      state.emptyReason = "Target user is not an accepted connection.";
    }
    partnerIds = partnerIds.filter((id) => id === state.targetConnectionId);
  }

  let connections: ConnectionCandidate[] = [];
  if (partnerIds.length > 0) {
    const [{ data: partners }, { data: notifs }] = await Promise.all([
      supabaseClient
        .from("users")
        .select("id, first_name, last_name, bio, interests, h3_cell")
        .in("id", partnerIds),
      supabaseClient
        .from("notifications")
        .select("user_a_id, user_b_id")
        .or(`user_a_id.eq.${state.userId},user_b_id.eq.${state.userId}`)
        .limit(100),
    ]);

    const proxCounts = new Map<string, number>();
    for (const n of notifs ?? []) {
      const partner = n.user_a_id === state.userId ? n.user_b_id : n.user_a_id;
      proxCounts.set(partner, (proxCounts.get(partner) ?? 0) + 1);
    }

    connections = (partners ?? [])
      .map((p) => {
        const cInterests = (p.interests as string[] | null) ?? [];
        const sharedInterests = cInterests.filter((i) => myInterests.includes(i));
        const score = sharedInterests.length * 3 + (proxCounts.get(p.id as string) ?? 0) + (p.h3_cell === h3Cell ? 2 : 0);
        const cH3 = (p.h3_cell as string | null) ?? null;
        return {
          userId: p.id as string,
          firstName: p.first_name as string,
          lastName: p.last_name as string,
          bio: (p.bio as string | null) ?? null,
          interests: cInterests,
          sharedInterests,
          nearby: h3Cell !== null && p.h3_cell === h3Cell,
          proximityCount: proxCounts.get(p.id as string) ?? 0,
          mutualConnections: 0,
          coords: cH3 ? cellToLatLngSafe(cH3) : null,
          _score: score,
        };
      })
      .sort((a, b) => b._score - a._score)
      .slice(0, 5)
      .map(({ _score: _s, ...c }) => c);
  }

  if (state.targetConnectionId && !state.emptyReason) {
    const partnerRow = connections.find((p) => p.userId === state.targetConnectionId);
    if (!partnerRow) {
      state.emptyReason = "Target connection profile not found.";
    } else if (state.taskType === "meetup") {
      if (!coords) {
        state.emptyReason = "Your location is not set.";
      } else if (!partnerRow.coords) {
        state.emptyReason = `${partnerRow.firstName} has not shared their location.`;
      } else {
        const dist = getDistanceKm(coords, partnerRow.coords);
        if (dist > 50) {
          state.emptyReason = `${partnerRow.firstName} is too far apart ~(${Math.round(dist)} km) for a meetup.`;
        }
      }
    }
  } else if (!state.targetConnectionId && connections.length === 0) {
    state.emptyReason = "You have no accepted connections.";
  }

  // Nearby venues for meetup tasks — grounded on the MIDPOINT between the user
  // and each top connection, mirroring the assistant's connection-aware planning
  // (shared `midpoint` helper). This means every meetup suggestion can cite a
  // venue that actually sits roughly halfway between the two specific people.
  let venues: ResearchData["venues"] = [];
  if (state.taskType === "meetup" && coords && foursquareApiKey) {
    // An interest-derived query can be too niche for Foursquare (0 hits), which
    // would starve the Executor and force the Critic to reject every attempt.
    // So we always fall back to a generic, high-coverage venue query.
    const interestQuery = myInterests.slice(0, 2).join(" ").trim();
    const GENERIC_QUERY = "restaurant cafe coffee";
    // Bound to the top 3 connections to cap Foursquare calls per run.
    const targets = connections.slice(0, 3);
    try {
      const perConnection = await Promise.all(
        targets.map(async (c) => {
          const center = midpoint(coords, c.coords);
          if (!center) return [];
          let places = interestQuery
            ? await searchNearbyPlaces(foursquareApiKey, center.lat, center.lng, interestQuery, 6000)
            : [];
          if (places.length === 0) {
            places = await searchNearbyPlaces(foursquareApiKey, center.lat, center.lng, GENERIC_QUERY, 6000);
          }
          return places.slice(0, 4).map((p) => ({
            placeId: p.placeId,
            name: p.name,
            address: p.address,
            types: p.types ?? [],
            rating: p.rating ?? null,
            nearConnectionId: c.userId,
            nearConnectionName: c.firstName,
          }));
        })
      );
      const seen = new Set<string>();
      for (const list of perConnection) {
        for (const v of list) {
          if (seen.has(v.placeId)) continue;
          seen.add(v.placeId);
          venues.push(v);
        }
      }
      // Fallback: no connections (or none resolvable / no midpoint venues) —
      // search around the user with the interest query then a generic one.
      if (venues.length === 0) {
        let places = interestQuery
          ? await searchNearbyPlaces(foursquareApiKey, coords.lat, coords.lng, interestQuery, 8000)
          : [];
        if (places.length === 0) {
          places = await searchNearbyPlaces(foursquareApiKey, coords.lat, coords.lng, GENERIC_QUERY, 8000);
        }
        venues = places.slice(0, 8).map((p) => ({
          placeId: p.placeId,
          name: p.name,
          address: p.address,
          types: p.types ?? [],
          rating: p.rating ?? null,
        }));
      }
      if (venues.length === 0 && !state.emptyReason) {
        state.emptyReason = "No meetup venues found nearby.";
      }
    } catch {
      agentLog("researcher", "Venue search unavailable, continuing without venues");
    }
  }

  state.research = {
    userProfile: {
      userId: state.userId,
      firstName: me.first_name as string,
      bio: (me.bio as string | null) ?? null,
      interests: myInterests,
      language: (me.language_preference as string | null) ?? "en",
      coords,
    },
    connections,
    venues,
  };

  const ms = Date.now() - t0;
  const grounded = venues.some((v) => v.nearConnectionId);
  agentLog(
    "researcher",
    `Research complete — ${connections.length} connections, ${venues.length} venues${grounded ? " (midpoint-grounded)" : ""} (${ms}ms)`
  );
  trace(state, "researcher", "research", `userId=${state.userId}`, `${connections.length} connections, ${venues.length} venues${grounded ? " (midpoint-grounded)" : ""}`, ms, "completed");
}

// ─── Agent: Executor ──────────────────────────────────────────────────────────

async function executorAgent(
  state: SwarmState,
  humanFeedback?: string,
  onToken?: (delta: string) => void
): Promise<void> {
  const t0 = Date.now();
  state.attempts += 1;
  agentLog("executor", `Generating suggestions (attempt ${state.attempts}/${state.maxAttempts})`);
  state.phase = "execution";

  if (state.emptyReason) {
    if (state.taskType === "meetup") {
      state.executorOutput = { taskType: "meetup", meetupSuggestions: [] };
    } else {
      state.executorOutput = { taskType: "connections", connectionSuggestions: [] };
    }
    const duration = Date.now() - t0;
    agentLog("executor", `Skipping suggestion generation: ${state.emptyReason}`);
    trace(state, "executor", "execution", `attempt ${state.attempts}`, `0 suggestions (skipped: ${state.emptyReason})`, duration, "completed", state.attempts);
    return;
  }

  const research = state.research!;
  const priorCritique = state.critiqueResult && !state.critiqueResult.approved
    ? `\nPREVIOUS ATTEMPT REJECTED by Critic.\nFeedback: "${state.critiqueResult.feedback}"\nIssues to fix: ${state.critiqueResult.issues.join("; ")}`
    : "";
  const humanNote = humanFeedback ? `\nHuman reviewer says: "${humanFeedback}"` : "";

  let systemPrompt: string;
  let userPromptData: unknown;

  if (state.taskType === "meetup") {
    systemPrompt = `You are the Executor agent for a privacy-first social platform.
Generate 2–4 personalized meetup suggestions. Each suggestion MUST:
1. Reference ONE specific connection by their userId from the connections list
2. Name ONE specific venue from the venues list (use the exact venue name)
3. Suggest a specific time (e.g., "This Saturday, 3pm")
4. Reference shared interests or proximity in the description
VENUE GROUNDING: each venue has a "nearConnectionId" marking the connection it sits
roughly halfway to. PREFER a venue whose nearConnectionId matches the suggestion's
connectionId — that venue is fairly located between the user and that specific person.
PERSPECTIVE: Write ALL suggestion text as an AI recommendation TO the user.
Use third-person phrasing: "You and {name} could...", "Consider meeting {name} at...",
or "{name} would enjoy...". NEVER use first-person plural ("Let's", "We can", "We should").
The user is reading this as a suggestion FROM the app, not writing it themselves.
Return ONLY valid JSON:
{"suggestions":[{"type":"detailed","connectionId":"<userId>","connectionName":"<firstName>","title":"<short title>","place":"<venue name>","time":"<specific time>","text":"<2-3 sentence description>"}]}
${priorCritique}${humanNote}`;

    userPromptData = {
      user: { firstName: research.userProfile.firstName, bio: research.userProfile.bio, interests: research.userProfile.interests },
      connections: research.connections.map((c) => ({ userId: c.userId, firstName: c.firstName, sharedInterests: c.sharedInterests, nearby: c.nearby, proximityCount: c.proximityCount })),
      venues: research.venues.map((v) => ({ name: v.name, address: v.address, types: v.types, nearConnectionId: v.nearConnectionId ?? null, nearConnectionName: v.nearConnectionName ?? null })),
    };
  } else {
    systemPrompt = `You are the Executor agent for a privacy-first social platform.
Generate connection suggestions with a specific 1–2 sentence reason for each.
Each reason MUST reference shared interests, mutual proximity, or connection signals.
Return ONLY valid JSON: {"suggestions":[{"userId":"<id>","reason":"<specific reason>"}]}
${priorCritique}${humanNote}`;

    userPromptData = {
      user: { bio: research.userProfile.bio, interests: research.userProfile.interests },
      candidates: research.connections.map((c) => ({ userId: c.userId, firstName: c.firstName, sharedInterests: c.sharedInterests, nearby: c.nearby, proximityCount: c.proximityCount })),
    };
  }

  // Multilingual: write user-facing text in the from-user's preferred language.
  const lang = research.userProfile.language;
  if (lang && lang !== "en") {
    systemPrompt += `\nLANGUAGE: Write every human-readable text field (title, time, text, reason) in ${swarmLanguageLabel(lang)}. Keep venue names, JSON keys, userId values, and "type" unchanged.`;
  }

  const parsed = await llm(systemPrompt, JSON.stringify(userPromptData), 2048, onToken) as { suggestions?: unknown[] };
  const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];

  if (state.taskType === "meetup") {
    state.executorOutput = {
      taskType: "meetup",
      meetupSuggestions: suggestions.filter(
        (s): s is MeetupSuggestion =>
          s !== null && typeof s === "object" &&
          (s as MeetupSuggestion).type === "detailed" &&
          typeof (s as MeetupSuggestion).connectionId === "string"
      ),
    };
  } else {
    state.executorOutput = {
      taskType: "connections",
      connectionSuggestions: suggestions.filter(
        (s): s is ConnectionSuggestion =>
          s !== null && typeof s === "object" &&
          typeof (s as ConnectionSuggestion).userId === "string" &&
          typeof (s as ConnectionSuggestion).reason === "string"
      ),
    };
  }

  const count = (state.executorOutput.meetupSuggestions ?? state.executorOutput.connectionSuggestions ?? []).length;
  const ms = Date.now() - t0;
  agentLog("executor", `Generated ${count} suggestions (${ms}ms)`);
  trace(state, "executor", "execution", `attempt ${state.attempts}`, `${count} suggestions`, ms, "completed", state.attempts);
}

// ─── Agent: Critic ────────────────────────────────────────────────────────────

async function criticAgent(state: SwarmState, onToken?: (delta: string) => void, emit?: SwarmEmit): Promise<void> {
  const t0 = Date.now();
  agentLog("critic", `Validating output (attempt ${state.attempts}/${state.maxAttempts})`);
  state.phase = "critique";

  const suggestions = state.executorOutput?.meetupSuggestions ?? state.executorOutput?.connectionSuggestions ?? [];
  if (suggestions.length === 0) {
    state.critiqueResult = {
      approved: true,
      feedback: state.emptyReason || "No suggestions generated.",
      issues: [],
    };
    trace(
      state,
      "critic",
      "critique",
      "0 suggestions",
      `APPROVED: ${state.emptyReason || "empty"}`,
      Date.now() - t0,
      "completed",
      state.attempts
    );
    return;
  }

  const validIds = new Set(state.research!.connections.map((c) => c.userId));
  const validVenues = new Set(state.research!.venues.map((v) => v.name.toLowerCase()));

  const sys = `You are the Critic agent — an adversarial validator for a social platform swarm.
Your job is to STRICTLY evaluate these ${state.taskType} suggestions.
Approve ONLY if ALL of the following are true:
1. At least 2 suggestions are present
2. Every suggestion references a valid connectionId from the validConnectionIds list
3. (For meetup) Every suggestion names a specific venue from the validVenueNames list
4. Suggestions reference specific shared interests or proximity — not generic reasons
5. Content is safe and appropriate
6. Suggestion text is written as an AI recommendation TO the user — never from the user's first-person perspective (reject "Let's", "We can", "We should", "I'll" phrasing)

Return ONLY valid JSON: {"approved":true/false,"feedback":"brief explanation","issues":["issue1",...]}`;

  const usr = JSON.stringify({
    suggestions,
    validConnectionIds: Array.from(validIds),
    validVenueNames: state.taskType === "meetup" ? Array.from(validVenues) : undefined,
    userInterests: state.research!.userProfile.interests,
  });

  try {
    const parsed = await llm(sys, usr, 512, onToken) as { approved?: boolean; feedback?: string; issues?: unknown[] };
    state.critiqueResult = {
      approved: parsed.approved === true,
      feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter((i): i is string => typeof i === "string") : [],
    };
  } catch {
    // Fail open: if critic errors, accept the output
    state.critiqueResult = { approved: true, feedback: "Critic unavailable; output accepted.", issues: [] };
  }

  // Azure AI Content Safety — second, independent safety gate. Only runs when
  // configured (endpoint + key); otherwise it no-ops. Builds a text blob from
  // the user-facing suggestion fields and rejects on any flagged harm category.
  if (isContentSafetyConfigured()) {
    const safetyText = (suggestions as Array<Record<string, unknown>>)
      .map((s) => [s.title, s.place, s.text, s.reason].filter((v): v is string => typeof v === "string").join(" . "))
      .join("\n");
    const safety = await analyzeTextSafety(safetyText);
    if (safety.checked) {
      const safetyMsg = `Azure AI Content Safety: ${safety.safe ? "passed ✓" : `FLAGGED ${safety.flagged.join(", ")}`} (maxSeverity=${safety.maxSeverity})`;
      agentLog("critic", safetyMsg);
      if (emit) emit({ type: "agent", agent: "critic", message: safetyMsg });
      if (!safety.safe && state.critiqueResult.approved) {
        state.critiqueResult = {
          approved: false,
          feedback: `Azure AI Content Safety flagged ${safety.flagged.join(", ")}; regenerate without unsafe content.`,
          issues: safety.flagged.map((c) => `content_safety_${c.toLowerCase()}`),
        };
      }
    }
  }

  const ms = Date.now() - t0;
  if (state.critiqueResult.approved) {
    agentLog("critic", `APPROVED (${ms}ms) — "${state.critiqueResult.feedback}"`);
    trace(state, "critic", "critique", `${suggestions.length} suggestions`, "APPROVED", ms, "approved", state.attempts);
  } else {
    agentLog("critic", `REJECTED (${ms}ms) — "${state.critiqueResult.feedback}" [${state.critiqueResult.issues.join(", ")}]`);
    trace(state, "critic", "critique", `${suggestions.length} suggestions`, `REJECTED: ${state.critiqueResult.feedback}`, ms, "rejected", state.attempts);
  }
}

// ─── Swarm Orchestrator ───────────────────────────────────────────────────────

export type SwarmParams = {
  userId: string;
  taskType: TaskType;
  supabase?: typeof defaultSupabase;
  foursquareApiKey: string;
  /** Optional realtime hooks: stream events and/or abort the run. */
  hooks?: SwarmHooks;
  /** When set, the researcher focuses on this specific accepted connection. */
  targetConnectionId?: string | null;
};

export async function runSwarm(params: SwarmParams): Promise<SwarmState> {
  const { userId, taskType, supabase = defaultSupabase, foursquareApiKey, hooks, targetConnectionId } = params;
  const runId = randomUUID();

  const emit: SwarmEmit = hooks?.emit ?? (() => {});
  const signal = hooks?.signal;
  // Forward only trace entries the caller hasn't seen yet.
  let traceCursor = 0;
  const flushTraces = (): void => {
    for (; traceCursor < state.trace.length; traceCursor++) {
      emit({ type: "trace", entry: state.trace[traceCursor]! });
    }
  };
  const checkAbort = (): void => {
    if (signal?.aborted) throw new SwarmAbortError();
  };
  // Live token streaming only when a UI is attached — keeps non-UI (prod) callers
  // on the original non-streaming code path.
  const mkToken = (agent: AgentName): ((delta: string) => void) | undefined =>
    hooks?.emit ? (delta) => emit({ type: "inference", agent, delta }) : undefined;

  const state: SwarmState = {
    runId,
    userId,
    taskType,
    phase: "planning",
    plan: null,
    research: null,
    executorOutput: null,
    critiqueResult: null,
    attempts: 0,
    maxAttempts: 3,
    humanApprovalRequired: false,
    humanApproved: null,
    humanFeedback: null,
    finalResult: null,
    trace: [],
    llmProvider: agentLLMClient.provider,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: null,
    targetConnectionId: targetConnectionId ?? null,
    emptyReason: null,
  };

  agentLog("planner", `=== SWARM START runId=${runId} task=${taskType} provider=${agentLLMClient.provider} ===`);

  try {
    // 1. Planner
    checkAbort();
    emit({ type: "agent_start", agent: "planner", phase: "planning" });
    const { data: preview } = await supabase
      .from("users")
      .select("first_name, bio, interests")
      .eq("id", userId)
      .single();

    await plannerAgent(state, {
      firstName: (preview?.first_name as string) ?? "User",
      bio: (preview?.bio as string | null) ?? null,
      interests: (preview?.interests as string[] | null) ?? [],
    }, mkToken("planner"));
    await saveState(state);
    emit({ type: "phase", phase: state.phase });
    flushTraces();

    // 2. Researcher
    checkAbort();
    emit({ type: "agent_start", agent: "researcher", phase: "research" });
    await researcherAgent(state, supabase, foursquareApiKey);
    await saveState(state);
    emit({ type: "phase", phase: state.phase });
    flushTraces();

    // 3. Executor → Critic adversarial loop
    while (state.attempts < state.maxAttempts) {
      checkAbort();
      emit({ type: "agent_start", agent: "executor", phase: "execution", attempt: state.attempts + 1 });
      await executorAgent(state, undefined, mkToken("executor"));
      flushTraces();

      checkAbort();
      emit({ type: "agent_start", agent: "critic", phase: "critique", attempt: state.attempts });
      await criticAgent(state, mkToken("critic"), emit);
      await saveState(state);
      emit({ type: "phase", phase: state.phase });
      flushTraces();

      if (state.critiqueResult?.approved) break;
    }

    if (!state.critiqueResult?.approved) {
      agentLog("critic", `Max attempts (${state.maxAttempts}) reached — flagging for human review`);
      state.humanApprovalRequired = true;
      state.phase = "awaiting_human";
      await saveState(state);
      emit({ type: "phase", phase: state.phase });
      emit({
        type: "result",
        taskType,
        result: state.executorOutput,
        approved: false,
        attempts: state.attempts,
        humanApprovalRequired: true,
        feedback: state.critiqueResult?.feedback ?? "",
      });
      return state;
    }

    // 4. Complete
    state.finalResult = state.executorOutput;
    state.phase = "complete";
    await saveState(state);
    agentLog("planner", `=== SWARM COMPLETE runId=${runId} ===`);
    emit({ type: "phase", phase: state.phase });
    emit({
      type: "result",
      taskType,
      result: state.finalResult,
      approved: true,
      attempts: state.attempts,
      humanApprovalRequired: false,
      feedback: state.critiqueResult?.feedback ?? "",
    });
  } catch (err) {
    if (err instanceof SwarmAbortError) {
      state.error = "aborted";
      state.phase = "error";
      await saveState(state).catch(() => {});
      agentLog("planner", `=== SWARM ABORTED runId=${runId} ===`);
      emit({ type: "aborted" });
      return state;
    }
    state.error = String(err);
    state.phase = "error";
    await saveState(state);
    agentLog("planner", `=== SWARM ERROR runId=${runId}: ${err} ===`);
    emit({ type: "error", message: String(err) });
  }

  return state;
}

export async function resumeSwarm(params: {
  runId: string;
  approved: boolean;
  feedback?: string;
  supabase?: typeof defaultSupabase;
  foursquareApiKey: string;
}): Promise<SwarmState> {
  const { runId, approved, feedback, supabase = defaultSupabase, foursquareApiKey } = params;

  const state = await loadSwarmState(runId);
  if (!state) throw new Error("Swarm run not found or expired");
  if (state.phase !== "awaiting_human") throw new Error("Swarm is not awaiting human approval");

  state.humanApproved = approved;
  state.humanFeedback = feedback ?? null;

  agentLog("planner", `Human ${approved ? "approved" : "rejected"} run ${runId}`);
  trace(state, "critic", "human_review", "awaiting approval", approved ? "HUMAN APPROVED" : `HUMAN REJECTED: ${feedback}`, 0, approved ? "approved" : "rejected");

  if (approved) {
    state.phase = "complete";
    state.finalResult = state.executorOutput;
  } else {
    // One more Executor+Critic pass incorporating human feedback
    state.maxAttempts += 1;
    await executorAgent(state, feedback);
    await criticAgent(state);
    state.phase = "complete";
    state.finalResult = state.executorOutput; // Accept result after human loop regardless of critic
  }

  await saveState(state);

  // Re-fetch foursquare if needed (unused here but kept for future expansion)
  void foursquareApiKey;
  void supabase;

  return state;
}
