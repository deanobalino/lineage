import { randomBytes } from "node:crypto";

export interface OperatorSession {
  id: string;
  csrf: string;
  createdAt: number;
  expiresAt: number;
}

export class SessionStore {
  readonly #sessions = new Map<string, OperatorSession>();

  constructor(
    readonly ttlMs: number,
    readonly maxEntries = 1_024
  ) {}

  create(now = Date.now()): OperatorSession {
    this.#prune(now);
    while (this.#sessions.size >= this.maxEntries) {
      const oldest = this.#sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#sessions.delete(oldest);
    }
    const session: OperatorSession = {
      id: randomBytes(32).toString("base64url"),
      csrf: randomBytes(24).toString("base64url"),
      createdAt: now,
      expiresAt: now + this.ttlMs
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string | undefined, now = Date.now()): OperatorSession | undefined {
    if (!id) return undefined;
    const session = this.#sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= now) {
      this.#sessions.delete(id);
      return undefined;
    }
    return session;
  }

  revoke(id: string | undefined): void {
    if (id) this.#sessions.delete(id);
  }

  revokeAll(): void {
    this.#sessions.clear();
  }

  #prune(now: number): void {
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(id);
    }
  }
}

interface AttemptState {
  count: number;
  resetAt: number;
}

export class LoginThrottle {
  readonly #attempts = new Map<string, AttemptState>();

  constructor(
    readonly limit = 5,
    readonly windowMs = 5 * 60 * 1000,
    readonly maxEntries = 10_000
  ) {}

  allowed(key: string, now = Date.now()): boolean {
    this.#prune(now);
    const state = this.#attempts.get(key);
    if (!state || state.resetAt <= now) {
      this.#makeRoom();
      this.#attempts.set(key, { count: 0, resetAt: now + this.windowMs });
      return true;
    }
    return state.count < this.limit;
  }

  fail(key: string, now = Date.now()): void {
    this.#prune(now);
    const state = this.#attempts.get(key);
    if (!state || state.resetAt <= now) {
      this.#makeRoom();
      this.#attempts.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      state.count += 1;
    }
  }

  clear(key: string): void {
    this.#attempts.delete(key);
  }

  #prune(now: number): void {
    for (const [key, state] of this.#attempts) {
      if (state.resetAt <= now) this.#attempts.delete(key);
    }
  }

  #makeRoom(): void {
    while (this.#attempts.size >= this.maxEntries) {
      const oldest = this.#attempts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#attempts.delete(oldest);
    }
  }
}
