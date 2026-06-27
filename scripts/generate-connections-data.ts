import "dotenv/config";
import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { config } from "../config.js";

const EXECUTOR_SYSTEM_PROMPT = `You are the Executor agent for a privacy-first social platform.
Generate connection suggestions with a specific 1–2 sentence reason for each.
Each reason MUST reference shared interests, mutual proximity, or connection signals.

Return each suggestion as a separate pipe-delimited line. Header line first:
userId|reason

Then one line per suggestion, e.g.:
abc123|You both like hiking and live in the same neighborhood.

Do NOT include JSON, markdown fences, or any text outside this pipe-delimited format.`;

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

interface CsvUser {
  user_id: string;
  user_interests: string[];
  user_name: string;
  connections: Array<{
    name: string;
    interests: string[];
    sharedInterests: string[] | null;
    status: string;
  }>;
}

interface ConnectionsExample {
  messages: Array<{ role: string; content: string }>;
}

function deterministicUuid(name: string): string {
  const hash = crypto.createHash("sha256").update(name).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    "4" + hash.slice(13, 16),
    ((parseInt(hash[16], 16) & 3) | 8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join("-");
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function parseCsv(csvContent: string): CsvUser[] {
  const lines = csvContent.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];

  const users: CsvUser[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 4) continue;

    const userId = fields[0].trim();
    let interests: string[];
    try {
      interests = JSON.parse(fields[1].trim());
    } catch {
      continue;
    }
    const name = fields[2].trim();
    let connections: CsvUser["connections"];
    try {
      connections = JSON.parse(fields[3].trim());
    } catch {
      continue;
    }

    users.push({
      user_id: userId,
      user_interests: interests,
      user_name: name,
      connections: connections.filter((c) => c.status === "accepted"),
    });
  }
  return users;
}

function weightedRandomLanguage(): string {
  const total = LANGUAGES.reduce((s, l) => s + l.weight, 0);
  let r = Math.random() * total;
  for (const lang of LANGUAGES) {
    r -= lang.weight;
    if (r <= 0) return lang.code;
  }
  return "en";
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickCandidateSubset(
  connections: CsvUser["connections"],
  count: number
): CsvUser["connections"] {
  const shuffled = shuffle(connections);
  const subset = shuffled.slice(0, Math.min(count, shuffled.length));
  return subset.map((c) => ({
    ...c,
    sharedInterests:
      c.sharedInterests && c.sharedInterests.length > 0
        ? c.sharedInterests
        : null,
  }));
}

async function generateExample(
  client: OpenAI,
  deployment: string,
  user: CsvUser,
  candidateCount: number,
  language: string
): Promise<ConnectionsExample | null> {
  const candidates = pickCandidateSubset(user.connections, candidateCount);
  if (candidates.length === 0) return null;

  const langLabel =
    language === "en"
      ? "English"
      : language === "hi-en"
      ? "Hinglish (mix of Hindi and English)"
      : LANGUAGES.find((l) => l.code === language)?.label ?? language;

  const userPrompt = JSON.stringify({
    user: {
      bio: null,
      interests: user.user_interests,
    },
    candidates: candidates.map((c) => ({
      userId: deterministicUuid(c.name),
      firstName: c.name.split(" ")[0],
      sharedInterests:
        c.sharedInterests && c.sharedInterests.length > 0
          ? c.sharedInterests
          : null,
      nearby: Math.random() > 0.5,
      proximityCount: Math.floor(Math.random() * 8),
    })),
  });

  let systemPrompt = EXECUTOR_SYSTEM_PROMPT;
  if (language !== "en") {
    systemPrompt += `\n\nLANGUAGE: Write every human-readable text field (the reason) in ${langLabel}. Keep userId values unchanged.`;
  }

  try {
    const res = await client.chat.completions.create({
      model: deployment,
      temperature: 0.8,
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const text = res.choices[0]?.message?.content ?? "";
    if (!text.includes("|")) return null;

    const lines = text.split("\n").filter((l) => l.includes("|"));
    if (lines.length === 0) return null;

    const validUuids = candidates.map((c) => deterministicUuid(c.name));
    const validLines = lines.filter((l) => {
      const uuid = l.split("|")[0]?.trim();
      return validUuids.includes(uuid);
    });

    if (validLines.length === 0) return null;

    return {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
        { role: "assistant", content: validLines.join("\n") },
      ],
    };
  } catch (err) {
    console.error(`  Error generating for ${user.user_name}:`, err);
    return null;
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

  const csvPath = path.resolve(
    "C:\\Users\\akash\\Downloads\\Supabase Snippet Untitled query.csv"
  );
  const outputPath = path.resolve("training/executor-connections.jsonl");

  const csvContent = fs.readFileSync(csvPath, "utf-8");
  const users = parseCsv(csvContent);
  console.log(`Parsed ${users.length} users from CSV`);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // Resume from existing file
  let allExamples: ConnectionsExample[] = [];
  let processedUserNames = new Set<string>();
  if (fs.existsSync(outputPath)) {
    const existing = fs.readFileSync(outputPath, "utf-8").split("\n").filter(Boolean);
    for (const line of existing) {
      try {
        allExamples.push(JSON.parse(line));
      } catch { /* skip malformed */ }
    }
    // Mark users we already processed by checking firstName in assistant content
    console.log(`Resuming with ${allExamples.length} existing examples`);
  }

  const targetPerUser = 10;
  const writeStream = fs.createWriteStream(outputPath, { flags: "a" });

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    const existingForUser = allExamples.filter((ex) => {
      const sysMsg = ex.messages.find((m) => m.role === "system")?.content ?? "";
      const userMsg = ex.messages.find((m) => m.role === "user")?.content ?? "";
      return userMsg.includes(user.user_name.split(" ")[0]);
    }).length;

    if (existingForUser >= targetPerUser) {
      console.log(
        `[${i + 1}/${users.length}] ${user.user_name}: already have ${existingForUser} examples, skipping`
      );
      continue;
    }

    console.log(
      `[${i + 1}/${users.length}] ${user.user_name} (${user.connections.length} connections, ${existingForUser} existing)`
    );

    let generated = 0;
    let attempts = 0;
    const maxAttempts = targetPerUser * 3;
    const needed = targetPerUser - existingForUser;

    while (generated < needed && attempts < maxAttempts) {
      attempts++;
      const candidateCount = 3 + Math.floor(Math.random() * 6);
      const language = weightedRandomLanguage();

      const example = await generateExample(
        client,
        deployment,
        user,
        candidateCount,
        language
      );

      if (example) {
        allExamples.push(example);
        generated++;
        writeStream.write(JSON.stringify(example) + "\n");
        console.log(
          `  +1 (candidates=${candidateCount}, lang=${language}) → total: ${allExamples.length}`
        );
      }
    }
  }

  writeStream.end();

  const langCounts: Record<string, number> = {};
  for (const ex of allExamples) {
    const sysMsg = ex.messages.find((m) => m.role === "system")?.content ?? "";
    let lang = "en";
    if (sysMsg.includes("Hindi")) lang = "hi";
    else if (sysMsg.includes("Hinglish")) lang = "hi-en";
    else if (sysMsg.includes("Bengali")) lang = "bn";
    else if (sysMsg.includes("Spanish")) lang = "es";
    else if (sysMsg.includes("French")) lang = "fr";
    else if (sysMsg.includes("Arabic")) lang = "ar";
    else if (sysMsg.includes("Japanese")) lang = "ja";
    else if (sysMsg.includes("Portuguese")) lang = "pt";
    else if (sysMsg.includes("Russian")) lang = "ru";
    else if (sysMsg.includes("Chinese")) lang = "zh";
    langCounts[lang] = (langCounts[lang] ?? 0) + 1;
  }

  console.log(`\nDone! Wrote ${allExamples.length} examples to ${outputPath}`);
  console.log("Language distribution:", langCounts);
}

main().catch(console.error);
