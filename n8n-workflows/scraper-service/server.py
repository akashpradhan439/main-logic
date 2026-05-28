"""
Minimal HTTP wrapper around scrape.py. Exposes POST /scrape that returns
the same JSON shape scrape.py emits on stdout, so the n8n workflow only
needs an HTTP Request node instead of an Execute Command node.

  POST /scrape    body: {"query": "...", "location": "..."}
  GET  /health    returns {"ok": true}
"""

import json
import os
import sys

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# scrape.py exposes scrape(), cache_get(), cache_set() at module scope.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scrape as scraper

app = FastAPI()


class ScrapeRequest(BaseModel):
    query: str = Field(min_length=1, max_length=200)
    location: str = Field(default="", max_length=200)


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/scrape")
def do_scrape(req: ScrapeRequest):
    query = req.query.strip()
    location = req.location.strip()
    if not query:
        raise HTTPException(status_code=400, detail="query is required")

    import hashlib
    import random
    import time

    cache_key = hashlib.md5(f"{query}:{location}".encode()).hexdigest()
    cached = scraper.cache_get(cache_key)
    if cached:
        return {"source": "cache", "events": cached}

    html, status = scraper.scrape(query, location)
    if status != "OK":
        for attempt in range(1, 4):
            time.sleep(attempt * 8 + random.randint(2, 6))
            html, status = scraper.scrape(query, location)
            if status == "OK":
                break

    if status != "OK":
        return {"source": "error", "status": status, "events": []}

    return {
        "source": "live",
        "status": "OK",
        "html": scraper.slim_html(html or ""),
    }
