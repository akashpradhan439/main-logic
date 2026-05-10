import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyAccessToken, AuthError } from "./_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface UpdateLocationRequest {
  h3_cell: string;       // e.g. "8928308280fffff"
  h3_neighbors: string[]; // kRing(h3_cell, 1) — 7 cells including center
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Verify JWT
    const user = await verifyAccessToken(req);
    const userId = user.sub;

    // 2. Parse body
    const body: UpdateLocationRequest = await req.json();
    const { h3_cell, h3_neighbors } = body;

    if (!h3_cell || !Array.isArray(h3_neighbors) || h3_neighbors.length === 0) {
      return Response.json(
        { success: false, error: "h3_cell and h3_neighbors are required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 3. Update user's H3 location
    const { error: updateError } = await supabase
      .from("users")
      .update({
        h3_cell,
        h3_neighbors,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId);

    if (updateError) {
      console.error("[update-location] Failed to update location:", updateError.message);
      return Response.json(
        { success: false, error: "Failed to update location" },
        { status: 500, headers: corsHeaders }
      );
    }

    // 4. Check for accepted connections in same H3 area
    const { data: matches, error: rpcError } = await supabase.rpc("check_connection_in_h3", {
      uid: userId,
      h3_cells: h3_neighbors,
    });

    if (rpcError) {
      console.error("[update-location] RPC error:", rpcError.message);
      // Location was saved successfully — don't fail the request over matching error
      return Response.json(
        { success: true, locationUpdated: true, matchCheckFailed: true },
        { status: 200, headers: corsHeaders }
      );
    }

    const hasMatch = Array.isArray(matches) && matches.length > 0;

    // 5. Return result — push notifications to be added in next phase
    return Response.json(
      {
        success: true,
        locationUpdated: true,
        hasConnectionNearby: hasMatch,
        nearbyConnections: hasMatch
          ? matches.map((m: { matched_user_id: string; h3_cell: string }) => ({
              userId: m.matched_user_id,
              h3_cell: m.h3_cell,
            }))
          : [],
      },
      { status: 200, headers: corsHeaders }
    );

  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";

    if (err instanceof AuthError) {
      return Response.json(
        { success: false, error: message },
        { status: err.status, headers: corsHeaders }
      );
    }

    console.error("[update-location] Unhandled error:", message);
    return Response.json(
      { success: false, error: "Internal server error" },
      { status: 500, headers: corsHeaders }
    );
  }
});
