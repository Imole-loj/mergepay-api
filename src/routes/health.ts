import { FastifyInstance } from "fastify";
import { getReadiness } from "../services/health";

let lastLoggedDegradedReadiness: string | null = null;

export default async function healthRoutes(app: FastifyInstance) {
  app.get(
    "/health",
    {
      schema: {
        tags: ["System"],
        summary: "Health readiness check",
        description:
          "Performs readiness check against database and Stellar Horizon network services, returning service status and component diagnostics.",
        response: {
          200: {
            description: "Service is healthy and all components are operational",
            type: "object",
            properties: {
              status: { type: "string", example: "ok" },
              database: {
                type: "object",
                properties: {
                  connected: { type: "boolean", example: true },
                },
              },
              stellar: {
                type: "object",
                properties: {
                  reachable: { type: "boolean", example: true },
                  network: { type: "string", example: "testnet" },
                },
              },
              timestamp: { type: "string", format: "date-time" },
            },
          },
          503: {
            description: "Service is degraded or a core dependency is unreachable",
            type: "object",
            properties: {
              status: { type: "string", example: "degraded" },
              database: {
                type: "object",
                properties: {
                  connected: { type: "boolean", example: false },
                },
              },
              stellar: {
                type: "object",
                properties: {
                  reachable: { type: "boolean", example: false },
                  network: { type: "string", example: "testnet" },
                },
              },
              timestamp: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const readiness = await getReadiness();
      const statusCode = readiness.status === "ok" ? 200 : 503;

      if (
        statusCode === 503 &&
        lastLoggedDegradedReadiness !== readiness.timestamp
      ) {
        request.log.warn(
          {
            databaseConnected: readiness.database.connected,
            stellarReachable: readiness.stellar.reachable,
            network: readiness.stellar.network,
          },
          "Health readiness check is degraded"
        );
        lastLoggedDegradedReadiness = readiness.timestamp;
      }

      return reply.code(statusCode).send(readiness);
    }
  );
}
