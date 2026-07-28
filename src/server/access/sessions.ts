import { randomBytes } from "node:crypto";

export interface OperatorSession {
  id: string;
  csrf: string;
  createdAt: number;
  expiresAt: number;
}

export class SessionStore {
  readonly #sessions = new Map<string, OperatorSession>();

  constructor(readonly ttlMs: number) {}

  create(now = Date.now()): OperatorSession {
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
}

interface AttemptState {
  count: number;
  resetAt: number;
}

export class LoginThrottle {
  readonly #attempts = new Map<string, AttemptState>();

  constructor(
    readonly limit = 5,
    readonly windowMs = 5 * 60 * 1000
  ) {}

  allowed(key: string, now = Date.now()): boolean {
    const state = this.#attempts.get(key);
    if (!state || state.resetAt <= now) {
      this.#attempts.set(key, { count: 0, resetAt: now + this.windowMs });
      return true;
    }
    return state.count < this.limit;
  }

  fail(key: string, now = Date.now()): void {
    const state = this.#attempts.get(key);
    if (!state || state.resetAt <= now) {
      this.#attempts.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      state.count += 1;
    }
  }

  clear(key: string): void {
    this.#attempts.delete(key);
  }
}
