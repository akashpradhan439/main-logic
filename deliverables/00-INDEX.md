# Lokaal — Submission Deliverables

**Microsoft Build AI Hackathon · Agent Swarm category**

This folder consolidates every submission artifact for Lokaal — a privacy-first proximity network planned by a 4-agent AI swarm (Planner → Researcher → Executor → Critic) on Azure AI Foundry.

---

## Deliverables

| # | Deliverable | Location | Status |
|---|---|---|---|
| 1 | **GitHub README** (user manual) | [`../README.md`](../README.md) | ✅ Ready |
| 2 | **Agent Constitution** (Rules of Engagement) | [`../agents.md`](../agents.md) | ✅ Ready |
| 3 | **Environment template** (no secrets) | [`../.env.example`](../.env.example) | ✅ Ready |
| 4 | **Slide-deck prompt** (hand to a slide AI agent) | [`01-SLIDE-DECK-PROMPT.md`](01-SLIDE-DECK-PROMPT.md) | ✅ Ready |
| 5 | **Demo-video recording guide** (≤3 min) | [`02-DEMO-VIDEO-GUIDE.md`](02-DEMO-VIDEO-GUIDE.md) | ✅ Ready |
| 6 | **Submission checklist** (repo + deck + video) | [`03-SUBMISSION-CHECKLIST.md`](03-SUBMISSION-CHECKLIST.md) | ✅ Ready |
| 7 | Project deck (PDF, ≤10 slides) | _generate from #4, then drop the PDF here_ | ⬜ To do |
| 8 | Demo video (unlisted YouTube link) | _record from #5, then add link here_ | ⬜ To do |

> Items 1–3 live at the repo root because GitHub conventions and `cp .env.example .env` require them there. This folder links to them as the single source of truth (no duplicate copies → no drift).

---

## The 30-second pitch

Single-model AI gives you a confident answer you can't verify, audit, or trust. Lokaal's **4-agent swarm** refuses to surface a meetup suggestion until a Planner, a Researcher, an Executor, and an adversarial Critic agree it is **grounded in real data**, **safe**, and **specific** — with a human able to step in, and every step fully traceable.

## Tech at a glance
- **Azure AI Foundry** — Llama-3.3-70B-Instruct (all 4 agents + assistant; Azure-only)
- **Upstash (managed Redis)** — the swarm "blackboard" (shared `SwarmState`)
- **Azure AI Content Safety** — Critic safety gate (activates when configured)
- Custom TypeScript orchestration (Semantic-Kernel-inspired handoffs) · Fastify 5 · Supabase · Foursquare · Uber H3 · RabbitMQ · fully Dockerized

## Remaining to-dos before submission
1. Generate the PDF deck from the prompt (#4) and place it here.
2. Record + upload the unlisted demo video (#5) and add the link here.
3. Fill the 3 Slide-1 placeholders (name/role/contact) in the slide prompt.
4. _(Optional cleanup)_ `n8n-workflows/README.md` still describes "Groq" nodes — these are misnomers post-Azure-migration; update if a judge will read it.
