"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// Login page. On success it REDIRECTS to the dashboard page (app.html).
//
// NOTE (intentional): the demo credential below is hard-coded in client JS, so
// it is plainly visible to anyone reading this file — by design for a shared
// hackathon demo. Real enforcement is still SERVER-side: /api/login re-checks
// the credential and mints a signed session token that every API call requires.
// ─────────────────────────────────────────────────────────────────────────────
const DEMO_CREDENTIALS = { username: "microsoft", password: "microsoft" };
const TOKEN_KEY = "lokaal_demo_token";

const form = document.querySelector("#login-form");
const errEl = document.querySelector("#login-error");
const btn = document.querySelector("#login-btn");

// Already signed in? Go straight to the dashboard.
if (sessionStorage.getItem(TOKEN_KEY)) {
  window.location.replace("app.html");
}

async function doLogin(username, password) {
  errEl.hidden = true;
  if (username !== DEMO_CREDENTIALS.username || password !== DEMO_CREDENTIALS.password) {
    errEl.textContent = "Invalid credentials.";
    errEl.hidden = false;
    return;
  }
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const resp = await fetch("api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.token) {
      errEl.textContent = data.error === "too_many_attempts" ? "Too many attempts — wait a minute." : "Login rejected.";
      errEl.hidden = false;
      return;
    }
    sessionStorage.setItem(TOKEN_KEY, data.token);
    // Real page navigation to the dashboard.
    window.location.assign("app.html");
  } catch (e) {
    errEl.textContent = "Network error contacting server.";
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  doLogin(
    document.querySelector("#username").value.trim(),
    document.querySelector("#password").value
  );
});
