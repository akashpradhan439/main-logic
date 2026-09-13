import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../lib/db.js";
import {
  publishLocationUpdated,
  scheduleLocationUpdatedRetry,
} from "../lib/rabbitmq.js";
import {
  locationUpdatesTotal,
  locationUpdatesPublishFailuresTotal,
} from "../lib/metrics.js";
import { verifyAccessToken } from "../shared/auth.js";
import { AuthError } from "../shared/auth.js";
import { getHexRingDistance, isValidResolution, getHexDisk } from "../shared/h3.js";

const UpdateHexSchema = z.object({
  center_hex: z.string().min(1),
  neighbor_hexes: z.array(z.string()).optional(), // Now optional as we calculate it on server
});

export default async function locationRoutes(app: FastifyInstance) {
  app.post("/location/hex", async (req, reply) => {
    const requestId = req.id;
    const log = req.log;
    const requestStart = process.hrtime.bigint();

    try {
      // 1️⃣ Verify token
      let userId: string;
      try {
        const user = verifyAccessToken(req.headers.authorization);
        userId = user.sub;
      } catch (err) {
        if (err instanceof AuthError) {
          log.info({ event: "auth_failed", requestId }, "Authentication failed");
          return reply.status(err.status).send({
            success: false,
            error: req.t("common.errors.auth_required"),
          });
        }
        throw err;
      }

      log.info(
        { event: "location_update_start", userId, requestId },
        "location update received"
      );

      // 2️⃣ Validate body
      const parsed = UpdateHexSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.flatten().fieldErrors,
        });
      }

      const { center_hex } = parsed.data;

      // 2.1 Enforce resolution 4
      if (!isValidResolution(center_hex, 4)) {
        log.warn({ event: "invalid_resolution", userId, center_hex, requestId }, "Invalid hex resolution received");
        return reply.status(400).send({
          success: false,
          error: req.t("common.errors.invalid_parameter"),
        });
      }

      // 2.2 Calculate 2rd ring disk (radius 2)
      // Radius 2 includes center + 1 ring + 2nd ring (19 hexes total)
      const disk = getHexDisk(center_hex, 2);
      const neighbor_hexes = disk.filter(h => h !== center_hex);

      // 3️⃣ Fetch previous location (timed)
      const fetchStart = process.hrtime.bigint();
      let existingUser: { h3_cell: string | null; h3_neighbors: string[] | null } | null = null;
      try {
        const { rows } = await pool.query(
          "SELECT h3_cell, h3_neighbors FROM users WHERE id = $1",
          [userId]
        );
        existingUser = rows[0] ?? null;
      } catch (dbErr) {
        const fetchDurationMs =
          Number(process.hrtime.bigint() - fetchStart) / 1_000_000;
        log.error(
          {
            event: "location_update_failure",
            userId,
            requestId,
            durationMs: fetchDurationMs,
            fetchError: { message: (dbErr as Error).message },
          },
          "Failed to fetch user for location update"
        );
        return reply.status(500).send({
          success: false,
          error: req.t("common.errors.unable_to_process"),
        });
      }
      const fetchDurationMs =
        Number(process.hrtime.bigint() - fetchStart) / 1_000_000;

      if (fetchDurationMs > 200) {
        log.warn(
          {
            event: "db_query_slow",
            operation: "fetch_user_location",
            userId,
            requestId,
            durationMs: fetchDurationMs,
          },
          "Slow DB query detected while fetching user location"
        );
      }

      const previousCenterHex = (existingUser?.h3_cell as string | null) ?? null;
      const previousNeighborHexes = (existingUser?.h3_neighbors as string[] | null) ?? [];

      // 4️⃣ Compute movement distance
      const distance = getHexRingDistance(previousCenterHex, center_hex);
      const shouldCheckNotifications =
        previousCenterHex === null || distance >= 1;

      log.info(
        {
          event: "location_movement_computed",
          userId,
          requestId,
          hasPreviousLocation: previousCenterHex !== null,
          distance,
          shouldCheckNotifications,
        },
        "movement computed"
      );

      // 5️⃣ Save to users table (timed)
      const updateStart = process.hrtime.bigint();
      try {
        await pool.query(
          "UPDATE users SET h3_cell = $1, h3_neighbors = $2 WHERE id = $3",
          [center_hex, neighbor_hexes, userId]
        );
      } catch (dbErr) {
        const updateDurationMs =
          Number(process.hrtime.bigint() - updateStart) / 1_000_000;
        log.error(
          {
            event: "location_update_failure",
            userId,
            requestId,
            durationMs: updateDurationMs,
          },
          "Failed to update hex location"
        );
        return reply.status(500).send({
          success: false,
          error: req.t("common.errors.unable_to_process"),
        });
      }
      const updateDurationMs =
        Number(process.hrtime.bigint() - updateStart) / 1_000_000;

      if (updateDurationMs > 200) {
        log.warn(
          {
            event: "db_query_slow",
            operation: "update_user_location",
            userId,
            requestId,
            durationMs: updateDurationMs,
          },
          "Slow DB query detected while updating user location"
        );
      }

      // 6️⃣ Publish location.updated event if movement >= 1 ring (timed)
      if (shouldCheckNotifications) {
        const publishStart = process.hrtime.bigint();
        const eventPayload = {
          userId,
          centerHex: center_hex,
          neighborHexes: neighbor_hexes,
          previousCenterHex,
          previousNeighborHexes:
            previousNeighborHexes.length > 0 ? previousNeighborHexes : null,
          updatedAt: new Date().toISOString(),
          requestId,
        };

        try {
          const published = await publishLocationUpdated(eventPayload, log);
          const publishDurationMs =
            Number(process.hrtime.bigint() - publishStart) / 1_000_000;

          if (published) {
            log.info(
              {
                event: "location_update_publish_success",
                userId,
                requestId,
                durationMs: publishDurationMs,
              },
              "location.updated event published"
            );

            locationUpdatesTotal.inc();
          } else {
            log.error(
              {
                event: "location_update_publish_failure",
                userId,
                requestId,
                durationMs: publishDurationMs,
              },
              "location.updated event publish returned false"
            );
            locationUpdatesPublishFailuresTotal.inc();
            scheduleLocationUpdatedRetry(eventPayload, log);
          }
        } catch (publishErr) {
          const publishDurationMs =
            Number(process.hrtime.bigint() - publishStart) / 1_000_000;

          log.error(
            {
              event: "location_update_publish_failure",
              userId,
              requestId,
              durationMs: publishDurationMs,
            },
            "Failed to publish location.updated event"
          );
          locationUpdatesPublishFailuresTotal.inc();
          scheduleLocationUpdatedRetry(eventPayload, log);
        }
      }

      const requestDurationMs =
        Number(process.hrtime.bigint() - requestStart) / 1_000_000;

      log.info(
        {
          event: "location_update_success",
          userId,
          requestId,
          durationMs: requestDurationMs,
        },
        "location update completed"
      );
      return reply.status(200).send({ success: true });
    } catch (err) {
      const requestDurationMs =
        Number(process.hrtime.bigint() - requestStart) / 1_000_000;

      log.error(
        { event: "location_update_error", requestId, durationMs: requestDurationMs, err },
        "Unexpected error in location update"
      );
      return reply.status(500).send({
        success: false,
        error: req.t("common.errors.unable_to_process"),
      });
    }
  });
}
