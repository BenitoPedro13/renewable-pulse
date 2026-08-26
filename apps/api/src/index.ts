import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { pool } from "./db.js";
import { startLiveConsumer } from "./live/consumer.js";
import { LiveHub } from "./live/hub.js";
import { generationLatestRoute } from "./routes/generation-latest.js";
import { generationMixRoute } from "./routes/generation-mix.js";
import { generationShareRoute } from "./routes/generation-share.js";
import { liveRoute } from "./routes/live.js";
import { pipelineHealthRoute } from "./routes/pipeline-health.js";
import { plantsRoute } from "./routes/plants.js";
import { readingsRoute } from "./routes/readings.js";
import { isOriginAllowed, parseAllowedOrigins } from "./origin.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";
const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

const app = Fastify({ logger: true });
const hub = new LiveHub();
await app.register(cors, {
  origin(origin, cb) {
    if (isOriginAllowed(origin, allowedOrigins)) cb(null, true);
    else cb(new Error("Origin not allowed"), false);
  },
});
await app.register(websocket, {
  options: {
    verifyClient(info, done) {
      done(isOriginAllowed(info.origin, allowedOrigins), 403, "Origin not allowed");
    },
  },
});
await app.register(readingsRoute);
await app.register(pipelineHealthRoute);
await app.register(generationMixRoute);
await app.register(generationLatestRoute);
await app.register(generationShareRoute);
await app.register(plantsRoute);
await app.register(async (instance) => liveRoute(instance, hub));

hub.startHeartbeat(Number(process.env.LIVE_HEARTBEAT_MS ?? 30000));
const liveConsumer = await startLiveConsumer(hub);

app.addHook("onClose", async () => {
  await liveConsumer.stop();
  hub.closeAll();
  await pool.end();
});

const shutdown = async () => {
  await app.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

app.listen({ port, host }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`api listening at ${address}`);
});
