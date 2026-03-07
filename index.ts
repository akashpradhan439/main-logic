import dotenv from "dotenv";
dotenv.config();

import Fastify from "fastify";

const port = Number(process.env.PORT) || 3000;

async function main() {
  const { default: registerRoutes } = await import("./routes/index.js");
  const app = Fastify({ logger: true });

  await registerRoutes(app);

  try {
    await app.listen({ port, host: "0.0.0.0" });
    app.log.info({ event: "server_start", port }, "Server listening");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
