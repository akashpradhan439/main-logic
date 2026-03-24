#!/bin/bash
exec > >(tee -a /opt/mainlogic-deploy.log) 2>&1
# ----------------------------------------------------------------------
# This is a Git post-receive hook to be placed on the Oracle Server
# Location: /opt/mainlogic.git/hooks/post-receive
# Ensure you make it executable: chmod +x /opt/mainlogic.git/hooks/post-receive
# ----------------------------------------------------------------------

TARGET_DIR="/opt/mainlogic"
GIT_DIR="/opt/mainlogic.git"

# Read hook arguments from stdin
read oldrev newrev refname

# Only deploy if pushing to main branch
if [ "$refname" != "refs/heads/main" ]; then
    echo "-> Push to $refname detected. Skipping deployment."
    exit 0
fi

echo "============================================="
echo " Starting raw CI/CD Deployment Process..."
echo " Deploying: $oldrev -> $newrev"
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
git --work-tree=$TARGET_DIR --git-dir=$GIT_DIR checkout -f $newrev

# 2. Run Tests locally on the server before deploying
echo "-> Installing dependencies for testing..."
cd $TARGET_DIR
npm ci

echo "-> Running tests..."
if npm test; then
    echo "-> Tests Passed!"
    
    # 3. Deploy via Docker Compose with Retries
    echo "-> Building and deploying Docker containers..."
    
    MAX_RETRIES=3
    COUNT=0
    SUCCESS=0
    
    while [ $COUNT -lt $MAX_RETRIES ]; do
        COUNT=$((COUNT+1))
        echo "   [Attempt $COUNT/$MAX_RETRIES] Building containers..."
        
        if DOCKER_BUILDKIT=1 COMPOSE_DOCKER_CLI_BUILD=1 docker compose -f docker-compose.prod.yml up -d --build; then
            SUCCESS=1
            break
        else
            echo "   !!! Build Failed on attempt $COUNT !!!"
            if [ $COUNT -lt $MAX_RETRIES ]; then
                echo "   Waiting 5 seconds before retrying..."
                sleep 5
            fi
        fi
    done

    if [ $SUCCESS -eq 1 ]; then
        echo "==========================================="
        echo " Deployment Successful! "
        echo "==========================================="
    else
        echo "-> FATAL: Docker Compose Build Failed after $MAX_RETRIES attempts."
        echo "-> Reverting code to previous commit: $oldrev"
        git --work-tree=$TARGET_DIR --git-dir=$GIT_DIR checkout -f $oldrev
        
        # Ensure containers are running the old version
        echo "-> Ensuring containers are running the last stable version..."
        docker compose -f docker-compose.prod.yml up -d
        
        echo "==========================================="
        echo " Deployment Failed and Reverted. Check Logs. "
        echo "==========================================="
        exit 1
    fi
else
    echo "-> Tests Failed! Aborting Deployment."
    echo "-> Rolling back changes by checking out previous commit: $oldrev"
    git --work-tree=$TARGET_DIR --git-dir=$GIT_DIR checkout -f $oldrev
    exit 1
fi
