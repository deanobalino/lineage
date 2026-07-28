import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../domain/provenance-store.js";
import {
  MAX_CAPTURE_RECORD_BYTES,
  type CaptureEnvelope,
  validateEnvelope
} from "./envelope.js";

export interface OutboxLimits {
  maxItems: number;
  maxBytes: number;
  leaseMs: number;
}

export interface OutboxStatus {
  staging: number;
  pending: number;
  claimed: number;
  deadLetters: number;
  bytes: number;
  quotaExceeded: boolean;
  lastError?: string;
}

export interface Claim {
  path: string;
  envelope: CaptureEnvelope;
}

const defaultLimits: OutboxLimits = {
  maxItems: 10_000,
  maxBytes: 512 * 1024 * 1024,
  leaseMs: 30_000
};

export class CaptureOutbox {
  readonly stagingDirectory: string;
  readonly pendingDirectory: string;
  readonly claimedDirectory: string;
  readonly deadLetterDirectory: string;
  #lastError?: string;

  constructor(
    readonly root: string,
    readonly limits: OutboxLimits = defaultLimits
  ) {
    this.stagingDirectory = join(root, "staging");
    this.pendingDirectory = join(root, "pending");
    this.claimedDirectory = join(root, "claimed");
    this.deadLetterDirectory = join(root, "deadletters");
  }

  async initialize(): Promise<void> {
    await Promise.all(
      [
        this.stagingDirectory,
        this.pendingDirectory,
        this.claimedDirectory,
        this.deadLetterDirectory
      ].map((path) =>
        mkdir(path, { recursive: true, mode: 0o700 })
      )
    );
  }

  async enqueue(envelope: CaptureEnvelope): Promise<string> {
    await this.initialize();
    validateEnvelope(envelope);
    const data = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(data) > MAX_CAPTURE_RECORD_BYTES) {
      throw new Error("Capture record exceeds the item quota.");
    }
    const status = await this.status();
    if (
      status.staging + status.pending + status.claimed + status.deadLetters >=
      this.limits.maxItems
    ) {
      this.#lastError = "Capture outbox item quota exceeded.";
      throw new Error(this.#lastError);
    }
    if (status.bytes + Buffer.byteLength(data) > this.limits.maxBytes) {
      this.#lastError = "Capture outbox byte quota exceeded.";
      throw new Error(this.#lastError);
    }
    const path = this.pendingPath(envelope.ingestionId);
    try {
      await stat(path);
      return path;
    } catch {
      await atomicWrite(path, data, 0o600);
      return path;
    }
  }

  async stage(envelope: CaptureEnvelope): Promise<string> {
    await this.initialize();
    validateEnvelope(envelope);
    const data = `${JSON.stringify(envelope)}\n`;
    const status = await this.status();
    if (
      status.staging + status.pending + status.claimed + status.deadLetters >=
        this.limits.maxItems ||
      status.bytes + Buffer.byteLength(data) > this.limits.maxBytes
    ) {
      this.#lastError = "Capture outbox quota exceeded.";
      throw new Error(this.#lastError);
    }
    const path = join(this.stagingDirectory, `${envelope.ingestionId}.json`);
    await atomicWrite(path, data, 0o600);
    return path;
  }

  async finalizeStaged(envelope: CaptureEnvelope): Promise<string> {
    const path = await this.replacePending(envelope);
    await rm(join(this.stagingDirectory, `${envelope.ingestionId}.json`), { force: true });
    return path;
  }

  async replacePending(envelope: CaptureEnvelope): Promise<string> {
    validateEnvelope(envelope);
    const path = this.pendingPath(envelope.ingestionId);
    await atomicWrite(path, `${JSON.stringify(envelope)}\n`, 0o600);
    return path;
  }

  async claimNext(now = Date.now()): Promise<Claim | undefined> {
    await this.initialize();
    await this.recoverStaleStaging(now);
    await this.recoverStaleClaims(now);
    const names = (await readdir(this.pendingDirectory))
      .filter((name) => name.endsWith(".json"))
      .sort();
    const candidates = (
      await Promise.all(
        names.map(async (name) => {
          try {
            const envelope = validateEnvelope(
              JSON.parse(await readFile(join(this.pendingDirectory, name), "utf8")) as unknown
            );
            return { name, envelope };
          } catch (error) {
            await this.deadLetterPath(
              join(this.pendingDirectory, name),
              name,
              error
            );
            return undefined;
          }
        })
      )
    )
      .filter(
        (candidate): candidate is { name: string; envelope: CaptureEnvelope } =>
          Boolean(candidate)
      )
      .sort((left, right) => {
        const scope = `${left.envelope.provider}\0${left.envelope.sessionId}`.localeCompare(
          `${right.envelope.provider}\0${right.envelope.sessionId}`
        );
        if (scope !== 0) return scope;
        if (
          left.envelope.providerSequence !== undefined &&
          right.envelope.providerSequence !== undefined
        ) {
          const sequence =
            left.envelope.providerSequence - right.envelope.providerSequence;
          if (sequence !== 0) return sequence;
        }
        return (
          left.envelope.capturedAt.localeCompare(right.envelope.capturedAt) ||
          left.envelope.ingestionId.localeCompare(right.envelope.ingestionId)
        );
      });
    for (const { name } of candidates) {
      const source = join(this.pendingDirectory, name);
      const claimed = join(
        this.claimedDirectory,
        `${name.slice(0, -5)}--${now}--${process.pid}.json`
      );
      try {
        await rename(source, claimed);
        return {
          path: claimed,
          envelope: validateEnvelope(JSON.parse(await readFile(claimed, "utf8")) as unknown)
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        await this.deadLetterPath(claimed, name, error);
      }
    }
    return undefined;
  }

  async complete(claim: Claim): Promise<void> {
    await rm(claim.path, { force: true });
  }

  async retryLater(claim: Claim): Promise<void> {
    const target = this.pendingPath(claim.envelope.ingestionId);
    await rename(claim.path, target);
  }

  async deadLetter(claim: Claim, reason: string): Promise<void> {
    const target = join(
      this.deadLetterDirectory,
      `${claim.envelope.ingestionId}--${Date.now()}.json`
    );
    await rename(claim.path, target);
    await atomicWrite(`${target}.error`, `${reason.slice(0, 2_000)}\n`, 0o600);
    this.#lastError = reason;
  }

  async retryDeadLetters(): Promise<number> {
    await this.initialize();
    let count = 0;
    for (const name of (await readdir(this.deadLetterDirectory)).filter(
      (entry) => entry.endsWith(".json")
    )) {
      const source = join(this.deadLetterDirectory, name);
      const envelope = validateEnvelope(JSON.parse(await readFile(source, "utf8")) as unknown);
      await rename(source, this.pendingPath(envelope.ingestionId));
      await rm(`${source}.error`, { force: true });
      count += 1;
    }
    return count;
  }

  async discardDeadLetters(): Promise<number> {
    await this.initialize();
    let count = 0;
    for (const name of await readdir(this.deadLetterDirectory)) {
      await rm(join(this.deadLetterDirectory, name), { force: true });
      if (name.endsWith(".json")) count += 1;
    }
    return count;
  }

  async status(): Promise<OutboxStatus> {
    await this.initialize();
    const directories = [
      this.stagingDirectory,
      this.pendingDirectory,
      this.claimedDirectory,
      this.deadLetterDirectory
    ];
    const names = await Promise.all(directories.map((path) => readdir(path)));
    let bytes = 0;
    for (let index = 0; index < directories.length; index += 1) {
      for (const name of names[index] ?? []) {
        try {
          bytes += (await stat(join(directories[index]!, name))).size;
        } catch {
          // Concurrent replay may remove an item between listing and stat.
        }
      }
    }
    const status: OutboxStatus = {
      staging: (names[0] ?? []).filter((name) => name.endsWith(".json")).length,
      pending: (names[1] ?? []).filter((name) => name.endsWith(".json")).length,
      claimed: (names[2] ?? []).filter((name) => name.endsWith(".json")).length,
      deadLetters: (names[3] ?? []).filter((name) => name.endsWith(".json")).length,
      bytes,
      quotaExceeded:
        bytes >= this.limits.maxBytes ||
        names.reduce((total, entries) => total + entries.filter((name) => name.endsWith(".json")).length, 0) >=
          this.limits.maxItems
    };
    if (this.#lastError) status.lastError = this.#lastError;
    return status;
  }

  private pendingPath(id: string): string {
    return join(this.pendingDirectory, `${id}.json`);
  }

  private async recoverStaleClaims(now: number): Promise<void> {
    for (const name of (await readdir(this.claimedDirectory)).filter((entry) =>
      entry.endsWith(".json")
    )) {
      const match = /--(\d+)--\d+\.json$/.exec(name);
      if (!match || now - Number(match[1]) <= this.limits.leaseMs) continue;
      const source = join(this.claimedDirectory, name);
      try {
        const envelope = validateEnvelope(JSON.parse(await readFile(source, "utf8")) as unknown);
        await rename(source, this.pendingPath(envelope.ingestionId));
      } catch (error) {
        await this.deadLetterPath(source, name, error);
      }
    }
  }

  private async recoverStaleStaging(now: number): Promise<void> {
    for (const name of (await readdir(this.stagingDirectory)).filter((entry) =>
      entry.endsWith(".json")
    )) {
      const source = join(this.stagingDirectory, name);
      try {
        const details = await stat(source);
        if (now - details.mtimeMs <= this.limits.leaseMs) continue;
        const envelope = validateEnvelope(
          JSON.parse(await readFile(source, "utf8")) as unknown
        );
        envelope.evidenceComplete = false;
        envelope.evidenceIssue =
          "Capture process stopped after raw input was durable but before Git evidence finalized.";
        await this.replacePending(envelope);
        await rm(source, { force: true });
      } catch (error) {
        await this.deadLetterPath(source, name, error);
      }
    }
  }

  private async deadLetterPath(
    source: string,
    name: string,
    error: unknown
  ): Promise<void> {
    const target = join(this.deadLetterDirectory, `${name.replace(/\.json$/, "")}--corrupt.json`);
    try {
      await rename(source, target);
      await atomicWrite(
        `${target}.error`,
        `${error instanceof Error ? error.message : "Invalid capture record."}\n`,
        0o600
      );
    } catch {
      // If a concurrent process already moved the record there is nothing to do.
    }
  }
}
