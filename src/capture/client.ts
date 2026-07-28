import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../domain/provenance-store.js";
import type { CaptureEnvelope } from "./envelope.js";
import { CaptureOutbox, type Claim } from "./outbox.js";

export interface CaptureClientConfig {
  version: 1;
  endpoint: string;
  token: string;
  outboxDirectory: string;
  baselineDirectory: string;
}

export interface CaptureServerHealth {
  state: string;
  pending: number;
  claimed: number;
  deadLetters: number;
  bytes: number;
  incompleteEvidence: number;
  lastError?: string;
}

export async function writeCaptureClientConfig(
  stateDirectory: string,
  config: CaptureClientConfig
): Promise<string> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const path = join(stateDirectory, "capture-client.json");
  await atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`, 0o600);
  await chmod(path, 0o600);
  return path;
}

export async function readCaptureClientConfig(
  stateDirectory: string
): Promise<CaptureClientConfig> {
  const parsed = JSON.parse(
    await readFile(join(stateDirectory, "capture-client.json"), "utf8")
  ) as CaptureClientConfig;
  if (
    parsed.version !== 1 ||
    !parsed.endpoint.startsWith("http://127.0.0.1:") ||
    !parsed.token ||
    !parsed.outboxDirectory ||
    !parsed.baselineDirectory
  ) {
    throw new Error("Capture client configuration is invalid.");
  }
  return parsed;
}

export async function deliverClaim(
  claim: Claim,
  outbox: CaptureOutbox,
  config: CaptureClientConfig,
  timeoutMs = 500
): Promise<"delivered" | "transient" | "permanent"> {
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(claim.envelope),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (response.ok) {
      await outbox.complete(claim);
      return "delivered";
    }
    if ([400, 401, 403, 404, 409, 413, 422].includes(response.status)) {
      const detail = (await response.text()).slice(0, 2_000);
      await outbox.deadLetter(
        claim,
        `Capture server rejected the record (${response.status}): ${detail}`
      );
      return "permanent";
    }
    await outbox.retryLater(claim, `Capture server returned ${response.status}.`);
    return "transient";
  } catch (error) {
    await outbox.retryLater(
      claim,
      error instanceof Error ? error.message : "Capture delivery failed."
    );
    return "transient";
  }
}

export async function wakeCapture(
  envelope: CaptureEnvelope,
  config: CaptureClientConfig
): Promise<"delivered" | "transient" | "permanent"> {
  const outbox = new CaptureOutbox(config.outboxDirectory);
  const claim = await outbox.claimById(envelope.ingestionId);
  if (!claim) return "transient";
  return deliverClaim(claim, outbox, config);
}

export async function captureServerHealth(
  config: CaptureClientConfig,
  timeoutMs = 500
): Promise<CaptureServerHealth> {
  const endpoint = new URL(config.endpoint);
  endpoint.pathname = endpoint.pathname.replace(/\/api\/v1\/capture\/?$/, "/api/v1/capture/health");
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`Capture health endpoint returned ${response.status}.`);
  }
  const health = await response.json() as CaptureServerHealth;
  if (
    !health ||
    typeof health.state !== "string" ||
    !Number.isInteger(health.pending) ||
    !Number.isInteger(health.claimed) ||
    !Number.isInteger(health.deadLetters) ||
    !Number.isInteger(health.incompleteEvidence)
  ) {
    throw new Error("Capture health response is invalid.");
  }
  return health;
}
