import { randomUUID } from "crypto";
import { supabase as defaultSupabase } from "./supabase.js";
import { redisGet, redisSet } from "./redis.js";
import { agentLLMClient } from "./azureClient.js";
import { searchNearbyPlaces } from "./foursquareClient.js";
import { cellToLatLngSafe } from "../shared/h3.js";

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
};

// ─── Terminal colors per agent (visual fidelity for demo logs) ────────────────

const COLORS: Record<AgentName, string> = {
  planner: "\x1b[36m",    // Cyan
  researcher: "\x1b[33m", // Yellow
  executor: "\x1b[32m",   // Green
  critic: "\x1b[31m",     // Red
};
const RESET = "\x1b[0m";

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

async function llm(systemPrompt: string, userPrompt: string, maxTokens = 2048): Promise<unknown> {
  const text = await agentLLMClient.complete({ systemPrompt, userPrompt, maxTokens });
  return JSON.parse(text);
}

// ─── Agent: Planner ──────────────────────────────────────────────────────────

async function plannerAgent(
  state: SwarmState,
  userProfile: { firstName: string; bio: string | null; interests: string[] }
): Promise<void> {
  const t0 = Date.now();
  agentLog("planner", `Decomposing task: ${state.taskType} for ${userProfile.firstName}`);
  state.phase = "planning";

  const sys = `You are the Orchestrator agent for a privacy-first social platform.
Decompose the user's request into concrete sub-tasks for a Researcher and Executor agent.
Return ONLY valid JSON: { "intent": "string", "tasks": [{ "id": "string", "description": "string", "priority": 1|2|3 }] }`;

  const usr = JSON.stringify({ taskType: state.taskType, user: userProfile });

  try {
    const parsed = await llm(sys, usr, 512) as { intent?: string; tasks?: unknown[] };
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

  const partnerIds = (connRows ?? []).map((r) =>
    r.requester_id === state.userId ? r.addressee_id : r.requester_id
  ) as string[];

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
          _score: score,
        };
      })
      .sort((a, b) => b._score - a._score)
      .slice(0, 5)
      .map(({ _score: _s, ...c }) => c);
  }

  // Nearby venues for meetup tasks
  let venues: ResearchData["venues"] = [];
  if (state.taskType === "meetup" && coords && foursquareApiKey) {
    try {
      const query = myInterests.slice(0, 2).join(" ") || "cafe restaurant";
      const places = await searchNearbyPlaces(foursquareApiKey, coords.lat, coords.lng, query, 5000);
      venues = places.slice(0, 8).map((p) => ({
        placeId: p.placeId,
        name: p.name,
        address: p.address,
        types: p.types ?? [],
        rating: p.rating ?? null,
      }));
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
  agentLog("researcher", `Research complete — ${connections.length} connections, ${venues.length} venues (${ms}ms)`);
  trace(state, "researcher", "research", `userId=${state.userId}`, `${connections.length} connections, ${venues.length} venues`, ms, "completed");
}

// ─── Agent: Executor ──────────────────────────────────────────────────────────

async function executorAgent(state: SwarmState, humanFeedback?: string): Promise<void> {
  const t0 = Date.now();
  state.attempts += 1;
  agentLog("executor", `Generating suggestions (attempt ${state.attempts}/${state.maxAttempts})`);
  state.phase = "execution";

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
Return ONLY valid JSON:
{"suggestions":[{"type":"detailed","connectionId":"<userId>","connectionName":"<firstName>","title":"<short title>","place":"<venue name>","time":"<specific time>","text":"<2-3 sentence description>"}]}
${priorCritique}${humanNote}`;

    userPromptData = {
      user: { firstName: research.userProfile.firstName, bio: research.userProfile.bio, interests: research.userProfile.interests },
      connections: research.connections.map((c) => ({ userId: c.userId, firstName: c.firstName, sharedInterests: c.sharedInterests, nearby: c.nearby, proximityCount: c.proximityCount })),
      venues: research.venues.map((v) => ({ name: v.name, address: v.address, types: v.types })),
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

  const parsed = await llm(systemPrompt, JSON.stringify(userPromptData)) as { suggestions?: unknown[] };
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

async function criticAgent(state: SwarmState): Promise<void> {
  const t0 = Date.now();
  agentLog("critic", `Validating output (attempt ${state.attempts}/${state.maxAttempts})`);
  state.phase = "critique";

  const suggestions = state.executorOutput?.meetupSuggestions ?? state.executorOutput?.connectionSuggestions ?? [];
  if (suggestions.length === 0) {
    state.critiqueResult = { approved: false, feedback: "No suggestions generated.", issues: ["empty_output"] };
    trace(state, "critic", "critique", "0 suggestions", "REJECTED: empty", Date.now() - t0, "rejected", state.attempts);
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

Return ONLY valid JSON: {"approved":true/false,"feedback":"brief explanation","issues":["issue1",...]}`;

  const usr = JSON.stringify({
    suggestions,
    validConnectionIds: Array.from(validIds),
    validVenueNames: state.taskType === "meetup" ? Array.from(validVenues) : undefined,
    userInterests: state.research!.userProfile.interests,
  });

  try {
    const parsed = await llm(sys, usr, 512) as { approved?: boolean; feedback?: string; issues?: unknown[] };
    state.critiqueResult = {
      approved: parsed.approved === true,
      feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter((i): i is string => typeof i === "string") : [],
    };
  } catch {
    // Fail open: if critic errors, accept the output
    state.critiqueResult = { approved: true, feedback: "Critic unavailable; output accepted.", issues: [] };
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
};

export async function runSwarm(params: SwarmParams): Promise<SwarmState> {
  const { userId, taskType, supabase = defaultSupabase, foursquareApiKey } = params;
  const runId = randomUUID();

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
  };

  agentLog("planner", `=== SWARM START runId=${runId} task=${taskType} provider=${agentLLMClient.provider} ===`);

  try {
    // 1. Planner
    const { data: preview } = await supabase
      .from("users")
      .select("first_name, bio, interests")
      .eq("id", userId)
      .single();

    await plannerAgent(state, {
      firstName: (preview?.first_name as string) ?? "User",
      bio: (preview?.bio as string | null) ?? null,
      interests: (preview?.interests as string[] | null) ?? [],
    });
    await saveState(state);

    // 2. Researcher
    await researcherAgent(state, supabase, foursquareApiKey);
    await saveState(state);

    // 3. Executor → Critic adversarial loop
    while (state.attempts < state.maxAttempts) {
      await executorAgent(state);
      await criticAgent(state);
      await saveState(state);

      if (state.critiqueResult?.approved) break;
    }

    if (!state.critiqueResult?.approved) {
      agentLog("critic", `Max attempts (${state.maxAttempts}) reached — flagging for human review`);
      state.humanApprovalRequired = true;
      state.phase = "awaiting_human";
      await saveState(state);
      return state;
    }

    // 4. Complete
    state.finalResult = state.executorOutput;
    state.phase = "complete";
    await saveState(state);
    agentLog("planner", `=== SWARM COMPLETE runId=${runId} ===`);
  } catch (err) {
    state.error = String(err);
    state.phase = "error";
    await saveState(state);
    agentLog("planner", `=== SWARM ERROR runId=${runId}: ${err} ===`);
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
