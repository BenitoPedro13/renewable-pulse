import type { FastifyInstance } from "fastify";
import type { LiveHub } from "../live/hub.js";

export async function liveRoute(app: FastifyInstance, hub: LiveHub): Promise<void> {
  app.get("/live", { websocket: true }, (socket) => {
    hub.add(socket);
  });
}
