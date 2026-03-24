import { createClient } from "redis";
import { config } from "../config.js";

let redisClient: ReturnType<typeof createClient> | null = null;

export async function getRedisClient() {
  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  try {
    redisClient = createClient({
      url: config.redisUrl,
    });

    redisClient.on("error", (err) => {
      console.error("Redis Client Error", err);
      redisClient = null;
    });

    await redisClient.connect();
    return redisClient;
  } catch (err) {
    redisClient = null;
    throw err;
  }
}

export async function redisSet(
  key: string,
  value: string,
  ttl?: number
): Promise<void> {
  const client = await getRedisClient();
  if (ttl) {
    await client.setEx(key, ttl, value);
  } else {
    await client.set(key, value);
  }
}

export async function redisGet(key: string): Promise<string | null> {
  const client = await getRedisClient();
  return client.get(key);
}

export async function redisExists(key: string): Promise<boolean> {
  const client = await getRedisClient();
  const exists = await client.exists(key);
  return exists === 1;
}

export async function redisDel(key: string): Promise<void> {
  const client = await getRedisClient();
  await client.del(key);
}

/**
 * Creates a separate Redis client for Pub/Sub subscription.
 * Subscriber clients cannot be used for regular commands.
 */
export async function createRedisSubClient(): Promise<ReturnType<typeof createClient>> {
  const client = createClient({
    url: config.redisUrl,
  });

  client.on("error", (err) => {
    console.error("Redis Sub Client Error", err);
  });

  await client.connect();
  return client;
}
