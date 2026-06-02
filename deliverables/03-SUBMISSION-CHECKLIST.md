# Submission Checklist — Lokaal

Tracks the three submission pillars: **GitHub repo**, **slide deck**, **demo video**.

---

## 1. GitHub Repository (public)

| Requirement | Status | Where |
|---|---|---|
| Project Title & Description | ✅ | [`../README.md`](../README.md) top |
| Architecture Diagram | ✅ | `../README.md` (Mermaid, GitHub-rendered) + deck export |
| Agent Constitution (Rules of Engagement) | ✅ | [`../agents.md`](../agents.md) + README summary |
| Setup: `### Prerequisites / Installation / Running the Swarm` | ✅ | `../README.md` → Setup |
| AI Tools Disclosed (every Microsoft service) | ✅ | `../README.md` → AI Tools Disclosed |
| `.env.example` (no real keys committed) | ✅ | [`../.env.example`](../.env.example) |
| Team Roles | ✅ | `../README.md` → Team Roles |
| Repo is public + secrets not committed | ⬜ | _verify `.env` is gitignored before pushing_ |

## 2. Project Deck (PDF, ≤ 10 slides)

| Slide | Content | Status |
|---|---|---|
| 1 Title | Name, tagline, solo-builder details | ⬜ generate (fill name/role/contact) |
| 2 Problem | Before vs After | ⬜ |
| 3 Solution | One-sentence value prop | ⬜ |
| 4 System Architecture | Mermaid diagram #1 | ⬜ |
| 5 Agent Swarm Design | Diagram #2 + handoff + SwarmState | ⬜ |
| 6 AI Integration | Azure Foundry / Redis / Content Safety | ⬜ |
| 7 Scalability & Security | stateless + data-minimization | ⬜ |
| 8 Demo Screenshots | real validated run + log screenshot | ⬜ |
| 9 Future Roadmap | AKS, streaming traces, Memory agent | ⬜ |
| 10 Conclusion + CTA | recap + punchy CTA | ⬜ |

→ Generate from [`01-SLIDE-DECK-PROMPT.md`](01-SLIDE-DECK-PROMPT.md); export PDF into this folder.

## 3. Demo Video (≤ 3 min, unlisted YouTube)

| Segment | Status |
|---|---|
| 0:00–0:30 Hook | ⬜ |
| 0:30–2:00 Action (live agent logs) | ⬜ |
| 2:00–2:30 Architecture | ⬜ |
| 2:30–3:00 Impact | ⬜ |
| Uploaded unlisted + link in README | ⬜ |

→ Record from [`02-DEMO-VIDEO-GUIDE.md`](02-DEMO-VIDEO-GUIDE.md).

---

## Validation status of the dev (verified live, this build)
- ✅ API image rebuilt with swarm + midpoint code; `tsc` clean in-container
- ✅ Full Docker stack healthy (api, 3 workers, rabbitmq, n8n, scraper, nginx)
- ✅ `/swarm/status` → `provider: azure`, `Llama-3.3-70B-Instruct`
- ✅ `/swarm/meetup` end-to-end: 4 agents, **midpoint-grounded** venues, Critic approved
- ✅ `/swarm/connections` via nginx gateway → 200 + full trace
- ✅ n8n reachable (`:5678/healthz` → 200)

## Pre-push reminders
1. Confirm `.env` is in `.gitignore` (it is in `.dockerignore`; verify git too).
2. Fill the 3 Slide-1 placeholders in the slide prompt.
3. Make the GitHub repo public.
4. _(Optional)_ Update `n8n-workflows/README.md` — "Groq" node names are post-migration misnomers.
