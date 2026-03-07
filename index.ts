import dotenv from "dotenv";
dotenv.config();

import Fastify from "fastify";

const port = Number(process.env.PORT) || 3000;

async function main() {
  const { default: registerRoutes } = await import("./routes/index.js");
  const app = Fastify({ logger: true });

  await registerRoutes(app);

  const shutdown = async (signal: string) => {
    app.log.info({ event: "shutdown", signal }, "Shutting down gracefully");
    try {
      await app.close();
      app.log.info("Server closed");
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "Error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await app.listen({ port, host: "0.0.0.0" });
    app.log.info({ event: "server_start", port }, "Server listening");
  } catch (err) {
    app.log.error({ err }, "Failed to start server");
    process.exit(1);
  }
}

main();
