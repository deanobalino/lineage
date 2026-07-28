import { Type } from "@sinclair/typebox";
import Fastify, { type FastifyInstance } from "fastify";
import type { CredentialStore } from "../access/credentials.js";
import type { CaptureService } from "./capture-service.js";

const EnvelopeSchema = Type.Object(
  {
    version: Type.Literal(1),
    ingestionId: Type.String({ minLength: 1, maxLength: 200 }),
    capturedAt: Type.String({ minLength: 20, maxLength: 64 }),
    provider: Type.String({ minLength: 1, maxLength: 100 }),
    providerEventName: Type.String({ minLength: 1, maxLength: 200 }),
    eventType: Type.String({ minLength: 1, maxLength: 200 }),
    providerSequence: Type.Optional(Type.Number()),
    sessionId: Type.String({ minLength: 1, maxLength: 512 }),
    turnId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    cwd: Type.String({ minLength: 1, maxLength: 4096 }),
    repoRoot: Type.String({ minLength: 1, maxLength: 4096 }),
    raw: Type.Record(Type.String(), Type.Any()),
    environment: Type.Record(Type.String(), Type.String()),
    gitSnapshot: Type.Optional(Type.Any()),
    evidenceComplete: Type.Boolean(),
    evidenceIssue: Type.Optional(Type.String({ maxLength: 2_000 }))
  },
  { additionalProperties: false }
);

export function buildCaptureApp(
  credentials: CredentialStore,
  service: CaptureService
): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env["LINEAGE_LOG_LEVEL"] ?? "info",
      redact: ["req.headers.authorization"]
    },
    bodyLimit: 2 * 1024 * 1024
  });
  app.addHook("onRequest", async (request, reply) => {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(request.hostname)) {
      return reply.code(400).send({ error: "invalid_host" });
    }
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    if (!await credentials.verifyCapture(token)) {
      return reply.code(401).send({ error: "invalid_capture_credential" });
    }
    reply.header("cache-control", "no-store");
  });
  app.post("/api/v1/capture", {
    schema: { body: EnvelopeSchema }
  }, async (request, reply) => {
    try {
      const result = await service.ingest(request.body);
      return reply.code(result.duplicate ? 200 : 202).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Capture failed.";
      if (/not registered|outside|invalid|exceeds/i.test(message)) {
        return reply.code(422).send({ error: "capture_rejected", message });
      }
      await service.interrupt(error);
      return reply.code(503).send({ error: "capture_unavailable" });
    }
  });
  app.get("/api/v1/capture/health", async () => service.health());
  return app;
}
