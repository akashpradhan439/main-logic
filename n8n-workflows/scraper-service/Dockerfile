# Headless-Chromium scraper sidecar.
# Wraps scrape.py behind a tiny FastAPI HTTP endpoint that the n8n
# events-scraper workflow calls. Keeping the scraper out of the n8n
# container itself avoids bloating that image with Python + Chromium.

FROM mcr.microsoft.com/playwright/python:v1.49.0-jammy

WORKDIR /app

RUN pip install --no-cache-dir \
      playwright==1.49.0 \
      fastapi==0.115.5 \
      uvicorn==0.32.1

COPY server.py /app/server.py
COPY scrape.py /app/scrape.py

# SQLite cache lives under /data so it survives container restarts when
# /data is mounted from a volume.
ENV EVENTS_CACHE_DB=/data/events_cache.db
RUN mkdir -p /data

EXPOSE 8080

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
