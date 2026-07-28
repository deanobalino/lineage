import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { atomicWrite } from "../../domain/provenance-store.js";

interface Verifier {
  salt: string;
  hash: string;
}

interface CredentialState {
  version: 1;
  operator: Verifier;
  capture: Verifier;
  capturePending?: Array<{
    id: string;
    verifier: Verifier;
    createdAt: string;
    previous?: boolean;
  }>;
  rotatedAt: string;
}

export interface BootstrapSecrets {
  operatorToken?: string;
  captureToken?: string;
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

const deriveKey = promisify(scrypt);

async function verifier(secret: string): Promise<Verifier> {
  const salt = randomBytes(16);
  return {
    salt: salt.toString("base64url"),
    hash: (await deriveKey(secret, salt, 32) as Buffer).toString("base64url")
  };
}

async function verify(secret: string, expected: Verifier): Promise<boolean> {
  try {
    const actual = await deriveKey(
      secret,
      Buffer.from(expected.salt, "base64url"),
      32
    ) as Buffer;
    const hash = Buffer.from(expected.hash, "base64url");
    return actual.length === hash.length && timingSafeEqual(actual, hash);
  } catch {
    return false;
  }
}

export class CredentialStore {
  readonly path: string;
  #state!: CredentialState;
  #mutation = Promise.resolve();

  constructor(readonly stateDirectory: string) {
    this.path = join(stateDirectory, "credentials.json");
  }

  async initialize(): Promise<BootstrapSecrets> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.stateDirectory, 0o700);
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as CredentialState;
      if (
        parsed.version !== 1 ||
        !parsed.operator?.salt ||
        !parsed.operator.hash ||
        !parsed.capture?.salt ||
        !parsed.capture.hash
      ) {
        throw new Error("Unsupported credential state.");
      }
      this.#state = parsed;
      return {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const operatorToken = token();
      const captureToken = token();
      this.#state = {
        version: 1,
        operator: await verifier(operatorToken),
        capture: await verifier(captureToken),
        rotatedAt: new Date().toISOString()
      };
      await this.#save();
      return { operatorToken, captureToken };
    }
  }

  verifyOperator(secret: string): Promise<boolean> {
    return verify(secret, this.#state.operator);
  }

  async verifyCapture(secret: string): Promise<boolean> {
    if (await verify(secret, this.#state.capture)) return true;
    for (const pending of this.#state.capturePending ?? []) {
      if (await verify(secret, pending.verifier)) return true;
    }
    return false;
  }

  async rotateOperator(): Promise<string> {
    return this.#mutate(async () => {
      const secret = token();
      await this.#persistState({
        ...this.#state,
        operator: await verifier(secret),
        rotatedAt: new Date().toISOString()
      });
      return secret;
    });
  }

  async rotateCapture(): Promise<string> {
    const rotation = await this.beginCaptureRotation();
    await this.commitCaptureRotation(rotation.id);
    await this.finalizeCaptureRotation(rotation.id);
    return rotation.token;
  }

  async beginCaptureRotation(): Promise<{ id: string; token: string }> {
    return this.#mutate(async () => {
      const secret = token();
      const pending = {
        id: randomBytes(16).toString("base64url"),
        verifier: await verifier(secret),
        createdAt: new Date().toISOString()
      };
      await this.#persistState({
        ...this.#state,
        capturePending: [...(this.#state.capturePending ?? []), pending].slice(-4)
      });
      return { id: pending.id, token: secret };
    });
  }

  async commitCaptureRotation(id: string): Promise<void> {
    await this.#mutate(async () => {
      const pending = this.#state.capturePending?.find((entry) => entry.id === id);
      if (!pending || pending.previous) {
        throw new Error("Capture credential rotation is no longer pending.");
      }
      const previous = this.#state.capture;
      await this.#persistState({
        ...this.#state,
        capture: pending.verifier,
        capturePending: [
          ...(this.#state.capturePending ?? []).filter((entry) => entry.id !== id),
          {
            id,
            verifier: previous,
            createdAt: new Date().toISOString(),
            previous: true
          }
        ],
        rotatedAt: new Date().toISOString()
      });
    });
  }

  async cancelCaptureRotation(id: string): Promise<void> {
    await this.#mutate(async () => {
      const pending = this.#state.capturePending?.find((entry) => entry.id === id);
      await this.#persistState({
        ...this.#state,
        capture: pending?.previous ? pending.verifier : this.#state.capture,
        capturePending: (this.#state.capturePending ?? [])
          .filter((entry) => entry.id !== id)
      });
    });
  }

  async finalizeCaptureRotation(id: string): Promise<void> {
    await this.#mutate(async () => {
      await this.#persistState({
        ...this.#state,
        capturePending: (this.#state.capturePending ?? [])
          .filter((entry) => entry.id !== id)
      });
    });
  }

  async #save(): Promise<void> {
    await this.#persistState(this.#state);
  }

  async #persistState(state: CredentialState): Promise<void> {
    await atomicWrite(this.path, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    await chmod(this.path, 0o600);
    this.#state = state;
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutation;
    let release!: () => void;
    this.#mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
