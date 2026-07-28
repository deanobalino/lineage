import { createHash } from "node:crypto";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableId(namespace: string, ...parts: Array<string | number | undefined>): string {
  return `${namespace}:${sha256(parts.map((part) => String(part ?? "")).join("|"))}`;
}

export function compareEvents(
  left: { providerSequence?: number; capturedAt: string; id: string },
  right: { providerSequence?: number; capturedAt: string; id: string }
): number {
  if (left.providerSequence !== undefined && right.providerSequence !== undefined) {
    const sequence = left.providerSequence - right.providerSequence;
    if (sequence !== 0) return sequence;
  }
  const captured = left.capturedAt.localeCompare(right.capturedAt);
  return captured === 0 ? left.id.localeCompare(right.id) : captured;
}

export function commitsMatch(left: string, right: string): boolean {
  return left === right || left.startsWith(right) || right.startsWith(left);
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
