import "dotenv/config";
import apn from "apn";
import amqp from "amqplib";
import pino from "pino";
import { config } from "../config.js";
import { supabase } from "../lib/supabase.js";
import type { NewMessageEvent } from "../lib/rabbitmq.js";
import { createWorkerMetrics } from "../lib/workerMetrics.js";

const log = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: {
    level: (label) => ({ level: label }),
  },
});

let apnProvider: apn.Provider | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getApnProvider(): apn.Provider | null {
  if (apnProvider) return apnProvider;
  if (!config.apnsKeyPath || !config.apnsKeyId || !config.apnsTeamId || !config.apnsBundleId) {
    log.warn(
      { event: "apns_config_missing" },
      "APNs not configured; message notifications will be skipped"
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

async function getSenderName(userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("users")
    .select("first_name")
    .eq("id", userId)
    .single();

  if (error || !data?.first_name) {
    return "Someone";
  }
  return data.first_name as string;
}

async function sendMessageNotification(
  event: NewMessageEvent
): Promise<{ sent: boolean; reason?: string; statusCode?: number }> {
  const provider = getApnProvider();
  if (!provider) {
    return { sent: false, reason: "apns_not_configured" };
  }

  const deviceToken = await getDeviceToken(event.recipientId);
  if (!deviceToken) {
    log.info(
      {
        event: "notification_skipped",
        userId: event.recipientId,
        reason: "no_device_token",
      },
      "No device token for message recipient"
    );
    return { sent: false, reason: "no_device_token" };
  }

  const senderName = await getSenderName(event.senderId);

  const note = new apn.Notification();
  note.expiry = Math.floor(Date.now() / 1000) + 3600;
  note.sound = "default";

  // Build alert message - Always generic for E2EE to maintain privacy
  if (event.attachmentType) {
    const mediaType = event.attachmentType.startsWith("image/") ? "an image"
      : event.attachmentType.startsWith("video/") ? "a video"
      : "a file";
    note.alert = { title: senderName, body: `Sent you ${mediaType}` };
  } else {
    note.alert = { title: senderName, body: "Sent you a message" };
  }

  note.payload = {
    type: "new_message",
    conversationId: event.conversationId,
    messageId: event.messageId,
    senderId: event.senderId,
    envelope: event.envelope,
  };

  try {
    const result = await provider.send(note, deviceToken);

    if (result.failed.length > 0) {
      const failure = result.failed[0];
      const rawStatus =
        failure?.response && "status" in failure.response
          ? (failure.response as { status: number }).status
          : undefined;
      log.error(
        {
          event: "notification_failed",
          userId: event.recipientId,
          provider: "apns",
          statusCode: rawStatus,
          messageId: event.messageId,
        },
        "APNs delivery failed for message notification"
      );
      const resultPayload: { sent: boolean; reason?: string; statusCode?: number } =
        { sent: false, reason: "delivery_failed" };
      if (typeof rawStatus === "number") {
        resultPayload.statusCode = rawStatus;
      }
      return resultPayload;
    }

    log.info(
      {
        event: "notification_sent",
        userId: event.recipientId,
        type: "new_message",
        provider: "apns",
        messageId: event.messageId,
      },
      "Message push notification sent"
    );
    return { sent: true };
  } catch (err) {
    log.error(
      {
        event: "notification_error",
        userId: event.recipientId,
        provider: "apns",
        messageId: event.messageId,
      },
      "Error sending message push notification"
    );
    return { sent: false, reason: "send_error" };
  }
}

async function main() {
  const metrics = createWorkerMetrics("messaging");
  const metricsPort = Number(process.env.METRICS_PORT) || 9093;
  metrics.startMetricsServer(metricsPort);
  log.info(
    { event: "worker_start", queue: config.messagingQueue, metricsPort },
    "Messaging worker starting"
  );

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
  await channel.assertQueue(config.messagingQueue, { durable: true });
  await channel.bindQueue(
    config.messagingQueue,
    config.rabbitExchange,
    "messaging.*"
  );

  await channel.consume(
    config.messagingQueue,
    async (msg: amqp.ConsumeMessage | null) => {
      if (!msg) return;

      const requestId =
        (msg.properties.headers?.requestId as string | undefined) ?? `worker-${Date.now()}`;
      const logCtx = { requestId, event: "messaging_worker_received" };

      try {
        const payload = JSON.parse(msg.content.toString()) as unknown;

        if (
          !payload ||
          typeof payload !== "object" ||
          !("recipientId" in payload) ||
          !("messageId" in payload) ||
          !("conversationId" in payload)
        ) {
          log.warn({ ...logCtx, payload }, "Invalid messaging payload");
          metrics.incQueueProcessed();
          channel.ack(msg);
          return;
        }

        const event = payload as NewMessageEvent;

        log.info(
          {
            ...logCtx,
            recipientId: event.recipientId,
            senderId: event.senderId,
            messageId: event.messageId,
            conversationId: event.conversationId,
          },
          "Processing message notification"
        );

        const maxAttempts = 3;
        let attempt = 1;
        let delivered = false;

        while (attempt <= maxAttempts) {
          const { sent, reason, statusCode } = await sendMessageNotification(event);

          if (sent) {
            metrics.incNotificationsSent();
            if (attempt > 1) {
              log.info(
                {
                  ...logCtx,
                  recipientId: event.recipientId,
                  messageId: event.messageId,
                  attempt,
                  maxAttempts,
                },
                "Message notification sent after retries"
              );
            }
            delivered = true;
            break;
          }

          const isPermanentFailure =
            reason === "no_device_token" ||
            reason === "apns_not_configured" ||
            (reason === "delivery_failed" &&
              typeof statusCode === "number" &&
              statusCode >= 400 &&
              statusCode < 500 &&
              statusCode !== 429);

          const shouldRetry = !isPermanentFailure && attempt < maxAttempts;

          if (!shouldRetry) {
            metrics.incNotificationsFailed();
            log.info(
              {
                ...logCtx,
                recipientId: event.recipientId,
                messageId: event.messageId,
                attempt,
                maxAttempts,
                reason,
                statusCode,
              },
              "Message notification skipped after attempts"
            );
            break;
          }

          const delayMs = 500 * 2 ** (attempt - 1);
          log.info(
            {
              ...logCtx,
              recipientId: event.recipientId,
              messageId: event.messageId,
              attempt,
              maxAttempts,
              delayMs,
              reason,
              statusCode,
            },
            "Scheduling message notification retry"
          );
          await sleep(delayMs);
          attempt += 1;
        }

        if (!delivered) {
          // Already counted in metrics and logs above.
        }

        metrics.incQueueProcessed();
        channel.ack(msg);
      } catch (err) {
        log.error(
          { ...logCtx, err },
          "Error processing messaging notification"
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
  log.error({ err }, "Messaging worker failed to start");
  process.exit(1);
});
