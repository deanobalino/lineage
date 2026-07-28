import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { atomicWrite } from "../../domain/provenance-store.js";
import { withinPath } from "../../shared/path-safety.js";
import type { GitService } from "../git/git-service.js";

export interface RepositoryRecord {
  id: string;
  root: string;
  name: string;
  addedAt: string;
  lastOpenedAt: string;
}

interface RegistryState {
  version: 1;
  repositories: RepositoryRecord[];
}

export interface RepositoryView extends RepositoryRecord {
  available: boolean;
  reason?: string;
}

export class RepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryError";
  }
}

export class RepositoryRegistry {
  readonly path: string;
  #allowedRoots: string[] = [];
  #state: RegistryState = { version: 1, repositories: [] };

  constructor(
    readonly stateDirectory: string,
    readonly configuredRoots: string[],
    readonly git: GitService
  ) {
    this.path = join(stateDirectory, "repositories.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    this.#allowedRoots = [];
    for (const root of this.configuredRoots) {
      try {
        this.#allowedRoots.push(await realpath(root));
      } catch {
        // An unavailable configured root is omitted and remains visible in diagnostics.
      }
    }
    if (this.#allowedRoots.length === 0) throw new RepositoryError("No configured repository root is accessible.");
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as RegistryState;
      if (parsed.version !== 1 || !Array.isArray(parsed.repositories)) {
        throw new RepositoryError("Unsupported repository registry.");
      }
      this.#state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.#save();
        return;
      }
      const quarantine = `${this.path}.corrupt-${Date.now()}`;
      await rename(this.path, quarantine);
      this.#state = { version: 1, repositories: [] };
      await this.#save();
    }
  }

  get allowedRoots(): readonly string[] {
    return this.#allowedRoots;
  }

  async list(): Promise<RepositoryView[]> {
    return Promise.all(
      this.#state.repositories.map(async (record) => {
        try {
          await this.resolve(record.id);
          return { ...record, available: true };
        } catch (error) {
          return {
            ...record,
            available: false,
            reason: error instanceof Error ? error.message : "Repository unavailable."
          };
        }
      })
    );
  }

  async add(requestedPath: string): Promise<RepositoryRecord> {
    const canonical = await this.canonicalAllowed(requestedPath);
    const gitRoot = await realpath(await this.git.root(canonical));
    this.assertAllowed(gitRoot);
    if (canonical !== gitRoot && !withinPath(gitRoot, canonical)) {
      throw new RepositoryError("Selected path does not resolve inside its Git repository.");
    }
    const existing = this.#state.repositories.find((record) => record.root === gitRoot);
    if (existing) {
      existing.lastOpenedAt = new Date().toISOString();
      await this.#save();
      return existing;
    }
    const now = new Date().toISOString();
    const record: RepositoryRecord = {
      id: randomUUID(),
      root: gitRoot,
      name: basename(gitRoot),
      addedAt: now,
      lastOpenedAt: now
    };
    this.#state.repositories.push(record);
    this.#state.repositories.sort((left, right) => left.name.localeCompare(right.name));
    await this.#save();
    return record;
  }

  async remove(id: string): Promise<boolean> {
    const length = this.#state.repositories.length;
    this.#state.repositories = this.#state.repositories.filter((record) => record.id !== id);
    if (this.#state.repositories.length === length) return false;
    await this.#save();
    return true;
  }

  async touch(id: string): Promise<void> {
    const record = this.#state.repositories.find((candidate) => candidate.id === id);
    if (!record) throw new RepositoryError("Unknown repository.");
    record.lastOpenedAt = new Date().toISOString();
    await this.#save();
  }

  async resolve(id: string): Promise<RepositoryRecord> {
    const record = this.#state.repositories.find((candidate) => candidate.id === id);
    if (!record) throw new RepositoryError("Unknown repository.");
    const canonical = await realpath(record.root);
    this.assertAllowed(canonical);
    if (canonical !== record.root) throw new RepositoryError("Repository path changed after registration.");
    const gitRoot = await realpath(await this.git.root(canonical));
    if (gitRoot !== canonical) throw new RepositoryError("Registered path is no longer the Git root.");
    return record;
  }

  async resolveByRoot(requestedRoot: string): Promise<RepositoryRecord> {
    const canonical = await realpath(requestedRoot);
    this.assertAllowed(canonical);
    const record = this.#state.repositories.find((candidate) => candidate.root === canonical);
    if (!record) throw new RepositoryError("Capture repository is not registered.");
    return this.resolve(record.id);
  }

  async browse(parent?: string): Promise<Array<{ name: string; path: string; repository: boolean }>> {
    const directory = parent ? await this.canonicalAllowed(parent) : this.#allowedRoots[0]!;
    const entries = await readdir(directory, { withFileTypes: true });
    const result: Array<{ name: string; path: string; repository: boolean }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = await realpath(join(directory, entry.name));
      this.assertAllowed(path);
      let repository = false;
      try {
        repository = (await stat(join(path, ".git"))).isDirectory();
      } catch {
        repository = false;
      }
      result.push({ name: entry.name, path, repository });
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  }

  async canonicalAllowed(path: string): Promise<string> {
    const canonical = await realpath(resolve(path));
    this.assertAllowed(canonical);
    return canonical;
  }

  private assertAllowed(path: string): void {
    if (!this.#allowedRoots.some((root) => withinPath(root, path))) {
      throw new RepositoryError("Path is outside the configured repository roots.");
    }
  }

  async #save(): Promise<void> {
    await atomicWrite(this.path, `${JSON.stringify(this.#state, null, 2)}\n`, 0o600);
  }
}
