import "dotenv/config";
import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";
import { config } from "../config.js";

const SYSTEM_PROMPT = `You are a turn classifier for a social discovery assistant. Given the user's message, output ONLY the turn classification in the following key:value format:
turnType: <type>
searchQuery: <query>  (only for search_places and search_events turns)

Valid turnType values:
- search_places: user wants to find a nearby venue, cafe, restaurant, park, or place
- search_events: user wants to find events, concerts, festivals, shows, or activities
- people_discovery: user wants to see nearby connections or find people with shared interests
- place_detail: user wants more information about a specific place already shown
- planning: user wants to plan or coordinate a meetup or outing with a connection
- general_chat: general conversation, advice, follow-up questions, or meta comments

Output ONLY the key:value lines. No explanation.`;

const LANGUAGES: Array<{ code: string; label: string; weight: number }> = [
  { code: "en", label: "English", weight: 40 },
  { code: "hi", label: "Hindi", weight: 15 },
  { code: "hi-en", label: "Hinglish (Hindi-English code-switch)", weight: 10 },
  { code: "bn", label: "Bengali", weight: 5 },
  { code: "es", label: "Spanish", weight: 5 },
  { code: "fr", label: "French", weight: 4 },
  { code: "ar", label: "Arabic", weight: 5 },
  { code: "ja", label: "Japanese", weight: 4 },
  { code: "pt", label: "Portuguese", weight: 4 },
  { code: "ru", label: "Russian", weight: 4 },
  { code: "zh-Hans", label: "Simplified Chinese", weight: 4 },
];

const TURN_TYPES = [
  "search_places",
  "search_events",
  "people_discovery",
  "place_detail",
  "planning",
  "general_chat",
] as const;

type TurnType = (typeof TURN_TYPES)[number];

const TARGET_COUNTS: Record<TurnType, number> = {
  search_places: 100,
  search_events: 90,
  people_discovery: 70,
  place_detail: 70,
  planning: 80,
  general_chat: 90,
};

const TARGET_TOTAL = Object.values(TARGET_COUNTS).reduce((a, b) => a + b, 0);

function weightedRandomLanguage(): string {
  const total = LANGUAGES.reduce((s, l) => s + l.weight, 0);
  let r = Math.random() * total;
  for (const lang of LANGUAGES) {
    r -= lang.weight;
    if (r <= 0) return lang.code;
  }
  return "en";
}

function pickTurnType(deficits: Record<string, number>): TurnType {
  const entries = TURN_TYPES.filter((t) => deficits[t] > 0);
  if (entries.length === 0) return "general_chat";
  entries.sort((a, b) => deficits[b] - deficits[a]);
  const top = entries.slice(0, 3);
  return top[Math.floor(Math.random() * top.length)];
}

interface ClassifyExample {
  messages: Array<{ role: string; content: string }>;
}

function loadExisting(filePath: string): ClassifyExample[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

async function generateBatch(
  client: OpenAI,
  deployment: string,
  turnType: TurnType,
  language: string,
  informal: boolean,
  count: number
): Promise<ClassifyExample[]> {
  const langLabel =
    language === "en"
      ? "English"
      : language === "hi-en"
      ? "Hinglish (mix of Hindi and English)"
      : LANGUAGES.find((l) => l.code === language)?.label ?? language;

  const styleNote = informal
    ? `Write ${count} VERY informal, casual, messy user messages. Use slang, abbreviations, typos, incomplete sentences, code-switching, short phrases, emoji-style text. Examples: "coffee?", "yaar kuch dikhao", "evnts this wknd?", "nah not that", "yo where food", "🎵 music?"`
    : `Write ${count} natural, clear user messages with varied phrasing. Some can be slightly casual but all should be grammatically parseable.`;

  const prompt = `Generate exactly ${count} diverse user messages for a social discovery assistant classifier.

Turn type: ${turnType}
User language: ${langLabel}
Style: ${styleNote}

For each message, provide the correct classification.

CRITICAL RULES:
- turnType is ALWAYS in English (it's a code key)
- searchQuery should be in the SAME language as the user message (extract the search intent naturally)
- For turnTypes other than search_places and search_events, do NOT include searchQuery
- Each example must be a JSON object with "messages" array: [system, user, assistant]

Return ONLY a JSON array of objects. No markdown fences, no explanation.

Example format for English search_places:
{"messages":[{"role":"system","content":"<SYSTEM_PROMPT>"},{"role":"user","content":"Find me a coffee shop"},{"role":"assistant","content":"turnType: search_places\\nsearchQuery: coffee shop"}]}

Example for Hindi search_events:
{"messages":[{"role":"system","content":"<SYSTEM_PROMPT>"},{"role":"user","content":"Delhi mein kya ho raha hai weekend pe?"},{"role":"assistant","content":"turnType: search_events\\nsearchQuery: events Delhi weekend"}]}`;

  const filledPrompt = prompt.replace("<SYSTEM_PROMPT>", SYSTEM_PROMPT);

  try {
    const res = await client.chat.completions.create({
      model: deployment,
      temperature: 0.9,
      max_tokens: 4096,
      messages: [{ role: "user", content: filledPrompt }],
    });

    const text = res.choices[0]?.message?.content ?? "[]";
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (ex: ClassifyExample) =>
        ex.messages &&
        ex.messages.length === 3 &&
        ex.messages.some((m) => m.content?.includes("turnType:"))
    );
  } catch (err) {
    console.error(`  Error generating batch (${turnType}, ${language}, informal=${informal}):`, err);
    return [];
  }
}

async function main() {
  if (!config.azureOpenAIEndpoint || !config.azureOpenAIKey) {
    console.error("AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY must be set in .env");
    process.exit(1);
  }

  const client = new OpenAI({
    apiKey: config.azureOpenAIKey,
    baseURL: config.azureOpenAIEndpoint,
  });
  const deployment = config.azureOpenAIDeployment;

  const existingPath = path.resolve("C:\\Users\\akash\\assistant-classify.jsonl");
  const outputPath = path.resolve("training/assistant-classify.jsonl");

  const existing = loadExisting(existingPath);
  console.log(`Loaded ${existing.length} existing examples`);

  const counts: Record<string, number> = {};
  for (const ex of existing) {
    const turnLine = ex.messages.find((m: { role: string; content: string }) =>
      m.content?.startsWith("turnType:")
    );
    if (turnLine) {
      const match = turnLine.content.match(/turnType:\s*(\w+)/);
      if (match) counts[match[1]] = (counts[match[1]] ?? 0) + 1;
    }
  }
  console.log("Existing distribution:", counts);

  const deficits: Record<string, number> = {};
  for (const tt of TURN_TYPES) {
    deficits[tt] = (TARGET_COUNTS[tt] ?? 50) - (counts[tt] ?? 0);
  }

  const allExamples: ClassifyExample[] = [...existing];
  const batchSize = 10;

  for (const turnType of TURN_TYPES) {
    const needed = deficits[turnType];
    if (needed <= 0) {
      console.log(`  ${turnType}: already at target, skipping`);
      continue;
    }

    console.log(`Generating ${needed} examples for ${turnType}...`);
    let generated = 0;

    while (generated < needed) {
      const batch = Math.min(batchSize, needed - generated);
      const language = weightedRandomLanguage();
      const informal = Math.random() < 0.3;

      const examples = await generateBatch(client, deployment, turnType, language, informal, batch);
      allExamples.push(...examples);
      generated += examples.length;

      console.log(
        `  +${examples.length} (${turnType}, lang=${language}, informal=${informal}) → total: ${allExamples.length}`
      );

      if (examples.length === 0) {
        console.log("  Empty batch, retrying with different params...");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const lines = allExamples.map((ex) => JSON.stringify(ex)).join("\n");
  fs.writeFileSync(outputPath, lines, "utf-8");

  const finalCounts: Record<string, number> = {};
  for (const ex of allExamples) {
    const turnLine = ex.messages.find((m: { role: string; content: string }) =>
      m.content?.startsWith("turnType:")
    );
    if (turnLine) {
      const match = turnLine.content.match(/turnType:\s*(\w+)/);
      if (match) finalCounts[match[1]] = (finalCounts[match[1]] ?? 0) + 1;
    }
  }

  console.log(`\nDone! Wrote ${allExamples.length} examples to ${outputPath}`);
  console.log("Final distribution:", finalCounts);
}

main().catch(console.error);
