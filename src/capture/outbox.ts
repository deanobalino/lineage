import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat
} from "node:fs/promises";
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

interface RetryState {
  version: 1;
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
}

export interface Claim {
  path: string;
  envelope: CaptureEnvelope;
  retry: RetryState;
}

type CountKey = "staging" | "pending" | "claimed" | "deadLetters";

interface OutboxIndex {
  version: 1;
  staging: number;
  pending: number;
  claimed: number;
  deadLetters: number;
  bytes: number;
  lastError?: string;
}

interface Candidate {
  name: string;
  envelope: CaptureEnvelope;
  retry: RetryState;
}

const defaultLimits: OutboxLimits = {
  maxItems: 10_000,
  maxBytes: 512 * 1024 * 1024,
  leaseMs: 30_000
};

const emptyRetry = (): RetryState => ({
  version: 1,
  attempts: 0,
  nextAttemptAt: 0,
  lastError: ""
});

const emptyIndex = (): OutboxIndex => ({
  version: 1,
  staging: 0,
  pending: 0,
  claimed: 0,
  deadLetters: 0,
  bytes: 0
});

export class CaptureOutbox {
  readonly stagingDirectory: string;
  readonly pendingDirectory: string;
  readonly claimedDirectory: string;
  readonly deadLetterDirectory: string;
  readonly retryDirectory: string;
  readonly indexPath: string;
  readonly lockPath: string;
  #initializing?: Promise<void>;
  #prepared = false;
  #candidates: Candidate[] = [];
  #candidateIds = new Set<string>();

  constructor(
    readonly root: string,
    readonly limits: OutboxLimits = defaultLimits
  ) {
    this.stagingDirectory = join(root, "staging");
    this.pendingDirectory = join(root, "pending");
    this.claimedDirectory = join(root, "claimed");
    this.deadLetterDirectory = join(root, "deadletters");
    this.retryDirectory = join(root, "retry");
    this.indexPath = join(root, "index.json");
    this.lockPath = join(root, "index.lock");
  }

  initialize(): Promise<void> {
    this.#initializing ??= (async () => {
      await this.initializeDirectories();
      try {
        await this.readIndex();
      } catch {
        await this.withIndex(() => undefined);
      }
    })();
    return this.#initializing;
  }

  async reconcile(): Promise<OutboxStatus> {
    await this.initializeDirectories();
    return this.withIndex(async (index) => {
      const rebuilt = await this.rebuildIndex();
      Object.assign(index, rebuilt);
      return this.publicStatus(index);
    });
  }

  async enqueue(envelope: CaptureEnvelope): Promise<string> {
    await this.initialize();
    validateEnvelope(envelope);
    const data = `${JSON.stringify(envelope)}\n`;
    const bytes = Buffer.byteLength(data);
    if (bytes > MAX_CAPTURE_RECORD_BYTES) {
      throw new Error("Capture record exceeds the item quota.");
    }
    const path = this.pendingPath(envelope.ingestionId);
    if (await exists(path)) return path;
    await this.reserve("pending", bytes);
    try {
      await atomicWrite(path, data, 0o600);
      this.#prepared = false;
      return path;
    } catch (error) {
      await this.releaseReservation("pending", bytes);
      throw error;
    }
  }

  async stage(envelope: CaptureEnvelope): Promise<string> {
    await this.initialize();
    validateEnvelope(envelope);
    const data = `${JSON.stringify(envelope)}\n`;
    const bytes = Buffer.byteLength(data);
    if (bytes > MAX_CAPTURE_RECORD_BYTES) {
      throw new Error("Capture record exceeds the item quota.");
    }
    await this.reserve("staging", bytes);
    const path = this.stagingPath(envelope.ingestionId);
    try {
      await atomicWrite(path, data, 0o600);
      return path;
    } catch (error) {
      await this.releaseReservation("staging", bytes);
      throw error;
    }
  }

  async finalizeStaged(envelope: CaptureEnvelope): Promise<string> {
    validateEnvelope(envelope);
    const stagedBytes = (await stat(this.stagingPath(envelope.ingestionId))).size;
    const finalizedBytes = recordBytes(envelope);
    if (finalizedBytes > MAX_CAPTURE_RECORD_BYTES) {
      throw new Error("Capture record exceeds the item quota.");
    }
    const path = this.pendingPath(envelope.ingestionId);
    await atomicWrite(path, `${JSON.stringify(envelope)}\n`, 0o600);
    await rm(this.stagingPath(envelope.ingestionId), { force: true });
    await this.transition("staging", "pending", undefined, finalizedBytes - stagedBytes);
    this.#prepared = false;
    return path;
  }

  async replacePending(envelope: CaptureEnvelope): Promise<string> {
    validateEnvelope(envelope);
    const path = this.pendingPath(envelope.ingestionId);
    await atomicWrite(path, `${JSON.stringify(envelope)}\n`, 0o600);
    return path;
  }

  async prepareReplay(now = Date.now()): Promise<void> {
    await this.initialize();
    await this.recoverStaleStaging(now);
    await this.recoverStaleClaims(now);
    const names = (await readdir(this.pendingDirectory))
      .filter((name) => name.endsWith(".json"))
      .filter((name) => !this.#candidateIds.has(name));
    const additions = await Promise.all(
      names.map(async (name): Promise<Candidate | undefined> => {
        const path = join(this.pendingDirectory, name);
        try {
          const envelope = validateEnvelope(
            JSON.parse(await readFile(path, "utf8")) as unknown
          );
          return {
            name,
            envelope,
            retry: await this.readRetry(envelope.ingestionId)
          };
        } catch (error) {
          await this.deadLetterPath(path, name, error, "pending");
          return undefined;
        }
      })
    );
    for (const candidate of additions) {
      if (!candidate) continue;
      this.#candidates.push(candidate);
      this.#candidateIds.add(candidate.name);
    }
    this.#candidates.sort(compareCandidates);
    this.#prepared = true;
  }

  async claimNext(now = Date.now()): Promise<Claim | undefined> {
    if (!this.#prepared || this.#candidates.length === 0) await this.prepareReplay(now);
    const blockedScopes = new Set<string>();
    for (let index = 0; index < this.#candidates.length; index += 1) {
      const candidate = this.#candidates[index]!;
      const scope = candidateScope(candidate.envelope);
      if (candidate.retry.nextAttemptAt > now) {
        blockedScopes.add(scope);
        continue;
      }
      if (blockedScopes.has(scope)) continue;
      this.#candidates.splice(index, 1);
      this.#candidateIds.delete(candidate.name);
      const claim = await this.claimCandidate(candidate, now);
      if (claim) return claim;
      index -= 1;
    }
    return undefined;
  }

  async claimById(id: string, now = Date.now()): Promise<Claim | undefined> {
    await this.initialize();
    const name = `${id}.json`;
    const path = this.pendingPath(id);
    try {
      const envelope = validateEnvelope(JSON.parse(await readFile(path, "utf8")) as unknown);
      const retry = await this.readRetry(id);
      if (retry.nextAttemptAt > now) return undefined;
      return this.claimCandidate({ name, envelope, retry }, now);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      await this.deadLetterPath(path, name, error, "pending");
      return undefined;
    }
  }

  async complete(claim: Claim): Promise<void> {
    const bytes = recordBytes(claim.envelope);
    await rm(claim.path, { force: true });
    await rm(this.retryPath(claim.envelope.ingestionId), { force: true });
    await this.removeItem("claimed", bytes);
  }

  async retryLater(claim: Claim, reason = "Capture delivery failed."): Promise<void> {
    const retry = nextRetry(claim.envelope.ingestionId, claim.retry, reason);
    await atomicWrite(
      this.retryPath(claim.envelope.ingestionId),
      `${JSON.stringify(retry)}\n`,
      0o600
    );
    await rename(claim.path, this.pendingPath(claim.envelope.ingestionId));
    await this.transition("claimed", "pending", reason);
  }

  async deadLetter(claim: Claim, reason: string): Promise<void> {
    const target = join(
      this.deadLetterDirectory,
      `${claim.envelope.ingestionId}--${Date.now()}.json`
    );
    await rename(claim.path, target);
    await rm(this.retryPath(claim.envelope.ingestionId), { force: true });
    await atomicWrite(`${target}.error`, `${reason.slice(0, 2_000)}\n`, 0o600);
    await this.transition("claimed", "deadLetters", reason);
  }

  async retryDeadLetters(): Promise<number> {
    await this.initialize();
    let count = 0;
    for (const name of (await readdir(this.deadLetterDirectory)).filter(
      (entry) => entry.endsWith(".json")
    )) {
      const source = join(this.deadLetterDirectory, name);
      const envelope = validateEnvelope(JSON.parse(await readFile(source, "utf8")) as unknown);
      await rm(this.retryPath(envelope.ingestionId), { force: true });
      await rename(source, this.pendingPath(envelope.ingestionId));
      await rm(`${source}.error`, { force: true });
      count += 1;
    }
    this.#candidates = [];
    this.#candidateIds.clear();
    await this.reconcile();
    return count;
  }

  async discardDeadLetters(): Promise<number> {
    await this.initialize();
    let count = 0;
    for (const name of await readdir(this.deadLetterDirectory)) {
      await rm(join(this.deadLetterDirectory, name), { force: true });
      if (name.endsWith(".json")) count += 1;
    }
    await this.reconcile();
    return count;
  }

  async status(): Promise<OutboxStatus> {
    await this.initialize();
    try {
      return this.publicStatus(await this.readIndex());
    } catch {
      return this.reconcile();
    }
  }

  private async claimCandidate(
    candidate: Candidate,
    now: number
  ): Promise<Claim | undefined> {
    const source = join(this.pendingDirectory, candidate.name);
    const claimed = join(
      this.claimedDirectory,
      `${candidate.name.slice(0, -5)}--${now}--${process.pid}.json`
    );
    try {
      await rename(source, claimed);
      await this.transition("pending", "claimed");
      return { path: claimed, envelope: candidate.envelope, retry: candidate.retry };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      await this.deadLetterPath(source, candidate.name, error, "pending");
      return undefined;
    }
  }

  private async recoverStaleClaims(now: number): Promise<void> {
    let changed = false;
    for (const name of (await readdir(this.claimedDirectory)).filter((entry) =>
      entry.endsWith(".json")
    )) {
      const match = /--(\d+)--\d+\.json$/.exec(name);
      if (!match || now - Number(match[1]) <= this.limits.leaseMs) continue;
      const source = join(this.claimedDirectory, name);
      try {
        const envelope = validateEnvelope(JSON.parse(await readFile(source, "utf8")) as unknown);
        await rename(source, this.pendingPath(envelope.ingestionId));
        changed = true;
      } catch (error) {
        await this.deadLetterPath(source, name, error, "claimed");
      }
    }
    if (changed) await this.reconcile();
  }

  private async recoverStaleStaging(now: number): Promise<void> {
    let changed = false;
    const claimedNames = await readdir(this.claimedDirectory);
    const deadNames = await readdir(this.deadLetterDirectory);
    for (const name of (await readdir(this.stagingDirectory)).filter((entry) =>
      entry.endsWith(".json")
    )) {
      const source = join(this.stagingDirectory, name);
      try {
        const details = await stat(source);
        if (now - details.mtimeMs <= this.limits.leaseMs) continue;
        const id = name.slice(0, -5);
        const laterPhaseExists =
          await exists(this.pendingPath(id)) ||
          claimedNames.some((entry) => entry.startsWith(`${id}--`)) ||
          deadNames.some((entry) => entry.startsWith(`${id}--`));
        if (laterPhaseExists) {
          await rm(source, { force: true });
          changed = true;
          continue;
        }
        const envelope = validateEnvelope(
          JSON.parse(await readFile(source, "utf8")) as unknown
        );
        envelope.evidenceComplete = false;
        envelope.evidenceIssue =
          "Capture process stopped after raw input was durable but before Git evidence finalized.";
        await this.replacePending(envelope);
        await rm(source, { force: true });
        changed = true;
      } catch (error) {
        await this.deadLetterPath(source, name, error, "staging");
      }
    }
    if (changed) await this.reconcile();
  }

  private async deadLetterPath(
    source: string,
    name: string,
    error: unknown,
    from: CountKey
  ): Promise<void> {
    const target = join(this.deadLetterDirectory, `${name.replace(/\.json$/, "")}--corrupt.json`);
    try {
      await rename(source, target);
      await atomicWrite(
        `${target}.error`,
        `${error instanceof Error ? error.message : "Invalid capture record."}\n`,
        0o600
      );
      await this.transition(from, "deadLetters", errorMessage(error));
    } catch (moveError) {
      if ((moveError as NodeJS.ErrnoException).code === "ENOENT") return;
      throw moveError;
    }
  }

  private async reserve(state: CountKey, bytes: number): Promise<void> {
    await this.withIndex((index) => {
      const items = itemCount(index);
      if (items >= this.limits.maxItems || index.bytes + bytes > this.limits.maxBytes) {
        index.lastError = "Capture outbox quota exceeded.";
        throw new Error(index.lastError);
      }
      index[state] += 1;
      index.bytes += bytes;
    });
  }

  private async releaseReservation(state: CountKey, bytes: number): Promise<void> {
    await this.withIndex((index) => {
      index[state] = Math.max(0, index[state] - 1);
      index.bytes = Math.max(0, index.bytes - bytes);
    });
  }

  private async transition(
    from: CountKey,
    to: CountKey,
    lastError?: string,
    bytesDelta = 0
  ): Promise<void> {
    await this.withIndex((index) => {
      index[from] = Math.max(0, index[from] - 1);
      index[to] += 1;
      index.bytes = Math.max(0, index.bytes + bytesDelta);
      if (lastError) index.lastError = lastError.slice(0, 2_000);
    });
  }

  private async removeItem(state: CountKey, bytes: number): Promise<void> {
    await this.withIndex((index) => {
      index[state] = Math.max(0, index[state] - 1);
      index.bytes = Math.max(0, index.bytes - bytes);
    });
  }

  private async readRetry(id: string): Promise<RetryState> {
    try {
      const value = JSON.parse(await readFile(this.retryPath(id), "utf8")) as RetryState;
      return value.version === 1 &&
        Number.isInteger(value.attempts) &&
        Number.isFinite(value.nextAttemptAt)
        ? value
        : emptyRetry();
    } catch {
      return emptyRetry();
    }
  }

  private async initializeDirectories(): Promise<void> {
    await Promise.all(
      [
        this.root,
        this.stagingDirectory,
        this.pendingDirectory,
        this.claimedDirectory,
        this.deadLetterDirectory,
        this.retryDirectory
      ].map((path) => mkdir(path, { recursive: true, mode: 0o700 }))
    );
  }

  private async readIndex(): Promise<OutboxIndex> {
    const value = JSON.parse(await readFile(this.indexPath, "utf8")) as OutboxIndex;
    if (
      value.version !== 1 ||
      !["staging", "pending", "claimed", "deadLetters", "bytes"].every(
        (key) => Number.isInteger(value[key as CountKey | "bytes"]) &&
          value[key as CountKey | "bytes"] >= 0
      )
    ) {
      throw new Error("Capture outbox index is invalid.");
    }
    return value;
  }

  private async rebuildIndex(): Promise<OutboxIndex> {
    const index = emptyIndex();
    const states: Array<[CountKey, string]> = [
      ["staging", this.stagingDirectory],
      ["pending", this.pendingDirectory],
      ["claimed", this.claimedDirectory],
      ["deadLetters", this.deadLetterDirectory]
    ];
    for (const [state, directory] of states) {
      for (const name of (await readdir(directory)).filter((entry) => entry.endsWith(".json"))) {
        try {
          index[state] += 1;
          index.bytes += (await stat(join(directory, name))).size;
        } catch {
          index[state] = Math.max(0, index[state] - 1);
        }
      }
    }
    return index;
  }

  private async withIndex<T>(
    mutate: (index: OutboxIndex) => T | Promise<T>
  ): Promise<T> {
    await this.initializeDirectories();
    const release = await this.acquireIndexLock();
    try {
      let index: OutboxIndex;
      try {
        index = await this.readIndex();
      } catch {
        index = await this.rebuildIndex();
      }
      const result = await mutate(index);
      await atomicWrite(this.indexPath, `${JSON.stringify(index)}\n`, 0o600);
      return result;
    } finally {
      await release();
    }
  }

  private async acquireIndexLock(timeoutMs = 2_000): Promise<() => Promise<void>> {
    const started = Date.now();
    while (true) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n${Date.now()}\n`);
        await handle.sync();
        await handle.close();
        return () => rm(this.lockPath, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.removeAbandonedLock()) continue;
        if (Date.now() - started >= timeoutMs) {
          throw new Error("Capture outbox index is busy.");
        }
        await pause(5 + Math.floor(Math.random() * 10));
      }
    }
  }

  private async removeAbandonedLock(): Promise<boolean> {
    try {
      const [pidText, createdText] = (await readFile(this.lockPath, "utf8")).split("\n");
      const pid = Number(pidText);
      const created = Number(createdText);
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(created)) {
        const details = await stat(this.lockPath).catch(() => undefined);
        if (!details || Date.now() - details.mtimeMs < 5_000) return false;
        await rm(this.lockPath, { force: true });
        return true;
      }
      if (
        processAlive(pid) &&
        Date.now() - created < 5_000
      ) {
        return false;
      }
      await rm(this.lockPath, { force: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      const details = await stat(this.lockPath).catch(() => undefined);
      if (details && Date.now() - details.mtimeMs >= 5_000) {
        await rm(this.lockPath, { force: true });
        return true;
      }
      return false;
    }
  }

  private publicStatus(index: OutboxIndex): OutboxStatus {
    const status: OutboxStatus = {
      staging: index.staging,
      pending: index.pending,
      claimed: index.claimed,
      deadLetters: index.deadLetters,
      bytes: index.bytes,
      quotaExceeded:
        index.bytes >= this.limits.maxBytes ||
        itemCount(index) >= this.limits.maxItems
    };
    if (index.lastError) status.lastError = index.lastError;
    return status;
  }

  private stagingPath(id: string): string {
    return join(this.stagingDirectory, `${id}.json`);
  }

  private pendingPath(id: string): string {
    return join(this.pendingDirectory, `${id}.json`);
  }

  private retryPath(id: string): string {
    return join(this.retryDirectory, `${id}.json`);
  }
}

function compareCandidates(left: Candidate, right: Candidate): number {
  const scope = candidateScope(left.envelope).localeCompare(candidateScope(right.envelope));
  if (scope !== 0) return scope;
  if (
    left.envelope.providerSequence !== undefined &&
    right.envelope.providerSequence !== undefined
  ) {
    const sequence = left.envelope.providerSequence - right.envelope.providerSequence;
    if (sequence !== 0) return sequence;
  }
  return (
    left.envelope.capturedAt.localeCompare(right.envelope.capturedAt) ||
    left.envelope.ingestionId.localeCompare(right.envelope.ingestionId)
  );
}

function candidateScope(envelope: CaptureEnvelope): string {
  return `${envelope.repoRoot}\0${envelope.provider}\0${envelope.sessionId}`;
}

function nextRetry(id: string, current: RetryState, reason: string): RetryState {
  const attempts = Math.min(current.attempts + 1, 31);
  const base = Math.min(60_000, 250 * 2 ** Math.min(attempts - 1, 8));
  const digest = createHash("sha256").update(`${id}:${attempts}`).digest();
  const jitter = digest.readUInt16BE(0) % Math.max(1, Math.floor(base / 4));
  return {
    version: 1,
    attempts,
    nextAttemptAt: Date.now() + base + jitter,
    lastError: reason.slice(0, 2_000)
  };
}

function itemCount(index: OutboxIndex): number {
  return index.staging + index.pending + index.claimed + index.deadLetters;
}

function recordBytes(envelope: CaptureEnvelope): number {
  return Buffer.byteLength(`${JSON.stringify(envelope)}\n`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Capture outbox operation failed.";
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
