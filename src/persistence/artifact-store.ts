import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  ArtifactId,
  ArtifactRecord,
  ArtifactSlice,
  ByteCount,
  IoError,
  ObjectStore,
  Result,
  SessionError,
  Timestamp,
  ValidationError,
} from "../contracts/index.js";

const LOCK_RETRIES = 400;
const LOCK_RETRY_MS = 5;
const MALFORMED_LOCK_STALE_MS = 250;

export function safeStorageKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function timestampNow(): Timestamp {
  return new Date().toISOString() as Timestamp;
}

export function ioError(operation: string, error: unknown): IoError {
  const code = isNodeError(error) ? error.code ?? null : null;
  return {
    kind: "io-error",
    operation,
    code,
    recoverable: code === "EAGAIN" || code === "EBUSY" || code === "EMFILE" || code === "ENFILE",
    callerAction: code === "EAGAIN" || code === "EBUSY" || code === "EMFILE" || code === "ENFILE"
      ? "retry-with-backoff"
      : "propagate",
  };
}

export function validationError(message: string, field: string | null): ValidationError {
  return {
    kind: "validation",
    message,
    field,
    recoverable: true,
    callerAction: "fix-request",
  };
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function atomicWriteFile(path: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${safeStorageKey(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (handle !== null) {
      await handle.close().catch(() => undefined);
    }
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function withFileLock<T>(resourcePath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${resourcePath}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    const ownerPath = `${lockPath}.${process.pid}.${randomUUID()}.owner`;
    try {
      handle = await open(ownerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.sync();
      await link(ownerPath, lockPath);
      await rm(ownerPath);
      break;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = null;
      await rm(ownerPath, { force: true }).catch(() => undefined);
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
      if (await reclaimDeadOwnerLock(lockPath)) {
        continue;
      }
      if (attempt === LOCK_RETRIES - 1) {
        const busy = new Error(`Timed out acquiring lock for ${resourcePath}`) as NodeJS.ErrnoException;
        busy.code = "EBUSY";
        throw busy;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  if (handle === null) {
    throw new Error(`Failed to acquire lock for ${resourcePath}`);
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function reclaimDeadOwnerLock(lockPath: string): Promise<boolean> {
  let owner: string;
  try {
    owner = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    throw error;
  }
  const match = /^([1-9]\d*)\n$/u.exec(owner);
  const pid = match === null ? null : Number(match[1]);
  if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 0 || processIsAlive(pid))) return false;
  if (pid === null) {
    const malformed = await stat(lockPath);
    if (Date.now() - malformed.mtimeMs < MALFORMED_LOCK_STALE_MS) return false;
  }

  // A hard-link claim serializes competing reclaimers without replacing the
  // original O_EXCL lock. Once claimed, the dead owner cannot release it and
  // no new live owner can acquire the primary path before it is removed.
  const claimPath = `${lockPath}.reclaim`;
  try {
    await link(lockPath, claimPath);
  } catch (error) {
    if (isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOENT")) return false;
    throw error;
  }
  try {
    const [locked, claimed, claimedOwner] = await Promise.all([
      stat(lockPath),
      stat(claimPath),
      readFile(claimPath, "utf8"),
    ]);
    if (locked.dev !== claimed.dev || locked.ino !== claimed.ino || claimedOwner !== owner
      || (pid !== null && processIsAlive(pid))) {
      return false;
    }
    await rm(lockPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  } finally {
    await rm(claimPath, { force: true }).catch(() => undefined);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === "ESRCH");
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function artifactRecordPath(root: string, id: ArtifactId): string {
  return join(root, "artifact-index", `${safeStorageKey(id)}.json`);
}

export async function storeArtifactRecord(
  root: string,
  objects: ObjectStore,
  record: ArtifactRecord,
  projectStorageKey: string,
): Promise<Result<ArtifactRecord, SessionError>> {
  const described = await objects.describe(record.object.hash);
  if (!described.ok) {
    return described;
  }
  if (described.value.size !== record.object.size || described.value.mediaType !== record.object.mediaType
    || described.value.createdAt !== record.object.createdAt) {
    return {
      ok: false,
      error: {
        kind: "conflict",
        resource: "artifact-object-descriptor",
        expected: `${record.object.size}:${record.object.mediaType}:${record.object.createdAt}`,
        actual: `${described.value.size}:${described.value.mediaType}:${described.value.createdAt}`,
        recoverable: true,
        callerAction: "refresh-version-and-retry",
      },
    };
  }

  const globalPath = artifactRecordPath(root, record.id);
  const localPath = join(
    root,
    "projects",
    projectStorageKey,
    "sessions",
    safeStorageKey(record.sessionId),
    "artifacts",
    `${safeStorageKey(record.id)}.json`,
  );
  try {
    return await withFileLock(globalPath, async () => {
      if (await fileExists(globalPath)) {
        const existing = parseArtifactRecord(await readFile(globalPath, "utf8"));
        if (!existing.ok) {
          return existing;
        }
        if (JSON.stringify(existing.value) !== JSON.stringify(record)) {
          return {
            ok: false,
            error: {
              kind: "conflict",
              resource: "artifact",
              expected: record.id,
              actual: existing.value.id,
              recoverable: true,
              callerAction: "refresh-version-and-retry",
            },
          };
        }
        if (!(await fileExists(localPath))) {
          await atomicWriteFile(localPath, `${JSON.stringify(existing.value)}\n`);
        }
        return { ok: true, value: existing.value };
      }
      const encoded = `${JSON.stringify(record)}\n`;
      await atomicWriteFile(localPath, encoded);
      await atomicWriteFile(globalPath, encoded);
      return { ok: true, value: record };
    });
  } catch (error) {
    return { ok: false, error: ioError("record-artifact", error) };
  }
}

export async function loadArtifactSlice(
  root: string,
  objects: ObjectStore,
  id: ArtifactId,
  offset: ByteCount,
  limit: ByteCount,
): Promise<Result<ArtifactSlice, SessionError>> {
  if (!isByteCount(offset) || !isByteCount(limit)) {
    return { ok: false, error: validationError("Artifact offset and limit must be non-negative integers", "range") };
  }
  const path = artifactRecordPath(root, id);
  let record: Result<ArtifactRecord, SessionError>;
  try {
    if (!(await fileExists(path))) {
      return {
        ok: false,
        error: { kind: "not-found", resource: "artifact", id, recoverable: false, callerAction: "propagate" },
      };
    }
    record = parseArtifactRecord(await readFile(path, "utf8"));
  } catch (error) {
    return { ok: false, error: ioError("read-artifact-record", error) };
  }
  if (!record.ok) {
    return record;
  }
  const object = await objects.get(record.value.object.hash);
  if (!object.ok) {
    return object;
  }
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of object.value) {
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (offset > bytes.byteLength) {
      return { ok: false, error: validationError("Artifact offset exceeds object size", "offset") };
    }
    const end = Math.min(bytes.byteLength, offset + limit);
    const selected = bytes.subarray(offset, end);
    let encoding: "utf8" | "base64" = "utf8";
    let data: string;
    try {
      data = new TextDecoder("utf-8", { fatal: true }).decode(selected);
    } catch {
      encoding = "base64";
      data = selected.toString("base64");
    }
    return {
      ok: true,
      value: {
        artifact: record.value,
        range: { startInclusive: offset, endExclusive: end as ByteCount },
        encoding,
        data,
        complete: end === bytes.byteLength,
      },
    };
  } catch (error) {
    return { ok: false, error: ioError("read-artifact-object", error) };
  }
}

function parseArtifactRecord(encoded: string): Result<ArtifactRecord, SessionError> {
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!isRecord(parsed) || typeof parsed["id"] !== "string" || typeof parsed["sessionId"] !== "string"
      || typeof parsed["kind"] !== "string" || typeof parsed["createdAt"] !== "string" || !isRecord(parsed["object"])
      || typeof parsed["object"]["hash"] !== "string" || typeof parsed["object"]["size"] !== "number"
      || typeof parsed["object"]["mediaType"] !== "string" || typeof parsed["object"]["createdAt"] !== "string"
      || !isRecord(parsed["metadata"])) {
      return { ok: false, error: validationError("Stored artifact record is malformed", null) };
    }
    return { ok: true, value: parsed as ArtifactRecord };
  } catch (error) {
    return { ok: false, error: ioError("parse-artifact-record", error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isByteCount(value: ByteCount): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
