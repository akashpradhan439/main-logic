import Groq from "groq-sdk";
import { config } from "../config.js";

const groq = new Groq({ apiKey: config.groqApiKey });

const GROQ_MODEL = "llama-3.3-70b-versatile";

export type SuggestionCandidate = {
  userId: string;
  firstName: string;
  bio: string | null;
  interests: string[];
  signals: {
    isNearby: boolean;
    proximityCount: number;
    mutualConnections: number;
    sharedInterests: string[];
  };
};

export type SuggestionResult = {
  userId: string;
  reason: string;
};

const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  ar: "Arabic",
  bn: "Bangla (Bengali)",
  es: "Spanish",
  fr: "French",
  hi: "Hindi",
  ja: "Japanese",
  pt: "Portuguese",
  ru: "Russian",
  "zh-Hans": "Simplified Chinese",
  "zh-Hant": "Traditional Chinese",
};

function languageLabel(code: string | null | undefined): string {
  if (!code) return "English";
  return LANGUAGE_LABELS[code] ?? "English";
}

function languageInstruction(code: string | null | undefined): string {
  const label = languageLabel(code);
  if (label === "English") {
    return "Write every user-facing text field in English.";
  }
  return `Write every user-facing text field in ${label}. JSON keys and identifiers MUST stay in English; only the human-readable text values are translated.`;
}

function buildConnectionsSystemPrompt(languageCode: string | null | undefined): string {
  return `You are a connection suggestion assistant for a location-based privacy-focused social app.
Rank the candidates and provide a brief friendly reason (1-2 sentences) for each.
Base reasoning on: shared interests, location overlap, mutual connections.
${languageInstruction(languageCode)}
Return ONLY a valid JSON object with this exact shape: {"suggestions":[{"userId":"...","reason":"..."}]}
Sort by best match first. Omit candidates with no meaningful signals.
Do not include markdown, code fences, or any text outside the JSON object.`;
}

function fallbackReasons(candidates: SuggestionCandidate[]): SuggestionResult[] {
  return candidates.map((c) => {
    const parts: string[] = [];
    if (c.signals.sharedInterests.length > 0) {
      parts.push(`You both like ${c.signals.sharedInterests.slice(0, 2).join(" and ")}.`);
    }
    if (c.signals.mutualConnections > 0) {
      parts.push(
        `You have ${c.signals.mutualConnections} mutual connection${c.signals.mutualConnections === 1 ? "" : "s"}.`
      );
    }
    if (c.signals.isNearby || c.signals.proximityCount > 0) {
      parts.push("You've been in the same area recently.");
    }
    return {
      userId: c.userId,
      reason: parts.length > 0 ? parts.join(" ") : "Suggested based on activity nearby.",
    };
  });
}

function buildInterestsSystemPrompt(languageCode: string | null | undefined): string {
  return `You are a helpful assistant for a social app.
Given a user's bio, suggest 5 to 10 relevant personal interests.
${languageInstruction(languageCode)}
Return ONLY a valid JSON object with this exact shape: {"interests":["interest1","interest2",...]}
Each interest should be a short lowercase word or phrase (1-3 words). Be specific and personal.
Do not include markdown, code fences, or any text outside the JSON object.`;
}

export async function suggestInterests(bio: string, languageCode?: string | null): Promise<string[]> {
  if (!config.groqApiKey) return [];

  try {
    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      max_tokens: 256,
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildInterestsSystemPrompt(languageCode) },
        { role: "user", content: bio },
      ],
    });

    const text = completion.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(text) as unknown;

    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { interests?: unknown }).interests)
    ) {
      return ((parsed as { interests: unknown[] }).interests)
        .filter((i): i is string => typeof i === "string")
        .map((i) => i.trim())
        .filter((i) => i.length > 0)
        .slice(0, 10);
    }

    return [];
  } catch {
    return [];
  }
}

export async function suggestConnections(
  currentUser: { bio: string | null; interests: string[] },
  candidates: SuggestionCandidate[],
  languageCode?: string | null
): Promise<SuggestionResult[]> {
  if (candidates.length === 0) return [];

  if (!config.groqApiKey) {
    return fallbackReasons(candidates);
  }

  try {
    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      max_tokens: 1024,
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildConnectionsSystemPrompt(languageCode) },
        {
          role: "user",
          content: JSON.stringify({ currentUser, candidates }),
        },
      ],
    });

    const text = completion.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(text) as unknown;

    let arr: unknown;
    if (Array.isArray(parsed)) {
      arr = parsed;
    } else if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { suggestions?: unknown }).suggestions)
    ) {
      arr = (parsed as { suggestions: unknown[] }).suggestions;
    } else {
      return fallbackReasons(candidates);
    }

    const validIds = new Set(candidates.map((c) => c.userId));
    const cleaned: SuggestionResult[] = [];
    for (const item of arr as unknown[]) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as { userId?: unknown }).userId === "string" &&
        typeof (item as { reason?: unknown }).reason === "string" &&
        validIds.has((item as { userId: string }).userId)
      ) {
        cleaned.push({
          userId: (item as { userId: string }).userId,
          reason: (item as { reason: string }).reason,
        });
      }
    }

    return cleaned.length > 0 ? cleaned : fallbackReasons(candidates);
  } catch {
    return fallbackReasons(candidates);
  }
}
