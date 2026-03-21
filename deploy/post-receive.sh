#!/bin/bash
exec > >(tee -a /opt/mainlogic-deploy.log) 2>&1
# ----------------------------------------------------------------------
# This is a Git post-receive hook to be placed on the Oracle Server
# Location: /opt/mainlogic.git/hooks/post-receive
# Ensure you make it executable: chmod +x /opt/mainlogic.git/hooks/post-receive
# ----------------------------------------------------------------------

TARGET_DIR="/opt/mainlogic"
GIT_DIR="/opt/mainlogic.git"

echo "============================================="
echo " Starting raw CI/CD Deployment Process..."
echo "============================================="

# 1. Checkout the latest code into TARGET_DIR
echo "-> Checking out latest code to $TARGET_DIR..."

# Check available RAM (important for Oracle Free Tier)
FREE_RAM=$(free -m | awk '/^Mem:/{print $4}')
if [ "$FREE_RAM" -lt 500 ]; then
    echo "WARNING: Low memory detected ($FREE_RAM MB). Build may fail."
    echo "Consider adding a swap file if this persists."
fi

mkdir -p $TARGET_DIR
git --work-tree=$TARGET_DIR --git-dir=$GIT_DIR checkout -f main

# 2. Run Tests locally on the server before deploying
echo "-> Installing dependencies for testing..."
cd $TARGET_DIR
npm ci

echo "-> Running tests..."
if npm test; then
    echo "-> Tests Passed!"
    
    # 3. Deploy via Docker Compose
    echo "-> Building and deploying Docker containers..."
    # Warning: .env file needs to be present in /opt/mainlogic/.env 
    # since it's typically gitignored. Make sure you copy your server 
    # .env file to /opt/mainlogic/ manually once.
    
    if DOCKER_BUILDKIT=1 COMPOSE_DOCKER_CLI_BUILD=1 docker compose -f docker-compose.prod.yml up -d --build; then
        echo "==========================================="
        echo " Deployment Successful! "
        echo "==========================================="
    else
        echo "-> Docker Compose Build Failed! Aborting Deployment."
        exit 1
    fi
else
    echo "-> Tests Failed! Aborting Deployment."
    echo "-> Rolling back changes is not strictly needed as containers weren't restarted."
    exit 1
fi
