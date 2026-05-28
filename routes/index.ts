import type { FastifyInstance } from "fastify";
import healthRoutes from "./health.js";
import locationRoutes from "./location.js";
import metricsRoutes from "./metrics.js";
import connectionsRoutes from "./connections.js";
import messagingRoutes from "./messaging.js";
import keysRoutes from "./keys.js";
import sseRoutes from "./sse.js";
import profileRoutes from "./profile.js";
import aiRoutes from "./ai.js";
import meetupRoutes from "./meetup.js";
import meetupSuggestionsRoutes from "./meetup-suggestions.js";
import assistantRoutes from "./assistant.js";

export default async function registerRoutes(app: FastifyInstance) {
  app.register(healthRoutes);
  app.register(locationRoutes);
  app.register(metricsRoutes);
  app.register(connectionsRoutes);
  app.register(messagingRoutes);
  app.register(keysRoutes);
  app.register(sseRoutes);
  app.register(profileRoutes);
  app.register(aiRoutes);
  app.register(meetupRoutes);
  app.register(meetupSuggestionsRoutes);
  app.register(assistantRoutes);
}