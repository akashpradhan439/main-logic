#!/usr/bin/env python3
"""
Google Events scraper — Playwright + SQLite cache + stealth.

Invoked by the n8n "Events Scraper" workflow via Execute Command:
    python3 /home/ubuntu/scraper/scrape.py '{"query":"...","location":"..."}'

Stdout (single line of JSON) is one of:
    {"source":"cache","events":[...]}                             # cache hit
    {"source":"live","status":"OK","html":"<...>"}                # live fetch ok
    {"source":"error","status":"BLOCKED|EMPTY|...","events":[]}   # all retries failed

The n8n workflow inspects "source": when "cache" it short-circuits;
when "live" it passes html to a Groq parser to extract structured events;
when "error" it returns an empty events array to the caller.
"""

import sys
import json
import time
import random
import re
import sqlite3
import hashlib
import os


_SCRIPT_RE = re.compile(r"<script\b[^>]*>.*?</script>", re.IGNORECASE | re.DOTALL)
_STYLE_RE = re.compile(r"<style\b[^>]*>.*?</style>", re.IGNORECASE | re.DOTALL)
_NOSCRIPT_RE = re.compile(r"<noscript\b[^>]*>.*?</noscript>", re.IGNORECASE | re.DOTALL)
_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_SVG_RE = re.compile(r"<svg\b[^>]*>.*?</svg>", re.IGNORECASE | re.DOTALL)
_HEAD_RE = re.compile(r"<head\b[^>]*>.*?</head>", re.IGNORECASE | re.DOTALL)
_WS_RE = re.compile(r"\s+")


def slim_html(html: str, max_chars: int = 25000) -> str:
    """Strip scripts/styles/svg/head/comments and collapse whitespace so the
    AI parser stays under Groq's TPM cap. The remaining markup is enough for
    Llama-3.3 to extract event names, dates, venues, etc."""
    if not html:
        return ""
    h = _COMMENT_RE.sub(" ", html)
    h = _SCRIPT_RE.sub(" ", h)
    h = _STYLE_RE.sub(" ", h)
    h = _NOSCRIPT_RE.sub(" ", h)
    h = _SVG_RE.sub(" ", h)
    h = _HEAD_RE.sub(" ", h)
    h = _WS_RE.sub(" ", h)
    return h.strip()[:max_chars]

UA_LIST = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
]

VIEWPORTS = [
    (1366, 768),
    (1440, 900),
    (1280, 800),
    (1920, 1080),
    (1536, 864),
    (1600, 900),
]

DB_PATH = os.environ.get("EVENTS_CACHE_DB", "/home/ubuntu/scraper/events_cache.db")
TTL_HOURS = 4


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS cache (
            key TEXT PRIMARY KEY,
            data TEXT,
            fetched_at INTEGER
        )"""
    )
    conn.commit()
    return conn


def cache_get(key: str):
    try:
        conn = get_db()
        row = conn.execute(
            "SELECT data, fetched_at FROM cache WHERE key=?", (key,)
        ).fetchone()
        if row and (time.time() - row[1]) / 3600 < TTL_HOURS:
            return json.loads(row[0])
    except Exception:
        return None
    return None


def cache_set(key: str, data):
    try:
        conn = get_db()
        conn.execute(
            "INSERT OR REPLACE INTO cache VALUES (?,?,?)",
            (key, json.dumps(data), int(time.time())),
        )
        conn.commit()
    except Exception:
        pass


def scrape(query: str, location: str = ""):
    from playwright.sync_api import sync_playwright

    ua = random.choice(UA_LIST)
    vw, vh = random.choice(VIEWPORTS)
    delay_ms = random.randint(4000, 9000)

    q = f"{query} {location}".strip().replace(" ", "+")
    url = f"https://www.google.com/search?q={q}&ibp=htl;events&hl=en&gl=in"

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
            ],
        )
        ctx = browser.new_context(
            user_agent=ua,
            viewport={"width": vw, "height": vh},
            locale="en-IN",
            timezone_id="Asia/Kolkata",
            extra_http_headers={
                "Accept-Language": "en-IN,en;q=0.9",
                "Referer": "https://www.google.com/",
                "DNT": "1",
            },
            java_script_enabled=True,
        )
        ctx.add_init_script(
            """
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
            """
        )
        page = ctx.new_page()
        page.route(
            "**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,otf,css}",
            lambda r: r.abort(),
        )

        page.goto(url, wait_until="domcontentloaded", timeout=35000)
        page.wait_for_timeout(delay_ms)

        page.evaluate(
            "window.scrollBy(0, Math.floor(Math.random()*400)+200)"
        )
        page.wait_for_timeout(random.randint(800, 1800))

        title = page.title().lower()
        content = page.content()
        if any(x in title for x in ["captcha", "unusual traffic", "sorry"]):
            browser.close()
            return None, "BLOCKED"
        if len(content) < 5000:
            browser.close()
            return None, "EMPTY"

        browser.close()
        return content, "OK"


def main():
    args = json.loads(sys.argv[1])
    query = args.get("query", "")
    location = args.get("location", "")

    cache_key = hashlib.md5(f"{query}:{location}".encode()).hexdigest()
    cached = cache_get(cache_key)
    if cached:
        print(json.dumps({"source": "cache", "events": cached}))
        return

    html, status = scrape(query, location)
    if status != "OK":
        for attempt in range(1, 4):
            time.sleep(attempt * 8 + random.randint(2, 6))
            html, status = scrape(query, location)
            if status == "OK":
                break

    if status != "OK":
        print(json.dumps({"source": "error", "status": status, "events": []}))
        sys.exit(1)

    print(
        json.dumps(
            {"source": "live", "status": "OK", "html": slim_html(html)}
        )
    )


if __name__ == "__main__":
    main()
