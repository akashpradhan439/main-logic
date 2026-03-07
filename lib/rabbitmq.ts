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
