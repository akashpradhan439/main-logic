#!/usr/bin/env bash
# RabbitMQ setup for Ubuntu/Debian (native install).
# Run on the deployment VM. Usage: sudo ./rabbitmq-setup.sh

set -e

# --- 1) Prerequisites ---
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl gnupg apt-transport-https ca-certificates

# --- 2) RabbitMQ + Erlang repos (official Team RabbitMQ) ---
# See: https://www.rabbitmq.com/docs/install-debian
curl -1sLf "https://keys.openpgp.org/vks/v1/by-fingerprint/0A9AF2115F4687BD29803A206B73A36E6026DFCA" | gpg --dearmor -o /usr/share/keyrings/com.rabbitmq.team.gpg
CODENAME="$(lsb_release -cs)"
tee /etc/apt/sources.list.d/rabbitmq.list <<EOF
deb [arch=amd64 signed-by=/usr/share/keyrings/com.rabbitmq.team.gpg] https://deb1.rabbitmq.com/rabbitmq-erlang/ubuntu/${CODENAME} ${CODENAME} main
deb [arch=amd64 signed-by=/usr/share/keyrings/com.rabbitmq.team.gpg] https://deb2.rabbitmq.com/rabbitmq-erlang/ubuntu/${CODENAME} ${CODENAME} main
deb [arch=amd64 signed-by=/usr/share/keyrings/com.rabbitmq.team.gpg] https://deb1.rabbitmq.com/rabbitmq-server/ubuntu/${CODENAME} ${CODENAME} main
deb [arch=amd64 signed-by=/usr/share/keyrings/com.rabbitmq.team.gpg] https://deb2.rabbitmq.com/rabbitmq-server/ubuntu/${CODENAME} ${CODENAME} main
EOF

apt-get update
apt-get install -y rabbitmq-server

# --- 3) Config: localhost-only listeners ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/rabbitmq.conf" ]; then
  cp "${SCRIPT_DIR}/rabbitmq.conf" /etc/rabbitmq/rabbitmq.conf
fi

# --- 4) Enable and start ---
systemctl enable rabbitmq-server
systemctl start rabbitmq-server

# --- 5) Optional: management UI (localhost only) ---
rabbitmq-plugins enable rabbitmq_management

# --- 6) Create vhost and app user ---
VHOST="${RABBITMQ_VHOST:-/mainlogic}"
USERNAME="${RABBITMQ_USER:-mainlogic}"
# Set a strong password in production (e.g. RABBITMQ_PASSWORD=... when running this script).
PASSWORD="${RABBITMQ_PASSWORD:?Set RABBITMQ_PASSWORD when running this script}"

rabbitmqctl add_vhost "$VHOST"
rabbitmqctl add_user "$USERNAME" "$PASSWORD"
rabbitmqctl set_permissions -p "$VHOST" "$USERNAME" ".*" ".*" ".*"
rabbitmqctl set_user_tags "$USERNAME" ""

echo "RabbitMQ is running. Set RABBITMQ_URL=amqp://${USERNAME}:<password>@127.0.0.1:5672${VHOST} for the app and workers."
