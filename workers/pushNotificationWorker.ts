import "dotenv/config";
import apn from "apn";
import amqp from "amqplib";
import pino from "pino";
import { config } from "../config.js";
import { supabase } from "../lib/supabase.js";
import type { HexOverlapNotificationEvent } from "../lib/rabbitmq.js";
import { createWorkerMetrics } from "../lib/workerMetrics.js";

const log = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: {
    level: (label) => ({ level: label }),
  },
});

let apnProvider: apn.Provider | null = null;

function getApnProvider(): apn.Provider | null {
  if (apnProvider) return apnProvider;
  if (!config.apnsKeyPath || !config.apnsKeyId || !config.apnsTeamId || !config.apnsBundleId) {
    log.warn(
      { event: "apns_config_missing" },
      "APNs not configured; notifications will be skipped"
    );
    return null;
  }
  try {
    apnProvider = new apn.Provider({
      token: {
        key: config.apnsKeyPath,
        keyId: config.apnsKeyId,
        teamId: config.apnsTeamId,
      },
      production: config.apnsProduction,
    });
    return apnProvider;
  } catch (err) {
    log.error(
      { event: "apns_provider_init_failed" },
      "Failed to initialize APNs provider"
    );
    return null;
  }
}

async function getDeviceToken(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("users")
    .select("device_token")
    .eq("id", userId)
    .single();

  if (error || !data?.device_token) {
    return null;
  }
  return data.device_token as string;
}

function buildHexOverlapAlert(recipientUserId: string, otherUserId: string): string {
  return "Someone you know is nearby";
}

async function sendHexOverlapNotification(
  event: HexOverlapNotificationEvent
): Promise<{ sent: boolean; reason?: string }> {
  const provider = getApnProvider();
  if (!provider) {
    return { sent: false, reason: "apns_not_configured" };
  }

  const deviceToken = await getDeviceToken(event.recipientUserId);
  if (!deviceToken) {
    log.info(
      {
        event: "notification_skipped",
        userId: event.recipientUserId,
        reason: "no_device_token",
      },
      "No device token for user"
    );
    return { sent: false, reason: "no_device_token" };
  }

  const note = new apn.Notification();
  note.expiry = Math.floor(Date.now() / 1000) + 3600;
  note.sound = "default";
  note.alert = buildHexOverlapAlert(event.recipientUserId, event.otherUserId);
  note.topic = config.apnsBundleId;
  note.payload = { type: "hex_overlap", otherUserId: event.otherUserId };

  try {
    const result = await provider.send(note, deviceToken);

    if (result.failed.length > 0) {
      const failure = result.failed[0];
      const statusCode = failure?.response && "status" in failure.response
        ? (failure.response as { status: number }).status
        : undefined;
      log.error(
        {
          event: "notification_failed",
          userId: event.recipientUserId,
          provider: "apns",
          statusCode,
        },
        "APNs delivery failed"
      );
      return { sent: false, reason: "delivery_failed" };
    }

    log.info(
      {
        event: "notification_sent",
        userId: event.recipientUserId,
        type: "hex_overlap",
        provider: "apns",
      },
      "Push notification sent"
    );
    return { sent: true };
  } catch (err) {
    log.error(
      {
        event: "notification_error",
        userId: event.recipientUserId,
        provider: "apns",
      },
      "Error sending push notification"
    );
    return { sent: false, reason: "send_error" };
  }
}

async function main() {
  const metrics = createWorkerMetrics("notifications");
  const metricsPort = Number(process.env.METRICS_PORT) || 9092;
  metrics.startMetricsServer(metricsPort);
  log.info(
    { event: "worker_start", queue: config.pushNotificationsQueue, metricsPort },
    "Push notification worker starting"
  );

  const connection = await amqp.connect(config.rabbitUrl);
  const channel = await connection.createChannel();

  await channel.assertExchange(config.rabbitExchange, "topic", { durable: true });
  await channel.assertQueue(config.pushNotificationsQueue, { durable: true });
  await channel.bindQueue(
    config.pushNotificationsQueue,
    config.rabbitExchange,
    "notification.*"
  );

  await channel.consume(
    config.pushNotificationsQueue,
    async (msg) => {
      if (!msg) return;

      const requestId =
        (msg.properties.headers?.requestId as string | undefined) ?? `worker-${Date.now()}`;
      const logCtx = { requestId, event: "notification_received" };

      try {
        const payload = JSON.parse(msg.content.toString()) as unknown;

        if (
          !payload ||
          typeof payload !== "object" ||
          !("recipientUserId" in payload) ||
          !("notificationType" in payload)
        ) {
          log.warn({ ...logCtx, payload }, "Invalid notification payload");
          metrics.incQueueProcessed();
          channel.ack(msg);
          return;
        }

        const event = payload as HexOverlapNotificationEvent;

        log.info(
          {
            ...logCtx,
            userId: event.recipientUserId,
            type: event.notificationType,
            provider: "apns",
          },
          "Processing notification"
        );

        if (event.notificationType === "hex_overlap") {
          const { sent } = await sendHexOverlapNotification(event);
          if (sent) {
            metrics.incNotificationsSent();
          } else {
            metrics.incNotificationsFailed();
            log.info(
              {
                ...logCtx,
                userId: event.recipientUserId,
                notificationEnqueued: false,
              },
              "Notification skipped"
            );
          }
        } else {
          log.warn(
            { ...logCtx, type: event.notificationType },
            "Unknown notification type"
          );
        }

        metrics.incQueueProcessed();
        channel.ack(msg);
      } catch (err) {
        log.error(
          { ...logCtx, err },
          "Error processing notification message"
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
  log.error({ err }, "Push notification worker failed to start");
  process.exit(1);
});
