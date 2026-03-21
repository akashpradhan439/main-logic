FROM node:20-alpine AS builder
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Copy the rest of the application
COPY . .

# Build the TypeScript code
RUN npm run build

# Next stage: Production runner
FROM node:20-alpine AS runner
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# Copy built dist folder from builder stage
COPY --from=builder /app/dist ./dist

# Keep workers directory for tsx execution if necessary, or let tsx be installed
# Note: The workers are transpiled to dist/workers as per package.json build script 
# "worker:location:prod": "node dist/workers/locationUpdatedWorker.js"
# "worker:notifications:prod": "node dist/workers/pushNotificationWorker.js"

EXPOSE 3000

# By default run the API
CMD ["npm", "start"]
