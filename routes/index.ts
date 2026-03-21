import type { FastifyInstance } from "fastify";
import healthRoutes from "./health.js";
import locationRoutes from "./location.js";
import metricsRoutes from "./metrics.js";
import connectionsRoutes from "./connections.js";
import messagingRoutes from "./messaging.js";

export default async function registerRoutes(app: FastifyInstance) {
  app.register(healthRoutes);
  app.register(locationRoutes);
  app.register(metricsRoutes);
  app.register(connectionsRoutes);
  app.register(messagingRoutes);
}