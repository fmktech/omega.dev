import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { link, mkdir, open, readFile, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import type {
  ByteCount,
  CreateFileObjectStore,
  ObjectDescriptor,
  ObjectHash,
  Result,
  Sha256,
  StoreError,
  Timestamp,
} from "../contracts/index.js";
import {
  atomicWriteFile,
  fileExists,
  ioError,
  isNodeError,
  timestampNow,
  validationError,
  withFileLock,
} from "./artifact-store.js";

type StoredObjectMetadata = {
  readonly hash: ObjectHash;
  readonly size: ByteCount;
  readonly mediaType: string;
  readonly createdAt: Timestamp;
};

export const createFileObjectStore: CreateFileObjectStore = (root) => ({
  async put(mediaType, chunks) {
    if (mediaType.trim().length === 0 || /[\r\n]/u.test(mediaType)) {
      return { ok: false, error: validationError("mediaType must be a non-empty single-line value", "mediaType") };
    }
    const temporaryDirectory = join(root, "objects", "tmp");
    const temporaryPath = join(temporaryDirectory, `${process.pid}-${randomUUID()}`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      await mkdir(temporaryDirectory, { recursive: true });
      handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      const digest = createHash("sha256");
      let size = 0;
      for await (const chunk of chunks) {
        digest.update(chunk);
        size += chunk.byteLength;
        if (!Number.isSafeInteger(size)) {
          return { ok: false, error: validationError("Object exceeds the supported byte range", "chunks") };
        }
        await handle.writeFile(chunk);
      }
      await handle.sync();
      await handle.close();
      handle = null;

      const hash = digest.digest("hex") as ObjectHash;
      const descriptor: ObjectDescriptor = {
        hash,
        size: size as ByteCount,
        mediaType,
        createdAt: timestampNow(),
      };
      const dataPath = objectDataPath(root, hash);
      const metadataPath = objectMetadataPath(root, hash);
      await mkdir(join(root, "objects", "sha256", hash.slice(0, 2)), { recursive: true });

      try {
        await link(temporaryPath, dataPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
        const verified = await verifyObject(root, hash);
        if (!verified.ok) {
          return verified;
        }
      }
      await unlink(temporaryPath).catch(() => undefined);

      return await withFileLock(metadataPath, async () => {
        if (await fileExists(metadataPath)) {
          const existing = await readMetadata(metadataPath);
          if (!existing.ok) {
            return existing;
          }
          if (existing.value.size !== descriptor.size || existing.value.mediaType !== descriptor.mediaType) {
            return {
              ok: false,
              error: {
                kind: "conflict",
                resource: "object-metadata",
                expected: `${descriptor.size}:${descriptor.mediaType}`,
                actual: `${existing.value.size}:${existing.value.mediaType}`,
                recoverable: true,
                callerAction: "refresh-version-and-retry",
              },
            };
          }
          return { ok: true, value: existing.value };
        }
        await atomicWriteFile(metadataPath, `${JSON.stringify(descriptor)}\n`);
        return { ok: true, value: descriptor };
      });
    } catch (error) {
      return { ok: false, error: ioError("put-object", error) };
    } finally {
      if (handle !== null) {
        await handle.close().catch(() => undefined);
      }
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  },

  async get(hash) {
    const valid = validateHash(hash);
    if (!valid.ok) {
      return valid;
    }
    const verified = await verifyObject(root, hash);
    if (!verified.ok) {
      return verified;
    }
    const dataPath = objectDataPath(root, hash);
    return {
      ok: true,
      value: (async function* readObject(): AsyncIterable<Uint8Array> {
        for await (const chunk of createReadStream(dataPath)) {
          yield chunk;
        }
      })(),
    };
  },

  async describe(hash) {
    const valid = validateHash(hash);
    if (!valid.ok) {
      return valid;
    }
    const verified = await verifyObject(root, hash);
    if (!verified.ok) {
      return verified;
    }
    return readMetadata(objectMetadataPath(root, hash));
  },
});

function objectDataPath(root: string, hash: ObjectHash): string {
  return join(root, "objects", "sha256", hash.slice(0, 2), `${hash}.data`);
}

function objectMetadataPath(root: string, hash: ObjectHash): string {
  return join(root, "objects", "sha256", hash.slice(0, 2), `${hash}.json`);
}

function validateHash(hash: ObjectHash): Result<void, StoreError> {
  if (!/^[a-f0-9]{64}$/u.test(hash)) {
    return { ok: false, error: validationError("Object hash must be lowercase SHA-256 hexadecimal", "hash") };
  }
  return { ok: true, value: undefined };
}

async function verifyObject(root: string, hash: ObjectHash): Promise<Result<void, StoreError>> {
  const path = objectDataPath(root, hash);
  try {
    if (!(await fileExists(path))) {
      return {
        ok: false,
        error: { kind: "not-found", resource: "object", id: hash, recoverable: false, callerAction: "propagate" },
      };
    }
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(path)) {
      digest.update(chunk);
    }
    const actual = digest.digest("hex") as Sha256;
    if ((actual as string) !== (hash as string)) {
      return {
        ok: false,
        error: {
          kind: "integrity-failure",
          resource: "object",
          expected: hash as string as Sha256,
          actual,
          recoverable: false,
          callerAction: "abort",
        },
      };
    }
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: ioError("verify-object", error) };
  }
}

async function readMetadata(path: string): Promise<Result<ObjectDescriptor, StoreError>> {
  try {
    if (!(await fileExists(path))) {
      return {
        ok: false,
        error: { kind: "not-found", resource: "object-metadata", id: path, recoverable: false, callerAction: "propagate" },
      };
    }
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isMetadata(parsed)) {
      return { ok: false, error: validationError("Stored object metadata is malformed", null) };
    }
    const file = await stat(path.replace(/\.json$/u, ".data"));
    if (file.size !== parsed.size) {
      return {
        ok: false,
        error: {
          kind: "integrity-failure",
          resource: "object-size",
          expected: createHash("sha256").update(String(parsed.size)).digest("hex") as Sha256,
          actual: createHash("sha256").update(String(file.size)).digest("hex") as Sha256,
          recoverable: false,
          callerAction: "abort",
        },
      };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, error: ioError("read-object-metadata", error) };
  }
}

function isMetadata(value: unknown): value is StoredObjectMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate["hash"] === "string" && /^[a-f0-9]{64}$/u.test(candidate["hash"])
    && typeof candidate["size"] === "number" && Number.isSafeInteger(candidate["size"]) && candidate["size"] >= 0
    && typeof candidate["mediaType"] === "string" && candidate["mediaType"].length > 0
    && typeof candidate["createdAt"] === "string";
}
