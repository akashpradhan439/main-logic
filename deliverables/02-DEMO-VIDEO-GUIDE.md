# 🎬 Demo Video Guide — Lokaal (≤ 3 min, unlisted YouTube)

Record with **OBS Studio**, 1080p/30fps, crisp mic audio (−12 to −6 dB). Use **Windows Terminal** (renders the agent ANSI colors; plain `cmd.exe` may not).

---

## Part 0 — Prep (~10 min before recording)

**1. Confirm the stack is healthy:**
```bash
cd /path/to/main-logic
docker compose -f docker-compose.prod.yml ps
curl -s http://localhost/swarm/status | jq .
```
Expect `provider: "azure"`, `deployment: "Llama-3.3-70B-Instruct"`, all services `Up`.

**2. Mint a clean 6-hour demo token (inside the container — avoids the dotenv-stdout glitch):**
```bash
TOK=$(docker exec mainlogic-api node -e "const jwt=require('jsonwebtoken');process.stdout.write(jwt.sign({sub:'<USER_UUID>',phone:'+0000000000',type:'access'},process.env.JWT_SECRET,{expiresIn:'6h'}))")
echo "token length: ${#TOK}"   # expect ~239
```
Keep this terminal open for the whole recording.

**3. Warm the model with one dry run** (cold first call is slower):
```bash
curl -s -X POST http://localhost/swarm/meetup -H "Authorization: Bearer $TOK" | jq '.phase'
```

---

## Part 1 — Terminal layout (the winning visual)

Two panes:

**LEFT — live agent conversation (start FIRST, leave running):**
```bash
docker compose -f docker-compose.prod.yml logs -f --tail=0 api | grep --line-buffered -E "PLANNER|RESEARCHER|EXECUTOR|CRITIC|SWARM"
```
Streams ONLY the colored agent lines (cyan Planner, yellow Researcher, green Executor, red Critic).

**RIGHT — where you type curl commands.**

---

## Part 2 — Recording, segment by segment

### 0:00–0:30 — The Hook  (do NOT open with "Hi, I'm…")
> "Every AI app today hands you a confident answer you can't verify, can't audit, and can't 
> trust. 'Meet your friend for coffee' — which friend? Which café? Is that place even real? 
> Lokaal solves this with a four-agent swarm: a Planner, a Researcher, an Executor, and an 
> adversarial Critic that refuse to surface a suggestion until it's grounded in real data and 
> cleared for safety. Watch them work — live."

### 0:30–2:00 — The Action (proof of work)
**RIGHT — trigger, then look LEFT:**
```bash
RESP=$(curl -s -X POST http://localhost/swarm/meetup -H "Authorization: Bearer $TOK")
```
> "The Planner — cyan — decomposes the request. It hands off to the Researcher, yellow: it pulls 
> my five accepted connections, then searches venues at the geographic MIDPOINT between me and each 
> person — so every suggestion is somewhere fair to meet. That's 'midpoint-grounded'. The Executor, 
> green, runs on Azure AI Foundry — Llama 3 — drafting three suggestions grounded only in real data. 
> Then the red Critic adversarially reviews for specificity and safety… and approves."

**RIGHT — show grounded result:**
```bash
echo "$RESP" | jq -r '.result.meetupSuggestions[] | "• \(.connectionName) @ \(.place) — \(.time)"'
```
> "Three real people, three real venues, specific times."

**RIGHT — prove it's auditable (reads state back from the Redis blackboard):**
```bash
RID=$(echo "$RESP" | jq -r .runId)
curl -s http://localhost/swarm/trace/$RID -H "Authorization: Bearer $TOK" | jq '.trace[] | {agent, status, durationMs, attempt, outputSummary}'
```
> "Every step is traceable — each agent, status, and timing — pulled back from our Redis blackboard. 
> Any run is fully auditable."

### 2:00–2:30 — The Architecture (switch to VS Code)
Open `agents.md`, `lib/agentSwarm.ts` (the `SwarmState` type), and the README Mermaid diagram.
> "The swarm is governed by a constitution — agents.md. State lives in one shared SwarmState object, 
> persisted in Redis as a blackboard, so the swarm is stateless and any node can resume a run. If the 
> Critic rejects three times, control hands to a human — our trust layer."

### 2:30–3:00 — The Impact
Show `docker compose ps` (all Up) or the architecture diagram.
> "This isn't a notebook script — it's a production, fully Dockerized stack on the Microsoft stack 
> with Azure AI Foundry. Data-minimized: only first names, interests, and coarse location reach the 
> model. Adversarially validated, human-supervised, traceable end to end. That's enterprise-ready 
> agentic AI. This is Lokaal."

---

## Part 3 — Export & upload
- Export 1080p MP4; trim to **under 3:00** (hard limit).
- If the ~11s Executor wait makes the Action segment long, speed that clip to 1.5× and narrate over it.
- Upload to YouTube as **Unlisted**. Title: `Lokaal — 4-Agent Swarm on Azure AI Foundry (Microsoft Build AI Hackathon)`.
- Add the link to the README and the submission form.

## Reliability tips
1. Test the LEFT pane colors once before recording (use Windows Terminal).
2. Fallback if a live call hangs: you have a validated run to narrate over —
   Planner 6071ms · Researcher "5 connections, 4 venues (midpoint-grounded)" 2081ms ·
   Executor 11108ms (3 suggestions) · Critic APPROVED 3995ms (attempt 1);
   results: Pooja @ 100 Feet Road, Geeta @ Radisson MG Road, Yash @ MG Road Border.
