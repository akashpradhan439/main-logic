import type { FastifyInstance } from "fastify";
import { getMetricsContent, getContentType } from "../lib/metrics.js";

export default async function metricsRoutes(app: FastifyInstance) {
  app.get("/metrics", async (_request, reply) => {
    const content = await getMetricsContent();
    return reply
      .header("Content-Type", getContentType())
      .send(content);
  });
}
