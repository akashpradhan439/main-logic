import { Registry, Counter } from "prom-client";

const registry = new Registry();

export const locationUpdatesTotal = new Counter({
  name: "location_updates_total",
  help: "Total location updates published to the queue",
  registers: [registry],
});

export const locationUpdatesPublishFailuresTotal = new Counter({
  name: "location_updates_publish_failures_total",
  help: "Total failed attempts to publish location updates to the queue",
  registers: [registry],
});

export const connectionRequestsTotal = new Counter({
  name: "connection_requests_total",
  help: "Total connection requests created",
  registers: [registry],
});

export const connectionAcceptsTotal = new Counter({
  name: "connection_accepts_total",
  help: "Total connection requests accepted",
  registers: [registry],
});

export const connectionBlocksTotal = new Counter({
  name: "connection_blocks_total",
  help: "Total connection blocks created",
  registers: [registry],
});

export function getMetricsRegistry(): Registry {
  return registry;
}

export async function getMetricsContent(): Promise<string> {
  return registry.metrics();
}

export function getContentType(): string {
  return registry.contentType;
}
