#!/usr/bin/env bash
# Initial setup for Main Logic systemd services (API + workers).
# Run on the deployment VM. Usage: sudo ./deploy/setup-services.sh
#
# Prerequisites:
#   - RabbitMQ installed and running (e.g. sudo ./deploy/rabbitmq-setup.sh)
#   - /etc/mainlogic/env created with PORT, JWT_SECRET, SUPABASE_*, RABBITMQ_URL, etc.
#   - App built and deployed to /opt/mainlogic (dist/, package.json, node_modules).

set -e

if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root (e.g. sudo $0)" >&2
  exit 1
fi

# Resolve directory of this script (so it works from repo root or from deploy/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_SRC="${SCRIPT_DIR}/systemd"
SYSTEMD_DEST="/etc/systemd/system"

SERVICES=(mainlogic-api mainlogic-worker-location mainlogic-worker-notifications)

# --- 1) Create app user and deploy directory ---
if ! getent passwd mainlogic >/dev/null 2>&1; then
  useradd -r -s /bin/false mainlogic
  echo "Created user: mainlogic"
else
  echo "User mainlogic already exists"
fi

mkdir -p /opt/mainlogic
chown -R mainlogic:mainlogic /opt/mainlogic
echo "Directory /opt/mainlogic ready (ensure app is deployed here before starting services)"

# --- 2) Env file check ---
if [[ ! -f /etc/mainlogic/env ]]; then
  echo "WARNING: /etc/mainlogic/env not found. Create it with PORT, JWT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RABBITMQ_URL (and optional APNS_*, LOG_LEVEL)." >&2
  echo "Example: sudo touch /etc/mainlogic/env && sudo chmod 600 /etc/mainlogic/env && sudo nano /etc/mainlogic/env" >&2
fi

# --- 3) Copy systemd unit files ---
if [[ ! -d "$SYSTEMD_SRC" ]]; then
  echo "ERROR: systemd directory not found at $SYSTEMD_SRC" >&2
  exit 1
fi

for f in "${SYSTEMD_SRC}"/*.service; do
  [[ -f "$f" ]] || continue
  cp "$f" "$SYSTEMD_DEST/"
  echo "Installed $(basename "$f")"
done

# --- 4) Reload and enable ---
systemctl daemon-reload
for s in "${SERVICES[@]}"; do
  systemctl enable "$s"
  echo "Enabled $s"
done

# --- 5) Start services (may fail if app not deployed yet) ---
echo ""
if systemctl start "${SERVICES[@]}"; then
  echo "All services started. Check: sudo systemctl status mainlogic-api mainlogic-worker-location mainlogic-worker-notifications"
else
  echo "One or more services failed to start. Ensure:"
  echo "  1. App is built and deployed to /opt/mainlogic (dist/, node_modules)"
  echo "  2. /etc/mainlogic/env exists and is correct"
  echo "  3. RabbitMQ is running"
  echo "Then: sudo systemctl start mainlogic-api mainlogic-worker-location mainlogic-worker-notifications"
fi
