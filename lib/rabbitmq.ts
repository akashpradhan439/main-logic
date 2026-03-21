import amqp, { type Channel, type ChannelModel } from "amqplib";
import { config } from "../config.js";

export interface LocationUpdatedEvent {
  userId: string;
  centerHex: string;
  neighborHexes: string[];
  previousCenterHex: string | null;
  previousNeighborHexes: string[] | null;
  updatedAt: string;
  requestId?: string;
}

export interface HexOverlapNotificationEvent {
  recipientUserId: string;
  otherUserId: string;
  overlapHex: string;
  notificationType: "hex_overlap";
  requestId?: string;
}

export interface NewMessageEvent {
  conversationId: string;
  messageId: string;
  senderId: string;
  recipientId: string;
  content: string | null;
  attachmentUrl: string | null;
  attachmentType: string | null;
  createdAt: string;
  requestId?: string;
}

let connection: ChannelModel | null = null;
let channel: Channel | null = null;

export async function getChannel(): Promise<Channel> {
  if (channel != null) {
    return channel;
  }
  try {
    connection = await amqp.connect(config.rabbitUrl);
    channel = await connection.createChannel();
    await channel.assertExchange(config.rabbitExchange, "topic", { durable: true });
    connection.connection.on("error", () => {
      connection = null;
      channel = null;
    });
    connection.connection.on("close", () => {
      connection = null;
      channel = null;
    });
    return channel;
  } catch (err) {
    connection = null;
    channel = null;
    throw err;
  }
}

export async function publishLocationUpdated(
  event: LocationUpdatedEvent,
  log: { info: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void }
): Promise<boolean> {
  try {
    const ch = await getChannel();
    const payload = Buffer.from(JSON.stringify(event));
    const published = ch.publish(
      config.rabbitExchange,
      config.locationUpdatedRoutingKey,
      payload,
      {
        persistent: true,
        contentType: "application/json",
        headers: event.requestId ? { requestId: event.requestId } : undefined,
      }
    );
    if (published) {
      log.info(
        {
          event: "rabbit_publish",
          routingKey: config.locationUpdatedRoutingKey,
          userId: event.userId,
          requestId: event.requestId,
          success: true,
        },
        "location.updated published"
      );
      return true;
    }
    log.error(
      {
        event: "rabbit_publish",
        routingKey: config.locationUpdatedRoutingKey,
        userId: event.userId,
        success: false,
      },
      "Failed to publish location.updated"
    );
    return false;
  } catch (err) {
    log.error(
      {
        event: "rabbit_publish",
        routingKey: config.locationUpdatedRoutingKey,
        userId: event.userId,
        success: false,
      },
      "RabbitMQ publish error"
    );
    throw err;
  }
}

export function scheduleLocationUpdatedRetry(
  event: LocationUpdatedEvent,
  log: { info: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void },
  attempt = 1,
  maxAttempts = 3,
  baseDelayMs = 500
): void {
  if (attempt > maxAttempts) {
    log.error(
      {
        event: "location_update_publish_retry_exhausted",
        routingKey: config.locationUpdatedRoutingKey,
        userId: event.userId,
        requestId: event.requestId,
        attempt,
        maxAttempts,
      },
      "Exhausted retries for location.updated publish"
    );
    return;
  }

  const delayMs = baseDelayMs * 2 ** (attempt - 1);

  log.info(
    {
      event: "location_update_publish_retry_scheduled",
      routingKey: config.locationUpdatedRoutingKey,
      userId: event.userId,
      requestId: event.requestId,
      attempt,
      maxAttempts,
      delayMs,
    },
    "Scheduling retry for location.updated publish"
  );

  setTimeout(() => {
    publishLocationUpdated(event, log)
      .then((published) => {
        if (published) {
          log.info(
            {
              event: "location_update_publish_retry_success",
              routingKey: config.locationUpdatedRoutingKey,
              userId: event.userId,
              requestId: event.requestId,
              attempt,
            },
            "location.updated publish succeeded on retry"
          );
          return;
        }

        log.error(
          {
            event: "location_update_publish_retry_failed",
            routingKey: config.locationUpdatedRoutingKey,
            userId: event.userId,
            requestId: event.requestId,
            attempt,
          },
          "location.updated publish returned false on retry"
        );
        scheduleLocationUpdatedRetry(event, log, attempt + 1, maxAttempts, baseDelayMs);
      })
      .catch((err) => {
        log.error(
          {
            event: "location_update_publish_retry_error",
            routingKey: config.locationUpdatedRoutingKey,
            userId: event.userId,
            requestId: event.requestId,
            attempt,
            err,
          },
          "RabbitMQ publish error during retry"
        );
        scheduleLocationUpdatedRetry(event, log, attempt + 1, maxAttempts, baseDelayMs);
      });
  }, delayMs);
}

export async function publishHexOverlapNotification(
  event: HexOverlapNotificationEvent,
  log: { info: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void }
): Promise<boolean> {
  try {
    const ch = await getChannel();
    const payload = Buffer.from(JSON.stringify(event));
    const published = ch.publish(
      config.rabbitExchange,
      config.notificationRoutingKey,
      payload,
      {
        persistent: true,
        contentType: "application/json",
        headers: event.requestId ? { requestId: event.requestId } : undefined,
      }
    );
    if (published) {
      log.info(
        {
          event: "rabbit_publish",
          routingKey: config.notificationRoutingKey,
          recipientUserId: event.recipientUserId,
          otherUserId: event.otherUserId,
          requestId: event.requestId,
          success: true,
        },
        "notification.hex_overlap published"
      );
      return true;
    }
    log.error(
      {
        event: "rabbit_publish",
        routingKey: config.notificationRoutingKey,
        recipientUserId: event.recipientUserId,
        success: false,
      },
      "Failed to publish notification.hex_overlap"
    );
    return false;
  } catch (err) {
    log.error(
      {
        event: "rabbit_publish",
        routingKey: config.notificationRoutingKey,
        recipientUserId: event.recipientUserId,
        success: false,
      },
      "RabbitMQ publish error"
    );
    throw err;
  }
}

export async function publishNewMessage(
  event: NewMessageEvent,
  log: { info: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void }
): Promise<boolean> {
  try {
    const ch = await getChannel();
    const payload = Buffer.from(JSON.stringify(event));
    const published = ch.publish(
      config.rabbitExchange,
      config.messagingRoutingKey,
      payload,
      {
        persistent: true,
        contentType: "application/json",
        headers: event.requestId ? { requestId: event.requestId } : undefined,
      }
    );
    if (published) {
      log.info(
        {
          event: "rabbit_publish",
          routingKey: config.messagingRoutingKey,
          conversationId: event.conversationId,
          messageId: event.messageId,
          senderId: event.senderId,
          recipientId: event.recipientId,
          requestId: event.requestId,
          success: true,
        },
        "messaging.new published"
      );
      return true;
    }
    log.error(
      {
        event: "rabbit_publish",
        routingKey: config.messagingRoutingKey,
        conversationId: event.conversationId,
        messageId: event.messageId,
        success: false,
      },
      "Failed to publish messaging.new"
    );
    return false;
  } catch (err) {
    log.error(
      {
        event: "rabbit_publish",
        routingKey: config.messagingRoutingKey,
        conversationId: event.conversationId,
        messageId: event.messageId,
        success: false,
      },
      "RabbitMQ publish error for messaging.new"
    );
    throw err;
  }
}

export async function closeRabbitMQ(): Promise<void> {
  if (channel != null) {
    await channel.close().catch(() => {});
    channel = null;
  }
  if (connection != null) {
    await connection.close().catch(() => {});
    connection = null;
  }
}
