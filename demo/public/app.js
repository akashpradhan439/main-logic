"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard page. Requires a session token (set by the login page); if missing
// or rejected by the server, it redirects back to the login page.
// ─────────────────────────────────────────────────────────────────────────────
const TOKEN_KEY = "lokaal_demo_token";
const AGENT_LABEL = { planner: "PLANNER", researcher: "RESEARCHER", executor: "EXECUTOR", critic: "CRITIC", system: "SYSTEM" };

let token = sessionStorage.getItem(TOKEN_KEY) || "";

// ─── tiny DOM helpers ─────────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function nowTime() {
  return new Date().toTimeString().slice(0, 8);
}
async function api(path, opts = {}) {
  const headers = Object.assign({ Authorization: "Bearer " + token }, opts.headers || {});
  return fetch(path, Object.assign({}, opts, { headers }));
}
function goToLogin() {
  sessionStorage.removeItem(TOKEN_KEY);
  token = "";
  window.location.replace("index.html");
}

// ─── Auth guard + session info ────────────────────────────────────────────────
async function initSession() {
  if (!token) {
    goToLogin();
    return;
  }
  try {
    const resp = await api("api/session");
    if (resp.status === 401) {
      goToLogin();
      return;
    }
    const data = await resp.json();
    const u = data.user || {};
    $("#session-info").textContent =
      `as ${u.firstName || "user"} · ${data.provider}/${data.deployment}` + (u.hasLocation ? " · 📍" : "");
  } catch (e) {
    $("#session-info").textContent = "session error";
  }
}

$("#logout").addEventListener("click", goToLogin);

// ─── Tabs ───────────────────────────────────────────────────────────────────
$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const name = tab.dataset.tab;
    $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $$(".panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === name));
  });
});

// ─── Logging ──────────────────────────────────────────────────────────────────
function logEl(tab) { return $(`.log[data-log="${tab}"]`); }
function resultsEl(tab) { return $(`.results[data-results="${tab}"]`); }

function logLine(tab, agent, msg, opts = {}) {
  const box = logEl(tab);
  const line = el("div", `log-line ${agent}` + (opts.running ? " running" : ""));
  line.appendChild(el("span", "ts", nowTime()));
  line.appendChild(el("span", "tag", `[${AGENT_LABEL[agent] || agent.toUpperCase()}]`));
  line.appendChild(el("span", "msg", msg));
  if (opts.pill) line.appendChild(el("span", "pill", opts.pill));
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}
function banner(tab, kind, text) {
  resultsEl(tab).prepend(el("div", `status-banner ${kind}`, text));
}
function clearTab(tab) { logEl(tab).innerHTML = ""; resultsEl(tab).innerHTML = ""; }

// ─── Swarm features (one-shot, SSE via EventSource) ───────────────────────────
const swarmState = {}; // tab -> { es, streamId, running }

function setRunning(tab, running) {
  const runBtn = $(`.run-btn[data-run="${tab}"]`);
  const stopBtn = $(`.stop-btn[data-stop="${tab}"]`);
  if (runBtn) { runBtn.disabled = running; runBtn.textContent = running ? "Running…" : "Run swarm"; }
  if (stopBtn) stopBtn.disabled = !running;
}

function runSwarm(tab) {
  if (swarmState[tab] && swarmState[tab].running) return;
  clearTab(tab);
  setRunning(tab, true);
  logLine(tab, "system", "Opening swarm stream…");

  const url = `api/swarm/${tab}/stream?token=${encodeURIComponent(token)}`;
  const es = new EventSource(url);
  swarmState[tab] = { es, streamId: null, running: true };

  es.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    handleSwarmEvent(tab, m);
  };
  es.onerror = () => {
    if (swarmState[tab] && swarmState[tab].running) {
      logLine(tab, "system", "Stream closed.");
      finishSwarm(tab);
    }
  };
}

function finishSwarm(tab) {
  const st = swarmState[tab];
  if (st && st.es) st.es.close();
  if (st) st.running = false;
  setRunning(tab, false);
}

function handleSwarmEvent(tab, m) {
  switch (m.type) {
    case "run_started":
      swarmState[tab].streamId = m.streamId;
      logLine(tab, "system", `Run ${m.streamId.slice(0, 8)} · task=${m.taskType}`);
      break;
    case "agent":
      logLine(tab, m.agent, m.message);
      break;
    case "agent_start":
      logLine(tab, m.agent, `→ ${m.phase}${m.attempt ? ` (attempt ${m.attempt})` : ""}`, { running: true, pill: "running" });
      break;
    case "trace": {
      const e = m.entry;
      const dur = e.durationMs != null ? `${e.durationMs}ms` : "";
      logLine(tab, e.agent, `${e.outputSummary}`, { pill: `${e.status}${dur ? " · " + dur : ""}` });
      break;
    }
    case "phase":
      logLine(tab, "system", `phase → ${m.phase}`);
      break;
    case "result":
      renderSwarmResult(tab, m);
      break;
    case "error":
      banner(tab, "err", "Error: " + m.message);
      finishSwarm(tab);
      break;
    case "aborted":
      banner(tab, "warn", "⏹ Workflow stopped by user.");
      finishSwarm(tab);
      break;
    case "done":
      finishSwarm(tab);
      break;
  }
}

function renderSwarmResult(tab, m) {
  const box = resultsEl(tab);
  const r = m.result || {};
  if (m.approved) banner(tab, "ok", `✓ Critic approved after ${m.attempts} attempt(s).`);
  else banner(tab, "warn", `⚠ Not approved after ${m.attempts} attempts — flagged for human review.`);

  const list = r.meetupSuggestions || r.connectionSuggestions || [];
  if (list.length === 0) {
    box.appendChild(el("p", "muted", "No suggestions produced."));
    return;
  }
  list.forEach((s) => {
    const card = el("div", "card");
    if (tab === "meetup") {
      card.appendChild(el("h3", null, s.title || "Meetup idea"));
      card.appendChild(el("p", "meta", `${s.connectionName ? "with " + s.connectionName : ""}${s.place ? " · " + s.place : ""}${s.time ? " · " + s.time : ""}`));
      if (s.text) card.appendChild(el("p", null, s.text));
    } else {
      card.appendChild(el("h3", null, "Suggested connection"));
      if (s.userId) card.appendChild(el("p", "meta", "id " + String(s.userId).slice(0, 8)));
      if (s.reason) card.appendChild(el("p", null, s.reason));
    }
    box.appendChild(card);
  });
}

$$(".run-btn").forEach((b) => b.addEventListener("click", () => runSwarm(b.dataset.run)));
$$(".stop-btn").forEach((b) =>
  b.addEventListener("click", async () => {
    const tab = b.dataset.stop;
    const st = swarmState[tab];
    if (!st || !st.running) return;
    logLine(tab, "system", "Stop requested…");
    if (st.streamId) {
      try { await api("api/swarm/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ streamId: st.streamId }) }); } catch (e) {}
    }
    finishSwarm(tab);
    banner(tab, "warn", "⏹ Workflow stopped by user.");
  })
);

// ─── Assistant (continuous chat, SSE-over-POST) ───────────────────────────────
let assistantBusy = false;

function chatBubble(role, text) {
  const chat = $(`.chat[data-chat="assistant"]`);
  const b = el("div", `bubble ${role}`, text);
  chat.appendChild(b);
  chat.scrollTop = chat.scrollHeight;
  return b;
}

function renderCardsInChat(cards) {
  if (!cards || !cards.length) return;
  const chat = $(`.chat[data-chat="assistant"]`);
  const wrap = el("div", "chat-cards");
  cards.forEach((c) => wrap.appendChild(renderAssistantCard(c)));
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
}

function renderAssistantCard(c) {
  const card = el("div", "card");
  if (c.type === "places") {
    card.appendChild(el("h3", null, `📍 ${c.data.length} place(s)`));
    c.data.slice(0, 5).forEach((p) => card.appendChild(el("p", "meta", `${p.name}${p.rating ? " ★" + p.rating : ""} — ${p.address || ""}`)));
  } else if (c.type === "events") {
    card.appendChild(el("h3", null, `🎫 ${c.data.length} event(s)`));
    c.data.slice(0, 5).forEach((e) => card.appendChild(el("p", "meta", `${e.title}${e.date ? " · " + e.date : ""}${e.venue ? " @ " + e.venue : ""}`)));
  } else if (c.type === "place_detail") {
    const p = c.data;
    card.appendChild(el("h3", null, p.name));
    card.appendChild(el("p", "meta", `${p.rating ? "★" + p.rating + " · " : ""}${p.address || ""}`));
  } else if (c.type === "connections") {
    card.appendChild(el("h3", null, "Which connection?"));
    const row = el("div", "tagrow");
    c.data.forEach((m) => row.appendChild(el("span", null, m.name)));
    card.appendChild(row);
  }
  return card;
}

function handleAssistantEvent(m, ctx) {
  switch (m.type) {
    case "agent":
      logLine("assistant", m.agent, m.message);
      break;
    case "card":
      ctx.cards.push(m.card);
      break;
    case "reply":
      ctx.typing.classList.remove("typing");
      ctx.typing.textContent = m.text || "(no reply)";
      renderCardsInChat(m.cards && m.cards.length ? m.cards : ctx.cards);
      break;
    case "error":
      ctx.typing.classList.remove("typing");
      ctx.typing.textContent = "⚠ " + m.message;
      logLine("assistant", "critic", "Error: " + m.message);
      break;
    case "done":
      ctx.done = true;
      break;
  }
}

async function sendChat(message) {
  if (assistantBusy || !message) return;
  assistantBusy = true;
  $(`[data-chatsend="assistant"]`).disabled = true;
  chatBubble("user", message);
  const typing = chatBubble("assistant typing", "thinking…");
  logLine("assistant", "system", `User: ${message}`);

  const ctx = { cards: [], typing, done: false };
  try {
    const resp = await api("api/assistant/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (resp.status === 401) { goToLogin(); return; }
    if (!resp.ok || !resp.body) {
      typing.classList.remove("typing");
      typing.textContent = "⚠ Server error (" + resp.status + ")";
      return;
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        let m;
        try { m = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
        handleAssistantEvent(m, ctx);
      }
    }
  } catch (e) {
    typing.classList.remove("typing");
    typing.textContent = "⚠ Connection error.";
  } finally {
    assistantBusy = false;
    $(`[data-chatsend="assistant"]`).disabled = false;
    $(`[data-chatmsg="assistant"]`).focus();
  }
}

$(`[data-chatform="assistant"]`).addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $(`[data-chatmsg="assistant"]`);
  const msg = input.value.trim();
  if (!msg) return;
  input.value = "";
  sendChat(msg);
});

$(`[data-reset="assistant"]`).addEventListener("click", async () => {
  try { await api("api/assistant/reset", { method: "POST" }); } catch (e) {}
  $(`.chat[data-chat="assistant"]`).innerHTML = "";
  logEl("assistant").innerHTML = "";
  logLine("assistant", "system", "Conversation reset.");
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
initSession();
