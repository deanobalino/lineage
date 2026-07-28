import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type ContainedPathStatus =
  | "file"
  | "directory"
  | "missing"
  | "unsafe"
  | "other";

export interface ContainedPath {
  path: string;
  status: ContainedPathStatus;
}

export interface BoundedTextFile {
  path: string;
  text: string;
  bytes: number;
  size: number;
  truncated: boolean;
}

export function withinPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function safeRelativePath(path: string): boolean {
  if (!path || path.includes("\0") || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) {
    return false;
  }
  const parts = path.split(/[\\/]/);
  return !parts.some((part) => part === "" || part === "." || part === "..");
}

export async function inspectContainedPath(
  root: string,
  relativePath: string
): Promise<ContainedPath> {
  const canonicalRoot = await realpath(root);
  if (!safeRelativePath(relativePath)) {
    return { path: resolve(canonicalRoot, relativePath), status: "unsafe" };
  }
  const candidate = resolve(canonicalRoot, ...relativePath.split(/[\\/]/));
  if (!withinPath(canonicalRoot, candidate)) {
    return { path: candidate, status: "unsafe" };
  }

  let current = canonicalRoot;
  const parts = relative(canonicalRoot, candidate).split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]!);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) return { path: candidate, status: "unsafe" };
      if (index < parts.length - 1 && !entry.isDirectory()) {
        return { path: candidate, status: "unsafe" };
      }
      if (index === parts.length - 1) {
        if (entry.isFile()) return { path: candidate, status: "file" };
        if (entry.isDirectory()) return { path: candidate, status: "directory" };
        return { path: candidate, status: "other" };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { path: candidate, status: "missing" };
      }
      return { path: candidate, status: "unsafe" };
    }
  }
  return { path: candidate, status: "directory" };
}

export async function readBoundedContainedTextFile(
  root: string,
  relativePath: string,
  maxBytes: number
): Promise<BoundedTextFile | undefined> {
  const inspected = await inspectContainedPath(root, relativePath);
  if (inspected.status !== "file") return undefined;
  return readBoundedTextFile(inspected.path, maxBytes);
}

export async function readBoundedTextFile(
  path: string,
  maxBytes: number
): Promise<BoundedTextFile | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) return undefined;
    const capacity = maxBytes + 1;
    const buffer = Buffer.allocUnsafe(capacity);
    let offset = 0;
    while (offset < capacity) {
      const result = await handle.read(buffer, offset, capacity - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const truncated = metadata.size > maxBytes || offset > maxBytes;
    const bytes = Math.min(offset, maxBytes);
    return {
      path,
      text: buffer.subarray(0, bytes).toString("utf8"),
      bytes,
      size: metadata.size,
      truncated
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}
