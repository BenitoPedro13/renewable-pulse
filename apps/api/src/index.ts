import Fastify from "fastify";
import { readingsRoute } from "./routes/readings.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";

const app = Fastify({ logger: true });
await app.register(readingsRoute);

app.listen({ port, host }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`api listening at ${address}`);
});
