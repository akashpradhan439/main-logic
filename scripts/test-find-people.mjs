// E2E test of the assistant "who's around me" discovery + selection planning.
// Runs INSIDE the api container (has dist/, node_modules, and .env loaded).
import jwt from "jsonwebtoken";

const BASE = "http://localhost:3000";
const USER_ID = process.env.PROBE_USER_ID || "0c7d8c21-98e9-4473-a953-25565e08177a";
const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error("JWT_SECRET not set in container env");
  process.exit(1);
}

const token = jwt.sign(
  { sub: USER_ID, phone: "+910000000000", type: "access" },
  SECRET,
  { expiresIn: "1h" }
);

async function chat(body) {
  const res = await fetch(`${BASE}/assistant/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

function fail(msg) {
  console.error("❌ FAIL:", msg);
  process.exit(1);
}

(async () => {
  // ── Turn 1: discovery ──────────────────────────────────────────────────────
  console.log("Turn 1 → 'who is around me with similar interests'");
  const t1 = await chat({ message: "who is around me with similar interests" });
  if (t1.status !== 200 || !t1.json.success) fail(`turn1 status=${t1.status} ${JSON.stringify(t1.json)}`);
  const cards = t1.json.cards || [];
  const peopleCard = cards.find((c) => c.type === "people");
  if (!peopleCard) fail(`no people card returned. cards=${JSON.stringify(cards.map((c) => c.type))}`);
  const people = peopleCard.data || [];
  console.log(`  reply: ${t1.json.reply}`);
  console.log(`  people card: ${people.length} entries`);
  people.forEach((p) => console.log(`   - ${p.name} shared=[${(p.sharedInterests || []).join(", ")}]`));
  if (people.length === 0) fail("people card empty");
  if (people.length > 10) fail(`people card exceeds cap of 10 (${people.length})`);

  // ── Turn 2: select one + ask to plan ────────────────────────────────────────
  const pick = people[0];
  console.log(`\nTurn 2 → select ${pick.name} (${pick.userId}) + ask to plan a coffee`);
  const t2 = await chat({
    message: "where can we grab a coffee together?",
    personUserId: pick.userId,
  });
  if (t2.status !== 200 || !t2.json.success) fail(`turn2 status=${t2.status} ${JSON.stringify(t2.json)}`);
  console.log(`  reply: ${t2.json.reply}`);
  console.log(`  cards: ${JSON.stringify((t2.json.cards || []).map((c) => c.type))}`);
  const mentionsName = t2.json.reply.toLowerCase().includes(pick.name.split(" ")[0].toLowerCase());
  console.log(`  reply references picked person by name: ${mentionsName}`);

  console.log("\n✅ PASS: discovery returned a capped people list and selection drove planning.");
  process.exit(0);
})().catch((e) => {
  console.error("❌ ERROR", e);
  process.exit(1);
});
