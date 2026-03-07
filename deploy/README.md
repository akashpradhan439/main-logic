# Deployment (Ubuntu/Debian VM)

## Local development (RabbitMQ)

To run RabbitMQ locally for testing:

```bash
docker compose up -d
```

- **AMQP**: `localhost:5672` — your app’s default `RABBITMQ_URL` (`amqp://localhost`) works; RabbitMQ allows `guest`/`guest` from localhost.
- **Management UI**: http://localhost:15672 (login: `guest` / `guest`)

Then start the API and workers as usual (`npm run dev`, `npm run worker:location`, `npm run worker:notifications`). Stop with `docker compose down`.

---

## RabbitMQ (production VM)

1. **Install and configure** (on the VM):
   ```bash
   export RABBITMQ_PASSWORD='your-strong-password'
   sudo ./deploy/rabbitmq-setup.sh
   ```
   Optional env: `RABBITMQ_VHOST=/mainlogic`, `RABBITMQ_USER=mainlogic`.

2. **Config**: `deploy/rabbitmq.conf` is copied to `/etc/rabbitmq/rabbitmq.conf` (localhost-only AMQP). Management UI is enabled; bind to localhost and use an SSH tunnel to access it.

3. **App env**: Set `RABBITMQ_URL=amqp://mainlogic:<password>@127.0.0.1:5672/mainlogic` (and other required envs) for the API and workers.

## Systemd services

1. Create app user and deploy dir (on the VM):
   ```bash
   sudo useradd -r -s /bin/false mainlogic
   sudo mkdir -p /opt/mainlogic
   # After copying your built app (e.g. dist/, package.json, node_modules):
   sudo chown -R mainlogic:mainlogic /opt/mainlogic
   ```

2. Create env file `/etc/mainlogic/env` (root-readable only) with at least:
   `PORT`, `JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RABBITMQ_URL`, and optionally `APNS_*`, `LOG_LEVEL`.

3. Copy unit files and enable:
   ```bash
   sudo cp deploy/systemd/*.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable mainlogic-api mainlogic-worker-location mainlogic-worker-notifications
   sudo systemctl start mainlogic-api mainlogic-worker-location mainlogic-worker-notifications
   ```

## Metrics (Prometheus)

- **API**: `GET http://<host>:3000/metrics` — `location_updates_total`
- **Location worker**: `GET http://<host>:9091/metrics` (override with `METRICS_PORT`) — `queue_jobs_total`, `queue_failures_total`, `proximity_matches_total`
- **Notifications worker**: `GET http://<host>:9092/metrics` (override with `METRICS_PORT`) — `queue_jobs_total`, `queue_failures_total`, `notifications_sent_total`, `notifications_failed_total`

Configure Prometheus to scrape these three targets.
