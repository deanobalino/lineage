import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEnvelope,
  type CaptureEnvelope
} from "../../../src/capture/envelope.js";
import { CaptureOutbox } from "../../../src/capture/outbox.js";
import {
  codexHooks,
  copilotHooks,
  harnessStatus,
  installHarness
} from "../../../src/capture/hooks.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "lineage-outbox-"));
  roots.push(path);
  return path;
}

function envelope(id: string): CaptureEnvelope {
  const result = createEnvelope({
    input: {
      provider_event_name: "UserPromptSubmit",
      session_id: "session"
    },
    ingestionId: id,
    capturedAt: "2026-07-28T00:00:00Z",
    cwd: "/repo",
    repoRoot: "/repo"
  });
  result.evidenceComplete = true;
  delete result.evidenceIssue;
  return result;
}

describe("capture outbox", () => {
  it("stages raw input outside the replay set and finalizes it atomically", async () => {
    const directory = await root();
    const outbox = new CaptureOutbox(directory);
    const item = envelope("staged");
    item.evidenceComplete = false;
    item.evidenceIssue = "pending";
    await outbox.stage(item);
    expect(await outbox.claimNext()).toBeUndefined();
    expect((await outbox.status()).staging).toBe(1);

    item.evidenceComplete = true;
    delete item.evidenceIssue;
    await outbox.finalizeStaged(item);
    const claim = await outbox.claimNext();
    expect(claim?.envelope).toMatchObject({
      ingestionId: "staged",
      evidenceComplete: true
    });
    await outbox.complete(claim!);
    expect(await outbox.status()).toMatchObject({
      staging: 0,
      pending: 0,
      claimed: 0
    });
  });

  it("recovers stale leases, retries dead letters, and enforces quotas", async () => {
    const directory = await root();
    const outbox = new CaptureOutbox(directory, {
      maxItems: 2,
      maxBytes: 64 * 1024,
      leaseMs: 1
    });
    await outbox.enqueue(envelope("one"));
    const claim = await outbox.claimNext(1);
    expect(claim).toBeDefined();
    const recovered = await outbox.claimNext(10);
    expect(recovered?.envelope.ingestionId).toBe("one");
    await outbox.deadLetter(recovered!, "bad repository");
    expect((await outbox.status()).deadLetters).toBe(1);
    expect(await outbox.retryDeadLetters()).toBe(1);
    expect((await outbox.status()).pending).toBe(1);
    await outbox.enqueue(envelope("two"));
    await expect(outbox.enqueue(envelope("three"))).rejects.toThrow("quota");
  });

  it("recovers process-killed staging records and orders provider sequences", async () => {
    const directory = await root();
    const outbox = new CaptureOutbox(directory, {
      maxItems: 10,
      maxBytes: 64 * 1024,
      leaseMs: 1
    });
    const interrupted = envelope("interrupted");
    interrupted.evidenceComplete = false;
    interrupted.evidenceIssue = "pending";
    await outbox.stage(interrupted);
    const recovered = await outbox.claimNext(Date.now() + 10);
    expect(recovered?.envelope).toMatchObject({
      ingestionId: "interrupted",
      evidenceComplete: false,
      evidenceIssue: expect.stringContaining("before Git evidence finalized")
    });
    await outbox.complete(recovered!);

    const second = envelope("sequence-two");
    second.providerSequence = 2;
    const first = envelope("sequence-one");
    first.providerSequence = 1;
    await outbox.enqueue(second);
    await outbox.enqueue(first);
    const firstClaim = await outbox.claimNext();
    expect(firstClaim?.envelope.ingestionId).toBe("sequence-one");
    await outbox.complete(firstClaim!);
    const secondClaim = await outbox.claimNext();
    expect(secondClaim?.envelope.ingestionId).toBe("sequence-two");
  });
});

describe("harness installation", () => {
  it("preserves unrelated Codex and Copilot configuration and remains idempotent", async () => {
    const repository = await root();
    await mkdir(join(repository, ".codex"), { recursive: true });
    await writeFile(
      join(repository, ".codex/config.toml"),
      `[features]\nother = true\n\n[[hooks.Notification]]\ncustom = "keep"\n`,
      "utf8"
    );
    await installHarness(repository, "codex", '"/usr/bin/node" "/state/lineage-capture.mjs"');
    await installHarness(repository, "codex", '"/usr/bin/node" "/state/lineage-capture.mjs"');
    const codex = await readFile(join(repository, ".codex/config.toml"), "utf8");
    expect(codex).toContain('custom = "keep"');
    expect(codex.match(/>>> lineage managed hooks/g)).toHaveLength(1);
    expect(codex.match(/\[\[hooks\.Stop\]\]/g)).toHaveLength(1);
    expect(await harnessStatus(repository, "codex")).toMatchObject({
      configured: true,
      owned: true
    });

    await mkdir(join(repository, ".github/hooks"), { recursive: true });
    await writeFile(
      join(repository, ".github/hooks/lineage-copilot.json"),
      JSON.stringify({ version: 1, hooks: { Notification: [{ command: "keep" }] } }),
      "utf8"
    );
    await installHarness(repository, "github-copilot", "node capture.mjs");
    const copilot = JSON.parse(
      await readFile(join(repository, ".github/hooks/lineage-copilot.json"), "utf8")
    ) as { hooks: Record<string, unknown> };
    expect(copilot.hooks["Notification"]).toEqual([{ command: "keep" }]);
    expect(copilot.hooks["SessionEnd"]).toBeDefined();

    const legacy = codexHooks("lineage-capture")
      .replace("# >>> lineage managed hooks >>>\n", "")
      .replace("\n# <<< lineage managed hooks <<<", "");
    await writeFile(
      join(repository, ".codex/config.toml"),
      `[features]\nother = true\n\n${legacy}\n\n[custom]\nkeep = true\n`,
      "utf8"
    );
    await installHarness(repository, "codex", "node /state/lineage-capture.mjs");
    const migrated = await readFile(join(repository, ".codex/config.toml"), "utf8");
    expect(migrated).toContain("keep = true");
    expect(migrated.match(/\[\[hooks\.Stop\]\]/g)).toHaveLength(1);
  });

  it("emits every frozen provider lifecycle", () => {
    const codex = codexHooks("lineage-capture");
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "Stop"
    ]) {
      expect(codex).toContain(`[[hooks.${event}]]`);
    }
    const copilot = copilotHooks("lineage-capture") as {
      hooks: Record<string, unknown>;
    };
    expect(Object.keys(copilot.hooks).sort()).toEqual([
      "PermissionRequest",
      "PostToolUse",
      "PostToolUseFailure",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "UserPromptSubmit"
    ]);
  });
});
