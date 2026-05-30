import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { verifyAccessToken, AuthError } from "../shared/auth.js";
import { config } from "../config.js";
import {
  runSwarm,
  resumeSwarm,
  loadSwarmState,
} from "../lib/agentSwarm.js";
import { agentLLMClient } from "../lib/azureClient.js";

const ApproveSchema = z.object({
  approved: z.boolean(),
  feedback: z.string().max(500).optional(),
}).strict();

export type SwarmRouteDeps = {
  supabase: typeof supabase;
  verifyAccessToken: typeof verifyAccessToken;
  AuthError: typeof AuthError;
  foursquareApiKey: string;
};

export function createSwarmRoutes(overrides: Partial<SwarmRouteDeps> = {}) {
  const deps: SwarmRouteDeps = {
    supabase,
    verifyAccessToken,
    AuthError,
    foursquareApiKey: config.foursquareApiKey,
    ...overrides,
  };

  return async function swarmRoutes(app: FastifyInstance) {
    const { supabase, verifyAccessToken, AuthError, foursquareApiKey } = deps;

    // ─── POST /swarm/meetup ───────────────────────────────────────────────────
    app.post("/swarm/meetup", async (req, reply) => {
      const log = req.log;
      try {
        let userId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          userId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            return reply.status(err.status).send({ success: false, error: req.t("common.errors.auth_required") });
          }
          throw err;
        }

        log.info({ event: "swarm_meetup_start", userId }, "Starting meetup swarm");

        const state = await runSwarm({ userId, taskType: "meetup", supabase, foursquareApiKey });

        log.info(
          { event: "swarm_meetup_done", userId, runId: state.runId, phase: state.phase, attempts: state.attempts, provider: state.llmProvider },
          "Meetup swarm completed"
        );

        return reply.status(200).send({
          success: true,
          runId: state.runId,
          phase: state.phase,
          llmProvider: state.llmProvider,
          result: state.finalResult,
          humanApprovalRequired: state.humanApprovalRequired,
          supervisor: {
            approved: state.critiqueResult?.approved ?? false,
            attempts: state.attempts,
            lastFeedback: state.critiqueResult?.feedback ?? "",
          },
          trace: state.trace,
        });
      } catch (err) {
        log.error({ event: "swarm_meetup_error", err }, "Swarm meetup error");
        return reply.status(500).send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });

    // ─── POST /swarm/connections ───────────────────────────────────────────────
    app.post("/swarm/connections", async (req, reply) => {
      const log = req.log;
      try {
        let userId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          userId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            return reply.status(err.status).send({ success: false, error: req.t("common.errors.auth_required") });
          }
          throw err;
        }

        log.info({ event: "swarm_connections_start", userId }, "Starting connections swarm");

        const state = await runSwarm({ userId, taskType: "connections", supabase, foursquareApiKey });

        log.info(
          { event: "swarm_connections_done", userId, runId: state.runId, phase: state.phase, attempts: state.attempts },
          "Connections swarm completed"
        );

        return reply.status(200).send({
          success: true,
          runId: state.runId,
          phase: state.phase,
          llmProvider: state.llmProvider,
          result: state.finalResult,
          humanApprovalRequired: state.humanApprovalRequired,
          supervisor: {
            approved: state.critiqueResult?.approved ?? false,
            attempts: state.attempts,
            lastFeedback: state.critiqueResult?.feedback ?? "",
          },
          trace: state.trace,
        });
      } catch (err) {
        log.error({ event: "swarm_connections_error", err }, "Swarm connections error");
        return reply.status(500).send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });

    // ─── GET /swarm/trace/:runId ──────────────────────────────────────────────
    app.get("/swarm/trace/:runId", async (req, reply) => {
      const log = req.log;
      try {
        let userId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          userId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            return reply.status(err.status).send({ success: false, error: req.t("common.errors.auth_required") });
          }
          throw err;
        }

        const { runId } = req.params as { runId: string };
        const state = await loadSwarmState(runId);

        if (!state) {
          return reply.status(404).send({ success: false, error: "run_not_found" });
        }
        if (state.userId !== userId) {
          return reply.status(403).send({ success: false, error: "forbidden" });
        }

        log.info({ event: "swarm_trace_fetched", userId, runId }, "Trace fetched");

        return reply.status(200).send({
          success: true,
          runId: state.runId,
          taskType: state.taskType,
          phase: state.phase,
          llmProvider: state.llmProvider,
          attempts: state.attempts,
          humanApprovalRequired: state.humanApprovalRequired,
          trace: state.trace,
          plan: state.plan,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
          error: state.error,
        });
      } catch (err) {
        log.error({ event: "swarm_trace_error", err }, "Trace fetch error");
        return reply.status(500).send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });

    // ─── POST /swarm/:runId/approve (Human-in-the-loop) ───────────────────────
    app.post("/swarm/:runId/approve", async (req, reply) => {
      const log = req.log;
      try {
        let userId: string;
        try {
          const user = verifyAccessToken(req.headers.authorization);
          userId = user.sub;
        } catch (err) {
          if (err instanceof AuthError) {
            return reply.status(err.status).send({ success: false, error: req.t("common.errors.auth_required") });
          }
          throw err;
        }

        const { runId } = req.params as { runId: string };
        const parsed = ApproveSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.status(400).send({ success: false, error: parsed.error.flatten().fieldErrors });
        }

        // Ownership check
        const existingState = await loadSwarmState(runId);
        if (!existingState) {
          return reply.status(404).send({ success: false, error: "run_not_found" });
        }
        if (existingState.userId !== userId) {
          return reply.status(403).send({ success: false, error: "forbidden" });
        }

        const state = await resumeSwarm({
          runId,
          approved: parsed.data.approved,
          ...(parsed.data.feedback !== undefined ? { feedback: parsed.data.feedback } : {}),
          supabase,
          foursquareApiKey,
        });

        log.info(
          { event: "swarm_human_review", userId, runId, approved: parsed.data.approved },
          "Human review processed"
        );

        return reply.status(200).send({
          success: true,
          runId: state.runId,
          phase: state.phase,
          result: state.finalResult,
          trace: state.trace,
        });
      } catch (err) {
        log.error({ event: "swarm_approve_error", err }, "Approval error");
        return reply.status(500).send({ success: false, error: req.t("common.errors.unable_to_process") });
      }
    });

    // ─── GET /swarm/status (health + provider info) ───────────────────────────
    app.get("/swarm/status", async (_req, reply) => {
      return reply.status(200).send({
        success: true,
        llmProvider: agentLLMClient.provider,
        azureConfigured: !!config.azureOpenAIEndpoint && !!config.azureOpenAIKey,
        deployment: config.azureOpenAIDeployment,
      });
    });
  };
}

export default createSwarmRoutes();
