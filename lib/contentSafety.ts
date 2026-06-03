import { config } from "../config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Azure AI Content Safety — text moderation gate used by the Critic agent.
//
// Calls the "Analyze Text" REST API and flags any harm category whose severity
// meets the threshold. It is a *configurable* gate: when the endpoint/key are
// not set it gracefully no-ops (checked=false, safe=true) so the swarm still
// runs. It also fails open on transient errors so a moderation-service outage
// never blocks a legitimate suggestion.
// ─────────────────────────────────────────────────────────────────────────────

export type ContentSafetyResult = {
  /** Whether the Azure service was actually invoked (false when unconfigured). */
  checked: boolean;
  /** True when no category met the severity threshold. */
  safe: boolean;
  /** Categories that met/exceeded the threshold. */
  flagged: string[];
  /** Highest severity returned (0–6 on the FourSeverityLevels scale). */
  maxSeverity: number;
};

const CATEGORIES = ["Hate", "SelfHarm", "Sexual", "Violence"] as const;
// FourSeverityLevels returns 0 | 2 | 4 | 6. 4 (“medium”) is a sensible block bar.
const SEVERITY_THRESHOLD = 4;
const API_VERSION = "2024-09-01";
const REQUEST_TIMEOUT_MS = 4000;
const MAX_TEXT_CHARS = 9000; // service limit is 10k

export function isContentSafetyConfigured(): boolean {
  return !!(config.azureContentSafetyEndpoint && config.azureContentSafetyKey);
}

export async function analyzeTextSafety(text: string): Promise<ContentSafetyResult> {
  const unchecked: ContentSafetyResult = { checked: false, safe: true, flagged: [], maxSeverity: 0 };
  if (!isContentSafetyConfigured() || !text.trim()) return unchecked;

  const base = config.azureContentSafetyEndpoint.replace(/\/+$/, "");
  const url = `${base}/contentsafety/text:analyze?api-version=${API_VERSION}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Ocp-Apim-Subscription-Key": config.azureContentSafetyKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: text.slice(0, MAX_TEXT_CHARS),
        categories: CATEGORIES,
        outputType: "FourSeverityLevels",
      }),
    });

    // Fail open on any non-200 — don't block the swarm on a moderation outage.
    if (!res.ok) return unchecked;

    const data = (await res.json()) as {
      categoriesAnalysis?: Array<{ category?: string; severity?: number }>;
    };
    const analysis = Array.isArray(data.categoriesAnalysis) ? data.categoriesAnalysis : [];
    const flagged = analysis
      .filter((a) => (a.severity ?? 0) >= SEVERITY_THRESHOLD && typeof a.category === "string")
      .map((a) => a.category as string);
    const maxSeverity = analysis.reduce((m, a) => Math.max(m, a.severity ?? 0), 0);
    return { checked: true, safe: flagged.length === 0, flagged, maxSeverity };
  } catch {
    return unchecked; // fail open
  } finally {
    clearTimeout(timer);
  }
}
