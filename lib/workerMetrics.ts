import http from "node:http";
import { Registry, Counter } from "prom-client";

export type WorkerName = "location" | "notifications" | "messaging";

function createWorkerRegistry(worker: WorkerName): {
  registry: Registry;
  queueJobsTotal: Counter;
  queueFailuresTotal: Counter;
  proximityMatchesTotal?: Counter;
  notificationsSentTotal?: Counter;
  notificationsFailedTotal?: Counter;
} {
  const registry = new Registry();

  const queueJobsTotal = new Counter({
    name: "queue_jobs_total",
    help: "Total queue jobs processed",
    labelNames: ["worker", "result"],
    registers: [registry],
  });

  const queueFailuresTotal = new Counter({
    name: "queue_failures_total",
    help: "Total queue job failures",
    labelNames: ["worker"],
    registers: [registry],
  });

  const out: {
    registry: Registry;
    queueJobsTotal: Counter;
    queueFailuresTotal: Counter;
    proximityMatchesTotal?: Counter;
    notificationsSentTotal?: Counter;
    notificationsFailedTotal?: Counter;
  } = { registry, queueJobsTotal, queueFailuresTotal };

  if (worker === "location") {
    out.proximityMatchesTotal = new Counter({
      name: "proximity_matches_total",
      help: "Total proximity matches that triggered notification enqueue",
      labelNames: ["worker"],
      registers: [registry],
    });
  }

  if (worker === "notifications" || worker === "messaging") {
    out.notificationsSentTotal = new Counter({
      name: "notifications_sent_total",
      help: "Total push notifications sent successfully",
      registers: [registry],
    });
    out.notificationsFailedTotal = new Counter({
      name: "notifications_failed_total",
      help: "Total push notifications that failed or were skipped",
      registers: [registry],
    });
  }

  return out;
}

export function createWorkerMetrics(worker: WorkerName): {
  startMetricsServer(port: number): void;
  incQueueProcessed(): void;
  incQueueFailed(): void;
  incProximityMatches(): void;
  incNotificationsSent(): void;
  incNotificationsFailed(): void;
} {
  const m = createWorkerRegistry(worker);

  return {
    startMetricsServer(port: number) {
      const server = http.createServer(async (_req, res) => {
        if (_req.url !== "/metrics" || _req.method !== "GET") {
          res.writeHead(404);
          res.end();
          return;
        }
        try {
          res.writeHead(200, { "Content-Type": m.registry.contentType });
          res.end(await m.registry.metrics());
        } catch (err) {
          res.writeHead(500);
          res.end();
        }
      });
      server.listen(port, "0.0.0.0", () => {});
    },

    incQueueProcessed() {
      m.queueJobsTotal.inc({ worker, result: "processed" });
    },
    incQueueFailed() {
      m.queueFailuresTotal.inc({ worker });
      m.queueJobsTotal.inc({ worker, result: "failed" });
    },
    incProximityMatches() {
      m.proximityMatchesTotal?.inc({ worker });
    },
    incNotificationsSent() {
      m.notificationsSentTotal?.inc();
    },
    incNotificationsFailed() {
      m.notificationsFailedTotal?.inc();
    },
  };
}
