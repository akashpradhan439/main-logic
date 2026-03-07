import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { publishLocationUpdated } from "../lib/rabbitmq.js";
import { locationUpdatesTotal } from "../lib/metrics.js";
import { verifyAccessToken } from "../shared/auth.js";
import { AuthError } from "../shared/auth.js";
import { getHexRingDistance } from "../shared/h3.js";

const UpdateHexSchema = z.object({
  center_hex: z.string().min(1),
  neighbor_hexes: z.array(z.string()).min(1),
});

export default async function locationRoutes(app: FastifyInstance) {
  app.post("/location/hex", async (req, reply) => {
    const requestId = req.id;
    const log = req.log;

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
            error: "Authentication required",
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

      const { center_hex, neighbor_hexes } = parsed.data;

      // 3️⃣ Fetch previous location
      const { data: existingUser, error: fetchError } = await supabase
        .from("users")
        .select("h3_cell, h3_neighbors")
        .eq("id", userId)
        .single();

      if (fetchError) {
        log.error(
          { event: "location_update_failure", userId, requestId },
          "Failed to fetch user for location update"
        );
        return reply.status(500).send({
          success: false,
          error: "Unable to update location right now",
        });
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

      // 5️⃣ Save to users table
      const { error } = await supabase
        .from("users")
        .update({
          h3_cell: center_hex,
          h3_neighbors: neighbor_hexes,
        })
        .eq("id", userId);

      if (error) {
        log.error(
          { event: "location_update_failure", userId, requestId },
          "Failed to update hex location"
        );
        return reply.status(500).send({
          success: false,
          error: "Unable to update location right now",
        });
      }

      // 6️⃣ Publish location.updated event if movement >= 1 ring
      if (shouldCheckNotifications) {
        try {
          await publishLocationUpdated(
            {
              userId,
              centerHex: center_hex,
              neighborHexes: neighbor_hexes,
              previousCenterHex,
              previousNeighborHexes:
                previousNeighborHexes.length > 0 ? previousNeighborHexes : null,
              updatedAt: new Date().toISOString(),
              requestId,
            },
            log
          );
          locationUpdatesTotal.inc();
        } catch (publishErr) {
          log.error(
            {
              event: "location_update_publish_failure",
              userId,
              requestId,
            },
            "Failed to publish location.updated event"
          );
          return reply.status(500).send({
            success: false,
            error: "Unable to process location update right now",
          });
        }
      }

      log.info(
        { event: "location_update_success", userId, requestId },
        "location update completed"
      );
      return reply.status(200).send({ success: true });
    } catch (err) {
      log.error(
        { event: "location_update_error", requestId, err },
        "Unexpected error in location update"
      );
      return reply.status(500).send({
        success: false,
        error: "Unable to update location right now",
      });
    }
  });
}
