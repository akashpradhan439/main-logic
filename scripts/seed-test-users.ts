/**
 * Seeds 100 test users with bios, interests, H3 cells, plus a social graph
 * (accepted + pending connections) and proximity notifications so the AI
 * suggestions feature can be exercised end-to-end.
 *
 * Run with:  npx tsx scripts/seed-test-users.ts
 *
 * Idempotent-ish: uses ON CONFLICT-equivalent by skipping pairs already seen.
 * Safe to re-run, but inserts are NOT deduplicated against pre-existing rows
 * in the DB. Run on a fresh-ish dataset.
 */

import dotenv from "dotenv";
dotenv.config();

import { randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Seed data pools ─────────────────────────────────────────────────────────

const FIRST_NAMES = [
  "Priya", "Rohan", "Maya", "Arjun", "Ananya", "Vikram", "Diya",
  "Karthik", "Riya", "Aditya", "Ishita", "Aryan", "Aditi", "Rahul", "Pooja",
  "Siddharth", "Tanvi", "Nikhil", "Sneha", "Rohit", "Kavya", "Manish",
  "Lakshmi", "Sameer", "Neha", "Varun", "Anjali", "Harsh", "Meera",
  "Ishaan", "Aisha", "Yash", "Saanvi", "Vivaan", "Reyansh", "Krishna",
  "Devansh", "Atharv", "Shaurya", "Kabir", "Advik", "Aarush", "Aarav",
  "Avani", "Anika", "Tara", "Naina", "Mira", "Kiara",
];

const LAST_NAMES = [
  "Sharma", "Singh", "Patel", "Kumar", "Reddy", "Iyer", "Menon",
  "Nair", "Kapoor", "Mehta", "Joshi", "Verma", "Gupta", "Rao", "Bose",
  "Das", "Roy", "Bhat", "Pillai", "Shah", "Aggarwal", "Bansal", "Chopra",
  "Desai", "Goyal", "Hegde", "Khanna", "Malhotra", "Saxena",
];

const INTERESTS = [
  "coffee", "hiking", "photography", "music", "gaming", "coding", "reading",
  "cooking", "travel", "art", "yoga", "running", "climbing", "cycling",
  "swimming", "painting", "writing", "movies", "anime", "fitness",
  "meditation", "dancing", "baking", "basketball", "football", "tennis",
  "chess", "podcasts", "gardening", "singing",
];

const BIOS = [
  "Software engineer who loves hiking on weekends.",
  "Coffee + code + climbing.",
  "Trail runner and amateur photographer.",
  "Designer by day, gamer by night.",
  "Yoga instructor exploring the city one cafe at a time.",
  "Backend dev, board-game enthusiast, dog person.",
  "Mountains over beaches, books over Netflix.",
  "Curating playlists and chasing sunsets.",
  "Founder of a small coffee roastery. Always learning.",
  "Painter, traveller, occasional musician.",
  "Cycling 5km/day. Pasta 5 days/week.",
  "Frontend dev with a soft spot for typography.",
  "Long walks, good food, deep conversations.",
  "Anime fan and chess club regular.",
  "Marathoner in training. Vegetarian foodie.",
  "Bookworm and amateur baker.",
  "Curious about everything. Currently learning Spanish.",
  "Photographer, traveler, tea drinker.",
  "Climbing gym 4x a week. Bouldering at V5.",
  "Open-source contributor and movie buff.",
  "Singer-songwriter and weekend gardener.",
  "Football on Sundays, podcasts the rest of the week.",
  "Working on a startup. Always up for coffee.",
  "Cooking new recipes and exploring street food.",
  "Plant parent. Currently at 23 and counting.",
  "Tennis player and amateur sommelier.",
  "Wandering writer. Notebooks > screens.",
  "Meditation, mountains, minimalism.",
  "Coffee snob, coding bootcamp graduate.",
  "Dance teacher and amateur DJ.",
];

// 5 H3 res-4-shaped cell IDs to form proximity clusters. These are placeholders
// — they only need to be unique strings since the AI route does string matching
// only. Real H3 IDs would come from production h3-js calls.
const CELLS = [
  "8428309ffffff01",
  "8428309ffffff02",
  "8428309ffffff03",
  "8428309ffffff04",
  "8428309ffffff05",
];

const PASSWORD_HASH = "$2b$10$seedSeedSeedSeedSeedSeedSeedSeedSeedSeedSeedSeedSe"; // dummy
const PHONE_BASE = 9000000000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rand(n: number) {
  return Math.floor(Math.random() * n);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function canonicalPair(a: string, b: string): { requester: string; addressee: string } {
  return a < b ? { requester: a, addressee: b } : { requester: b, addressee: a };
}

function randomDob(): string {
  const year = 1985 + rand(20); // 1985..2004
  const month = 1 + rand(12);
  const day = 1 + rand(28);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ─── Generators ──────────────────────────────────────────────────────────────

type SeedUser = {
  id: string;
  country_code: string;
  phone_number: number;
  password_hash: string;
  dob: string;
  first_name: string;
  last_name: string;
  bio: string;
  interests: string[];
  h3_cell: string;
  h3_neighbors: string[];
};

function generateUsers(count: number): SeedUser[] {
  const users: SeedUser[] = [];
  for (let i = 0; i < count; i++) {
    const firstName = FIRST_NAMES[i % FIRST_NAMES.length];
    const lastName = LAST_NAMES[(i * 7) % LAST_NAMES.length];
    const cell = CELLS[i % CELLS.length];
    const neighbors = CELLS.filter((c) => c !== cell);
    const interestCount = 3 + rand(5); // 3-7
    const interests = shuffle(INTERESTS).slice(0, interestCount);
    const bio = BIOS[i % BIOS.length];
    users.push({
      id: randomUUID(),
      country_code: "IN",
      phone_number: PHONE_BASE + i,
      password_hash: PASSWORD_HASH,
      dob: randomDob(),
      first_name: firstName,
      last_name: lastName,
      bio,
      interests,
      h3_cell: cell,
      h3_neighbors: neighbors,
    });
  }
  return users;
}

type ConnectionRow = {
  requester_id: string;
  addressee_id: string;
  status: "accepted" | "pending";
};

function generateConnections(users: SeedUser[]): ConnectionRow[] {
  const rows: ConnectionRow[] = [];
  const seen = new Set<string>();
  const targetAcceptedPerUser = 6;
  const targetPendingPerUser = 1;

  // Bias toward intra-cluster edges (70%) with some cross-cluster (30%).
  const cellGroups = new Map<string, SeedUser[]>();
  for (const u of users) {
    if (!cellGroups.has(u.h3_cell)) cellGroups.set(u.h3_cell, []);
    cellGroups.get(u.h3_cell)!.push(u);
  }

  function tryAdd(a: SeedUser, b: SeedUser, status: "accepted" | "pending") {
    if (a.id === b.id) return false;
    const { requester, addressee } = canonicalPair(a.id, b.id);
    const key = `${requester}|${addressee}`;
    if (seen.has(key)) return false;
    seen.add(key);
    rows.push({ requester_id: requester, addressee_id: addressee, status });
    return true;
  }

  for (const user of users) {
    let accepted = 0;
    let pending = 0;
    let attempts = 0;
    const sameCluster = cellGroups.get(user.h3_cell)!;

    while (accepted < targetAcceptedPerUser && attempts < 40) {
      attempts++;
      const useSame = Math.random() < 0.7;
      const pool = useSame ? sameCluster : users;
      const partner = pool[rand(pool.length)];
      if (tryAdd(user, partner, "accepted")) accepted++;
    }

    attempts = 0;
    while (pending < targetPendingPerUser && attempts < 20) {
      attempts++;
      const partner = users[rand(users.length)];
      if (tryAdd(user, partner, "pending")) pending++;
    }
  }

  return rows;
}

type NotificationRow = {
  user_a_id: string;
  user_b_id: string;
  initiator_id: string;
  overlap_hex: string;
  notification_type: string;
};

function generateNotifications(users: SeedUser[]): NotificationRow[] {
  const rows: NotificationRow[] = [];
  const cellGroups = new Map<string, SeedUser[]>();
  for (const u of users) {
    if (!cellGroups.has(u.h3_cell)) cellGroups.set(u.h3_cell, []);
    cellGroups.get(u.h3_cell)!.push(u);
  }

  for (const [cell, group] of cellGroups) {
    // For each cluster, generate ~30 random co-occurrence events
    for (let i = 0; i < 30; i++) {
      const a = group[rand(group.length)];
      const b = group[rand(group.length)];
      if (a.id === b.id) continue;
      const { requester: userA, addressee: userB } = canonicalPair(a.id, b.id);
      rows.push({
        user_a_id: userA,
        user_b_id: userB,
        initiator_id: Math.random() < 0.5 ? userA : userB,
        overlap_hex: cell,
        notification_type: "hex_overlap",
      });
    }
  }

  return rows;
}

// ─── Insertion (batched) ─────────────────────────────────────────────────────

async function insertInBatches<T>(table: string, rows: T[], batchSize = 50) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from(table).insert(batch as any);
    if (error) {
      console.error(`Failed to insert into ${table} (batch starting ${i}):`, error);
      throw error;
    }
    console.log(`  inserted ${Math.min(i + batchSize, rows.length)}/${rows.length} into ${table}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Generating seed data...");
  const users = generateUsers(100);
  const connections = generateConnections(users);
  const notifications = generateNotifications(users);

  console.log(`Users: ${users.length}`);
  console.log(`Connections: ${connections.length} (accepted: ${connections.filter(c => c.status === "accepted").length}, pending: ${connections.filter(c => c.status === "pending").length})`);
  console.log(`Notifications: ${notifications.length}`);

  console.log("\nInserting users...");
  await insertInBatches("users", users, 50);

  console.log("\nInserting connections...");
  await insertInBatches("connections", connections, 100);

  console.log("\nInserting notifications...");
  await insertInBatches("notifications", notifications, 100);

  console.log("\n✓ Seed complete.");
  console.log("\nSample user IDs (first 5):");
  for (const u of users.slice(0, 5)) {
    console.log(`  ${u.id}  ${u.first_name} ${u.last_name}  [${u.h3_cell}]`);
  }
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
