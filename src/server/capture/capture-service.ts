import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalEvent,
  linkRepository,
  ProvenanceStore
} from "../../domain/index.js";
import { atomicWrite } from "../../domain/provenance-store.js";
import type { CaptureEnvelope } from "../../capture/envelope.js";
import { validateEnvelope } from "../../capture/envelope.js";
import { CaptureOutbox } from "../../capture/outbox.js";
import type { RepositoryRegistry } from "../repositories/registry.js";

interface PersistedCaptureHealth {
  version: 1;
  lastAcknowledgedAt?: string;
  lastInterruptedAt?: string;
  lastError?: string;
  incompleteEvidence: number;
}

export interface CaptureHealth {
  state:
    | "off"
    | "installed"
    | "healthy"
    | "interrupted"
    | "pending"
    | "replaying"
    | "degraded"
    | "restored";
  pending: number;
  claimed: number;
  deadLetters: number;
  bytes: number;
  incompleteEvidence: number;
  lastAcknowledgedAt?: string;
  lastInterruptedAt?: string;
  lastError?: string;
}

export class CaptureService {
  readonly outbox: CaptureOutbox;
  readonly healthPath: string;
  #health: PersistedCaptureHealth = { version: 1, incompleteEvidence: 0 };
  #replaying = false;

  constructor(
    readonly stateDirectory: string,
    readonly registry: RepositoryRegistry
  ) {
    this.outbox = new CaptureOutbox(join(stateDirectory, "capture-outbox"));
    this.healthPath = join(stateDirectory, "capture-health.json");
  }

  async initialize(): Promise<void> {
    await this.outbox.initialize();
    try {
      const parsed = JSON.parse(await readFile(this.healthPath, "utf8")) as PersistedCaptureHealth;
      if (parsed.version === 1) this.#health = parsed;
    } catch {
      await this.#saveHealth();
    }
  }

  async ingest(input: unknown): Promise<{ id: string; duplicate: boolean }> {
    const envelope = validateEnvelope(input);
    const repository = await this.registry.resolveByRoot(envelope.repoRoot);
    const rawPayload =
      envelope.raw["payload"] &&
      typeof envelope.raw["payload"] === "object" &&
      !Array.isArray(envelope.raw["payload"])
        ? envelope.raw["payload"] as Record<string, unknown>
        : envelope.raw;
    const adapterContext = {
      provider: envelope.provider,
      raw: envelope.raw,
      payload: rawPayload,
      cwd: envelope.cwd,
      repoRoot: repository.root,
      environment: envelope.environment,
      capturedAt: envelope.capturedAt,
      ingestionId: envelope.ingestionId
    };
    const event = canonicalEvent(
      envelope.gitSnapshot
        ? { ...adapterContext, gitSnapshot: envelope.gitSnapshot }
        : adapterContext
    );
    event.providerEventName = envelope.providerEventName;
    event.eventType = envelope.eventType;
    if (envelope.providerSequence !== undefined) {
      event.providerSequence = envelope.providerSequence;
    }
    event.sessionId = envelope.sessionId;
    if (envelope.turnId) event.turnId = envelope.turnId;
    event.payload["lineage_evidence_complete"] = envelope.evidenceComplete;
    if (envelope.evidenceIssue) event.payload["lineage_evidence_issue"] = envelope.evidenceIssue;
    const store = new ProvenanceStore(repository.root);
    const result = await store.append(event);
    if (event.eventType === "session_stop") await linkRepository(store);
    this.#health.lastAcknowledgedAt = new Date().toISOString();
    delete this.#health.lastError;
    if (!envelope.evidenceComplete) this.#health.incompleteEvidence += 1;
    await this.#saveHealth();
    return { id: event.id, duplicate: result === "duplicate" };
  }

  async interrupt(error: unknown): Promise<void> {
    this.#health.lastInterruptedAt = new Date().toISOString();
    this.#health.lastError =
      (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    await this.#saveHealth();
  }

  async replay(maxItems = 100): Promise<{ delivered: number; deadLetters: number }> {
    if (this.#replaying) return { delivered: 0, deadLetters: 0 };
    this.#replaying = true;
    let delivered = 0;
    let deadLetters = 0;
    try {
      while (delivered + deadLetters < maxItems) {
        const claim = await this.outbox.claimNext();
        if (!claim) break;
        try {
          await this.ingest(claim.envelope);
          await this.outbox.complete(claim);
          delivered += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Capture replay failed.";
          if (
            /invalid|not registered|outside|unknown repository|exceeds|unsupported/i.test(message)
          ) {
            await this.outbox.deadLetter(claim, message);
            deadLetters += 1;
          } else {
            await this.outbox.retryLater(claim);
            await this.interrupt(error);
            break;
          }
        }
      }
      return { delivered, deadLetters };
    } finally {
      this.#replaying = false;
    }
  }

  async health(): Promise<CaptureHealth> {
    const outbox = await this.outbox.status();
    let state: CaptureHealth["state"] = "installed";
    if (
      outbox.deadLetters > 0 ||
      outbox.quotaExceeded ||
      this.#health.incompleteEvidence > 0
    ) {
      state = "degraded";
    } else if (this.#replaying) {
      state = "replaying";
    } else if (outbox.staging > 0 || outbox.pending > 0 || outbox.claimed > 0) {
      state = "pending";
    } else if (this.#health.lastError) {
      state = "interrupted";
    } else if (
      this.#health.lastInterruptedAt &&
      this.#health.lastAcknowledgedAt &&
      this.#health.lastAcknowledgedAt > this.#health.lastInterruptedAt
    ) {
      state = "restored";
    } else if (this.#health.lastAcknowledgedAt) {
      state = "healthy";
    }
    const health: CaptureHealth = {
      state,
      pending: outbox.staging + outbox.pending,
      claimed: outbox.claimed,
      deadLetters: outbox.deadLetters,
      bytes: outbox.bytes,
      incompleteEvidence: this.#health.incompleteEvidence
    };
    if (this.#health.lastAcknowledgedAt) health.lastAcknowledgedAt = this.#health.lastAcknowledgedAt;
    if (this.#health.lastInterruptedAt) health.lastInterruptedAt = this.#health.lastInterruptedAt;
    const lastError = this.#health.lastError ?? outbox.lastError;
    if (lastError) health.lastError = lastError;
    return health;
  }

  async clearIncompleteEvidence(): Promise<void> {
    this.#health.incompleteEvidence = 0;
    await this.#saveHealth();
  }

  async #saveHealth(): Promise<void> {
    await atomicWrite(this.healthPath, `${JSON.stringify(this.#health, null, 2)}\n`, 0o600);
  }
}
