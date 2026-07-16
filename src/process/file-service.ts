import { createHash, randomUUID } from "node:crypto";
import { link, lstat, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type {
  ByteCount,
  CapabilityDeniedError,
  CapabilityEnvelope,
  ExecutionPolicy,
  FileReadResult,
  FileService,
  FileWriteRequest,
  FileWriteResult,
  IoError,
  ProjectRepository,
  RelativePath,
  Result,
  Sha256,
  SessionRepository,
  StaleReadError,
  StoreError,
} from "../contracts/index.js";

type FileServiceDependencies = {
  readonly projects: ProjectRepository;
  readonly sessions: SessionRepository;
  readonly policy: ExecutionPolicy;
};

const pathLocks = new Map<string, Promise<void>>();

function sha256(content: Uint8Array): Sha256 {
  return createHash("sha256").update(content).digest("hex") as Sha256;
}

function byteCount(value: number): ByteCount {
  return value as ByteCount;
}

function capabilityDenied(kind: "read-files" | "write-files", reason: string): CapabilityDeniedError {
  return { kind: "capability-denied", capability: kind, reason, recoverable: true, callerAction: "request-new-child" };
}

function validation(field: string, message: string): StoreError {
  return { kind: "validation", field, message, recoverable: true, callerAction: "fix-request" };
}

function ioError(operation: string, code: string | null, recoverable = true): IoError {
  return { kind: "io-error", operation, code, recoverable, callerAction: recoverable ? "retry-with-backoff" : "abort" };
}

function notFound(path: RelativePath): StoreError {
  return { kind: "not-found", resource: "file", id: String(path), recoverable: false, callerAction: "propagate" };
}

function errorCode(error: object): string | null {
  return "code" in error && typeof error.code === "string" ? error.code : null;
}

function validateRelativePath(path: RelativePath): StoreError | null {
  const value = String(path);
  if (
    value.length === 0 ||
    value.includes("\\") ||
    isAbsolute(value) ||
    value.split("/").some((part) => part === ".." || part.length === 0) ||
    value.includes("\0")
  ) {
    return validation("path", "Path must be a normalized repository-relative POSIX path");
  }
  return null;
}

function hasPathCapability(
  capabilities: CapabilityEnvelope,
  kind: "read-files" | "write-files",
  path: RelativePath,
): boolean {
  const value = String(path);
  return capabilities.grants.some((grant) => {
    if (grant.kind !== kind) return false;
    return grant.pathPrefixes.some((prefix) => {
      const prefixValue = String(prefix).replace(/\/$/u, "");
      return prefixValue === "." || value === prefixValue || value.startsWith(`${prefixValue}/`);
    });
  });
}

function isContained(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

async function resolveExisting(root: string, path: RelativePath): Promise<Result<string, StoreError>> {
  try {
    const canonicalRoot = await realpath(root);
    const canonicalTarget = await realpath(resolve(root, String(path)));
    return isContained(canonicalRoot, canonicalTarget)
      ? { ok: true, value: canonicalTarget }
      : { ok: false, error: validation("path", "Path escapes the registered workspace through a symbolic link") };
  } catch (error) {
    return errorCode(error as object) === "ENOENT"
      ? { ok: false, error: notFound(path) }
      : { ok: false, error: ioError("file.realpath", errorCode(error as object)) };
  }
}

async function resolveForWrite(root: string, path: RelativePath): Promise<Result<string, StoreError>> {
  try {
    const canonicalRoot = await realpath(root);
    const target = resolve(canonicalRoot, String(path));
    if (!isContained(canonicalRoot, target)) {
      return { ok: false, error: validation("path", "Path escapes the registered workspace") };
    }
    const canonicalParent = await realpath(dirname(target));
    if (!isContained(canonicalRoot, canonicalParent)) {
      return { ok: false, error: validation("path", "Parent path escapes the workspace through a symbolic link") };
    }
    try {
      const targetStat = await lstat(target);
      if (targetStat.isSymbolicLink()) {
        return { ok: false, error: validation("path", "Writing through a symbolic link is forbidden") };
      }
      const canonicalTarget = await realpath(target);
      if (!isContained(canonicalRoot, canonicalTarget)) {
        return { ok: false, error: validation("path", "Path escapes the workspace through a symbolic link") };
      }
    } catch (error) {
      if (errorCode(error as object) !== "ENOENT") {
        return { ok: false, error: ioError("file.lstat", errorCode(error as object)) };
      }
    }
    return { ok: true, value: target };
  } catch (error) {
    return { ok: false, error: ioError("file.resolve-write", errorCode(error as object)) };
  }
}

async function currentSha(path: string): Promise<Result<{ readonly sha: Sha256; readonly size: ByteCount } | null, StoreError>> {
  try {
    const content = await readFile(path);
    return { ok: true, value: { sha: sha256(content), size: byteCount(content.byteLength) } };
  } catch (error) {
    return errorCode(error as object) === "ENOENT"
      ? { ok: true, value: null }
      : { ok: false, error: ioError("file.read-for-cas", errorCode(error as object)) };
  }
}

async function withPathLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(path) ?? Promise.resolve();
  const lock = Promise.withResolvers<void>();
  const current = lock.promise;
  const queued = previous.then(() => current);
  pathLocks.set(path, queued);
  await previous;
  try {
    return await operation();
  } finally {
    lock.resolve();
    if (pathLocks.get(path) === queued) pathLocks.delete(path);
  }
}

export function createFileService(options: FileServiceDependencies): FileService {
  return {
    async read(workspaceId, path, capabilities) {
      const invalid = validateRelativePath(path);
      if (invalid !== null) return { ok: false, error: invalid };
      if (!hasPathCapability(capabilities, "read-files", path)) {
        return { ok: false, error: capabilityDenied("read-files", `Read access to ${String(path)} is not granted`) };
      }
      const workspace = await options.projects.getWorkspace(workspaceId);
      if (!workspace.ok) return workspace;
      const resolved = await resolveExisting(String(workspace.value.path), path);
      if (!resolved.ok) return resolved;
      try {
        const content = await readFile(resolved.value);
        return {
          ok: true,
          value: {
            path,
            content: content.toString("utf8"),
            sha: sha256(content),
            size: byteCount(content.byteLength),
          } satisfies FileReadResult,
        };
      } catch (error) {
        return { ok: false, error: ioError("file.read", errorCode(error as object)) };
      }
    },

    async write(request: FileWriteRequest, capabilities: CapabilityEnvelope) {
      const invalid = validateRelativePath(request.path);
      if (invalid !== null) return { ok: false, error: invalid };
      if (!hasPathCapability(capabilities, "write-files", request.path)) {
        return { ok: false, error: capabilityDenied("write-files", `Write access to ${String(request.path)} is not granted`) };
      }
      const session = await options.sessions.get(request.sessionId);
      if (!session.ok) return { ok: false, error: ioError("session.get-for-file-policy", null) };
      if (session.value.header.workspaceId !== request.workspaceId) {
        return { ok: false, error: validation("workspaceId", "Workspace does not belong to the authorizing session") };
      }
      const policy = await options.policy.evaluate({
        sessionId: request.sessionId,
        facts: {
          kind: "file-write",
          workspaceId: request.workspaceId,
          path: request.path,
          expectedSha: request.expectedSha,
        },
        capabilityEnvelope: capabilities,
        profile: session.value.header.policyProfile,
      });
      if (!policy.ok) {
        return {
          ok: false,
          error: {
            kind: "policy-denied",
            reason: "Execution policy could not evaluate the file write",
            ruleId: "policy-evaluation-failed",
            recoverable: false,
            callerAction: "abort",
          },
        };
      }
      if (policy.value.outcome !== "allow") {
        return {
          ok: false,
          error: {
            kind: "policy-denied",
            reason: policy.value.reason,
            ruleId: policy.value.outcome === "deny" ? policy.value.ruleId : String(policy.value.escalationId),
            recoverable: false,
            callerAction: "abort",
          },
        };
      }
      const workspace = await options.projects.getWorkspace(request.workspaceId);
      if (!workspace.ok) return workspace;
      const resolved = await resolveForWrite(String(workspace.value.path), request.path);
      if (!resolved.ok) return resolved;
      return withPathLock(resolved.value, async () => {
        const before = await currentSha(resolved.value);
        if (!before.ok) return before;
        if (request.expectedSha === null && before.value !== null) {
          const stale: StaleReadError = {
            kind: "stale-read",
            path: request.path,
            expectedSha: sha256(Buffer.alloc(0)),
            actualSha: before.value.sha,
            recoverable: true,
            callerAction: "reread-and-retry",
          };
          return { ok: false, error: stale };
        }
        if (request.expectedSha !== null && (before.value === null || before.value.sha !== request.expectedSha)) {
          if (before.value === null) return { ok: false, error: notFound(request.path) };
          const stale: StaleReadError = {
            kind: "stale-read",
            path: request.path,
            expectedSha: request.expectedSha,
            actualSha: before.value.sha,
            recoverable: true,
            callerAction: "reread-and-retry",
          };
          return { ok: false, error: stale };
        }
        const content = Buffer.from(request.content, "utf8");
        const temporary = `${resolved.value}.omega-${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
          if (request.expectedSha === null) {
            await link(temporary, resolved.value);
            await unlink(temporary);
          } else {
            const rechecked = await currentSha(resolved.value);
            if (!rechecked.ok) return rechecked;
            if (rechecked.value === null || rechecked.value.sha !== request.expectedSha) {
              if (rechecked.value === null) return { ok: false, error: notFound(request.path) };
              return {
                ok: false,
                error: {
                  kind: "stale-read",
                  path: request.path,
                  expectedSha: request.expectedSha,
                  actualSha: rechecked.value.sha,
                  recoverable: true,
                  callerAction: "reread-and-retry",
                } satisfies StaleReadError,
              };
            }
            await rename(temporary, resolved.value);
          }
          const result: FileWriteResult = {
            path: request.path,
            previousSha: before.value?.sha ?? null,
            sha: sha256(content),
            size: byteCount(content.byteLength),
          };
          return { ok: true, value: result };
        } catch (error) {
          try { await unlink(temporary); } catch { /* The temporary may already have been linked and removed. */ }
          const code = errorCode(error as object);
          if (request.expectedSha === null && code === "EEXIST") {
            const actual = await currentSha(resolved.value);
            if (actual.ok && actual.value !== null) {
              return {
                ok: false,
                error: {
                  kind: "stale-read",
                  path: request.path,
                  expectedSha: sha256(Buffer.alloc(0)),
                  actualSha: actual.value.sha,
                  recoverable: true,
                  callerAction: "reread-and-retry",
                } satisfies StaleReadError,
              };
            }
          }
          return { ok: false, error: ioError("file.write", code) };
        }
      });
    },
  };
}
