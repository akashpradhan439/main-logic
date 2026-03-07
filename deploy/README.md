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

**Initial setup (run once on the VM):**

1. Install and start RabbitMQ first (see above).
2. Create env file `/etc/mainlogic/env` (root-readable only) with at least:
   `PORT`, `JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RABBITMQ_URL`, and optionally `APNS_*`, `LOG_LEVEL`.
   ```bash
   sudo touch /etc/mainlogic/env && sudo chmod 600 /etc/mainlogic/env
   ```
3. Run the setup script (creates user, `/opt/mainlogic`, installs units, enables and starts services):
   ```bash
   sudo ./deploy/setup-services.sh
   ```
4. Deploy your built app to `/opt/mainlogic` (e.g. `dist/`, `package.json`, `node_modules`), then:
   ```bash
   sudo chown -R mainlogic:mainlogic /opt/mainlogic
   sudo systemctl start mainlogic-api mainlogic-worker-location mainlogic-worker-notifications
   ```
   If you already deployed before running the script, the script will have started the services for you.

**Manual steps (if you prefer not to use the script):** create user and dir, copy `deploy/systemd/*.service` to `/etc/systemd/system/`, then `daemon-reload`, `enable`, and `start` the three units as above.

The API handles `SIGTERM`/`SIGINT` for graceful shutdown; systemd units use `TimeoutStopSec=30` and `KillSignal=SIGTERM`.

## Metrics (Prometheus)

- **API**: `GET http://<host>:3000/metrics` — `location_updates_total`
- **Location worker**: `GET http://<host>:9091/metrics` (override with `METRICS_PORT`) — `queue_jobs_total`, `queue_failures_total`, `proximity_matches_total`
- **Notifications worker**: `GET http://<host>:9092/metrics` (override with `METRICS_PORT`) — `queue_jobs_total`, `queue_failures_total`, `notifications_sent_total`, `notifications_failed_total`

Configure Prometheus to scrape these three targets.
