import { Registry, Counter } from "prom-client";

const registry = new Registry();

export const locationUpdatesTotal = new Counter({
  name: "location_updates_total",
  help: "Total location updates published to the queue",
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
