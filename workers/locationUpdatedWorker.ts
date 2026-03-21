import "dotenv/config";
import amqp from "amqplib";
import pino from "pino";
import { config } from "../config.js";
import { supabase } from "../lib/supabase.js";
import {
  type LocationUpdatedEvent,
  publishHexOverlapNotification,
} from "../lib/rabbitmq.js";
import { createWorkerMetrics } from "../lib/workerMetrics.js";

const log = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: {
    level: (label) => ({ level: label }),
  },
});

const LOCATION_UPDATED_QUEUE = config.locationUpdatedQueue;

function getSortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function hexesOverlap(
  callerCenter: string,
  callerNeighbors: string[],
  targetCenter: string | null,
  targetNeighbors: string[] | null
): { overlaps: boolean; overlapHex: string | null } {
  const callerHexes = new Set<string>([callerCenter, ...callerNeighbors]);
  const targetCenterStr = targetCenter ?? "";
  const targetNeighborList = targetNeighbors ?? [];

  if (targetCenterStr && callerHexes.has(targetCenterStr)) {
    return { overlaps: true, overlapHex: targetCenterStr };
  }
  for (const h of targetNeighborList) {
    if (callerHexes.has(h)) {
      return { overlaps: true, overlapHex: h };
    }
  }
  return { overlaps: false, overlapHex: null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const metrics = createWorkerMetrics("location");
  const metricsPort = Number(process.env.METRICS_PORT) || 9091;
  metrics.startMetricsServer(metricsPort);
  log.info({ event: "worker_start", queue: LOCATION_UPDATED_QUEUE, metricsPort }, "Location worker starting");

  let connection;
  let attempt = 1;
  const maxAttempts = 10;
  const delayMs = 3000;

  while (attempt <= maxAttempts) {
    try {
      connection = await amqp.connect(config.rabbitUrl);
      break;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      log.warn(
        { attempt, maxAttempts, delayMs, err: (err as Error).message },
        "Failed to connect to RabbitMQ, retrying..."
      );
      await sleep(delayMs);
      attempt++;
    }
  }

  if (!connection) throw new Error("Could not establish RabbitMQ connection");
  
  const channel = await connection.createChannel();

  await channel.assertExchange(config.rabbitExchange, "topic", { durable: true });
  await channel.assertQueue(LOCATION_UPDATED_QUEUE, { durable: true });
  await channel.bindQueue(
    LOCATION_UPDATED_QUEUE,
    config.rabbitExchange,
    config.locationUpdatedRoutingKey
  );

  await channel.consume(
    LOCATION_UPDATED_QUEUE,
    async (msg: amqp.ConsumeMessage | null) => {
      if (!msg) return;

      const requestId =
        (msg.properties.headers?.requestId as string | undefined) ?? `worker-${Date.now()}`;
      const logCtx = { requestId, event: "location_worker_received" };

      try {
        const payload = JSON.parse(msg.content.toString()) as unknown;
        const event = payload as LocationUpdatedEvent;

        if (!event.userId || !event.centerHex || !Array.isArray(event.neighborHexes)) {
          log.warn({ ...logCtx, payload }, "Invalid location.updated payload");
          metrics.incQueueProcessed();
          channel.ack(msg);
          return;
        }

        const { userId, centerHex, neighborHexes } = event;

        log.info(
          { ...logCtx, userId, shouldCheckNotifications: true },
          "Processing location update"
        );

        // 1. Fetch accepted connections for caller
        const { data: connections, error: connError } = await supabase
          .from("connections")
          .select("requester_id, addressee_id")
          .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
          .eq("status", "accepted");

        if (connError) {
          log.error(
            { ...logCtx, userId, err: connError.message },
            "Failed to fetch connections"
          );
          metrics.incQueueFailed();
          channel.nack(msg, false, true);
          return;
        }

        const connectedUserIds = new Set<string>();
        for (const c of connections ?? []) {
          const other =
            c.requester_id === userId ? c.addressee_id : c.requester_id;
          if (other) connectedUserIds.add(other);
        }

        log.info(
          { ...logCtx, userId, connectionCount: connectedUserIds.size },
          "Fetched accepted connections"
        );

        if (connectedUserIds.size === 0) {
          metrics.incQueueProcessed();
          channel.ack(msg);
          return;
        }

        // 2. Fetch users with h3 data for connected users
        const { data: users, error: usersError } = await supabase
          .from("users")
          .select("id, h3_cell, h3_neighbors")
          .in("id", Array.from(connectedUserIds));

        if (usersError) {
          log.error(
            { ...logCtx, userId, err: usersError.message },
            "Failed to fetch users"
          );
          metrics.incQueueFailed();
          channel.nack(msg, false, true);
          return;
        }

        const callerHexSet = new Set([centerHex, ...neighborHexes]);

        for (const target of users ?? []) {
          const targetId = target.id as string;
          const targetCenter = target.h3_cell as string | null;
          const targetNeighbors = (target.h3_neighbors as string[] | null) ?? [];

          const { overlaps, overlapHex } = hexesOverlap(
            centerHex,
            neighborHexes,
            targetCenter,
            targetNeighbors
          );

          if (!overlaps || !overlapHex) continue;

          const [userA, userB] = getSortedPair(userId, targetId);

          // 3. Check 24h dedup
          const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const { data: recentNotifications, error: notifError } = await supabase
            .from("notifications")
            .select("id")
            .eq("user_a_id", userA)
            .eq("user_b_id", userB)
            .eq("notification_type", "hex_overlap")
            .gte("created_at", twentyFourHoursAgo)
            .limit(1);

          if (notifError) {
            log.error(
              { ...logCtx, callerId: userId, otherUserId: targetId, err: notifError.message },
              "Failed to check notifications"
            );
            continue;
          }

          if (recentNotifications && recentNotifications.length > 0) {
            log.info(
              {
                ...logCtx,
                event: "overlap_evaluated",
                callerId: userId,
                otherUserId: targetId,
                hasRecentNotification: true,
                notificationEnqueued: false,
              },
              "Skipping pair: notification sent within 24h"
            );
            continue;
          }

          // 4. Insert notification row
          const { error: insertError } = await supabase.from("notifications").insert({
            user_a_id: userA,
            user_b_id: userB,
            initiator_id: userId,
            overlap_hex: overlapHex,
            notification_type: "hex_overlap",
          });

          if (insertError) {
            log.error(
              { ...logCtx, callerId: userId, otherUserId: targetId, err: insertError.message },
              "Failed to insert notification"
            );
            continue;
          }

          // 5. Publish two notification.hex_overlap messages
          const workerLog = {
            info: (obj: object, msg?: string) => log.info(obj, msg),
            error: (obj: object, msg?: string) => log.error(obj, msg),
          };

          try {
            await publishHexOverlapNotification(
              {
                recipientUserId: targetId,
                otherUserId: userId,
                overlapHex,
                notificationType: "hex_overlap",
                requestId,
              },
              workerLog
            );
            await publishHexOverlapNotification(
              {
                recipientUserId: userId,
                otherUserId: targetId,
                overlapHex,
                notificationType: "hex_overlap",
                requestId,
              },
              workerLog
            );
          } catch (publishErr) {
            log.error(
              {
                ...logCtx,
                callerId: userId,
                otherUserId: targetId,
                err: publishErr,
              },
              "Failed to publish notification events"
            );
            metrics.incQueueFailed();
            channel.nack(msg, false, true);
            return;
          }

          metrics.incProximityMatches();
          log.info(
            {
              ...logCtx,
              event: "overlap_evaluated",
              callerId: userId,
              otherUserId: targetId,
              hasRecentNotification: false,
              notificationEnqueued: true,
            },
            "Notification sent for overlapping pair"
          );
        }

        metrics.incQueueProcessed();
        channel.ack(msg);
      } catch (err) {
        log.error(
          { ...logCtx, err },
          "Error processing location.updated message"
        );
        metrics.incQueueFailed();
        channel.nack(msg, false, true);
      }
    },
    { noAck: false }
  );

  connection.on("error", (err) => {
    log.error({ event: "rabbit_connection_error", err }, "RabbitMQ connection error");
  });
  connection.on("close", () => {
    log.warn({ event: "rabbit_connection_closed" }, "RabbitMQ connection closed");
  });
}

main().catch((err: Error) => {
  log.error({ err }, "Worker failed to start");
  process.exit(1);
});
