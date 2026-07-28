import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../../domain/provenance-store.js";

interface Verifier {
  salt: string;
  hash: string;
}

interface CredentialState {
  version: 1;
  operator: Verifier;
  capture: Verifier;
  rotatedAt: string;
}

export interface BootstrapSecrets {
  operatorToken?: string;
  captureToken?: string;
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function verifier(secret: string): Verifier {
  const salt = randomBytes(16);
  return {
    salt: salt.toString("base64url"),
    hash: scryptSync(secret, salt, 32).toString("base64url")
  };
}

function verify(secret: string, expected: Verifier): boolean {
  try {
    const actual = scryptSync(secret, Buffer.from(expected.salt, "base64url"), 32);
    const hash = Buffer.from(expected.hash, "base64url");
    return actual.length === hash.length && timingSafeEqual(actual, hash);
  } catch {
    return false;
  }
}

export class CredentialStore {
  readonly path: string;
  #state!: CredentialState;

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
        operator: verifier(operatorToken),
        capture: verifier(captureToken),
        rotatedAt: new Date().toISOString()
      };
      await this.#save();
      return { operatorToken, captureToken };
    }
  }

  verifyOperator(secret: string): boolean {
    return verify(secret, this.#state.operator);
  }

  verifyCapture(secret: string): boolean {
    return verify(secret, this.#state.capture);
  }

  async rotateOperator(): Promise<string> {
    const secret = token();
    this.#state.operator = verifier(secret);
    this.#state.rotatedAt = new Date().toISOString();
    await this.#save();
    return secret;
  }

  async rotateCapture(): Promise<string> {
    const secret = token();
    this.#state.capture = verifier(secret);
    this.#state.rotatedAt = new Date().toISOString();
    await this.#save();
    return secret;
  }

  async #save(): Promise<void> {
    await atomicWrite(this.path, `${JSON.stringify(this.#state, null, 2)}\n`, 0o600);
    await chmod(this.path, 0o600);
  }
}
