import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises";
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
  /** Deterministic race injection used by the process-runtime security tests. */
  readonly beforeDescriptorOpen?: (target: string) => Promise<void>;
};

type FileIdentity = {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
};

type VerifiedFile = {
  readonly handle: FileHandle;
  readonly target: string;
  readonly root: string;
  readonly directories: readonly FileIdentity[];
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

function noFollowFlag(): Result<number, StoreError> {
  return typeof constants.O_NOFOLLOW === "number" && constants.O_NOFOLLOW !== 0
    ? { ok: true, value: constants.O_NOFOLLOW }
    : { ok: false, error: ioError("file.open-no-follow-unsupported", "ENOTSUP", false) };
}

async function directoryIdentities(root: string, target: string): Promise<Result<readonly FileIdentity[], StoreError>> {
  const parent = dirname(target);
  if (!isContained(root, parent)) return { ok: false, error: validation("path", "Parent path escapes the workspace") };
  const fromRoot = relative(root, parent);
  const paths = [root];
  if (fromRoot !== "") {
    let cursor = root;
    for (const component of fromRoot.split(sep)) {
      cursor = resolve(cursor, component);
      paths.push(cursor);
    }
  }
  const identities: FileIdentity[] = [];
  try {
    for (const path of paths) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return { ok: false, error: validation("path", "Workspace path components must be real directories") };
      }
      identities.push({ path, device: stat.dev, inode: stat.ino });
    }
    return { ok: true, value: identities };
  } catch (error) {
    return errorCode(error as object) === "ENOENT"
      ? { ok: false, error: validation("path", "Parent directory does not exist") }
      : { ok: false, error: ioError("file.verify-directory-chain", errorCode(error as object)) };
  }
}

async function verifyDirectories(identities: readonly FileIdentity[]): Promise<Result<void, StoreError>> {
  try {
    for (const identity of identities) {
      const stat = await lstat(identity.path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.device || stat.ino !== identity.inode) {
        return { ok: false, error: validation("path", "Workspace directory changed during file access") };
      }
    }
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: validation("path", `Workspace directory changed during file access (${errorCode(error as object) ?? "unknown"})`) };
  }
}

async function verifyDescriptor(file: VerifiedFile): Promise<Result<void, StoreError>> {
  try {
    const [descriptor, pathStat, canonicalTarget] = await Promise.all([
      file.handle.stat(),
      lstat(file.target),
      realpath(file.target),
    ]);
    if (pathStat.isSymbolicLink() || descriptor.dev !== pathStat.dev || descriptor.ino !== pathStat.ino) {
      return { ok: false, error: validation("path", "File changed during descriptor verification") };
    }
    if (!isContained(file.root, canonicalTarget)) {
      return { ok: false, error: validation("path", "Path escapes the registered workspace") };
    }
    return verifyDirectories(file.directories);
  } catch (error) {
    const code = errorCode(error as object);
    return code === "ELOOP"
      ? { ok: false, error: validation("path", "Symbolic-link file access is forbidden") }
      : { ok: false, error: validation("path", `File changed during descriptor verification (${code ?? "unknown"})`) };
  }
}

async function openVerified(
  rootPath: string,
  path: RelativePath,
  flags: number,
  mode: number | undefined,
  beforeOpen: FileServiceDependencies["beforeDescriptorOpen"],
): Promise<Result<VerifiedFile, StoreError>> {
  const noFollow = noFollowFlag();
  if (!noFollow.ok) return noFollow;
  try {
    const root = await realpath(rootPath);
    const target = resolve(root, String(path));
    if (!isContained(root, target)) return { ok: false, error: validation("path", "Path escapes the registered workspace") };
    const directories = await directoryIdentities(root, target);
    if (!directories.ok) return directories;
    await beforeOpen?.(target);
    const handle = await open(target, flags | noFollow.value, mode);
    const file = { handle, target, root, directories: directories.value } satisfies VerifiedFile;
    const verified = await verifyDescriptor(file);
    if (!verified.ok) {
      await handle.close();
      return verified;
    }
    return { ok: true, value: file };
  } catch (error) {
    const code = errorCode(error as object);
    if (code === "ELOOP") return { ok: false, error: validation("path", "Symbolic-link file access is forbidden") };
    if (code === "ENOENT") return { ok: false, error: notFound(path) };
    if (code === "EINVAL" || code === "ENOTSUP") {
      return { ok: false, error: ioError("file.open-no-follow-unsupported", code, false) };
    }
    return { ok: false, error: ioError("file.open-verified", code) };
  }
}

async function descriptorContent(file: VerifiedFile): Promise<Result<Buffer, StoreError>> {
  try {
    const content = await file.handle.readFile();
    const verified = await verifyDescriptor(file);
    return verified.ok ? { ok: true, value: content } : verified;
  } catch (error) {
    return { ok: false, error: ioError("file.read-descriptor", errorCode(error as object)) };
  }
}

async function overwriteDescriptor(file: VerifiedFile, content: Buffer, truncateFirst: boolean): Promise<void> {
  if (truncateFirst) await file.handle.truncate(0);
  let offset = 0;
  while (offset < content.byteLength) {
    const written = await file.handle.write(content, offset, content.byteLength - offset, offset);
    if (written.bytesWritten === 0) throw new Error("Descriptor write made no progress");
    offset += written.bytesWritten;
  }
  await file.handle.sync();
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try { await handle.close(); } catch { /* Best-effort close on a failed operation. */ }
}

async function removeCreatedFile(file: VerifiedFile): Promise<void> {
  const verified = await verifyDescriptor(file);
  if (verified.ok) {
    try { await unlink(file.target); } catch { /* A concurrent actor may already have removed it. */ }
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
      const opened = await openVerified(
        String(workspace.value.path),
        path,
        constants.O_RDONLY,
        undefined,
        options.beforeDescriptorOpen,
      );
      if (!opened.ok) return opened;
      try {
        const content = await descriptorContent(opened.value);
        if (!content.ok) return content;
        return {
          ok: true,
          value: {
            path,
            content: content.value.toString("utf8"),
            sha: sha256(content.value),
            size: byteCount(content.value.byteLength),
          } satisfies FileReadResult,
        };
      } finally {
        await closeQuietly(opened.value.handle);
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
        if (policy.value.outcome === "deny") {
          return {
            ok: false,
            error: {
              kind: "policy-denied",
              reason: policy.value.reason,
              ruleId: policy.value.ruleId,
              recoverable: false,
              callerAction: "abort",
            },
          };
        }
        const resolution = await waitForPolicyResolution(
          options.policy,
          policy.value.escalationId,
          Date.parse(String(capabilities.createdAt)) + Number(capabilities.wallTimeMs),
        );
        if (resolution !== "allow") {
          return {
            ok: false,
            error: {
              kind: "policy-denied",
              reason: policy.value.reason,
              ruleId: String(policy.value.escalationId),
              recoverable: false,
              callerAction: "abort",
            },
          };
        }
      }
      const workspace = await options.projects.getWorkspace(request.workspaceId);
      if (!workspace.ok) return workspace;
      const target = resolve(String(workspace.value.path), String(request.path));
      return withPathLock(target, async () => {
        const content = Buffer.from(request.content, "utf8");
        const creating = request.expectedSha === null;
        const opened = await openVerified(
          String(workspace.value.path),
          request.path,
          creating ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL : constants.O_RDWR,
          creating ? 0o600 : undefined,
          options.beforeDescriptorOpen,
        );
        if (!opened.ok) {
          if (creating && opened.error.kind === "io-error" && opened.error.code === "EEXIST") {
            const actual = await openVerified(
              String(workspace.value.path), request.path, constants.O_RDONLY, undefined, undefined,
            );
            if (!actual.ok) return actual;
            try {
              const existing = await descriptorContent(actual.value);
              if (!existing.ok) return existing;
              return {
                ok: false,
                error: {
                  kind: "stale-read",
                  path: request.path,
                  expectedSha: sha256(Buffer.alloc(0)),
                  actualSha: sha256(existing.value),
                  recoverable: true,
                  callerAction: "reread-and-retry",
                } satisfies StaleReadError,
              };
            } finally {
              await closeQuietly(actual.value.handle);
            }
          }
          return opened;
        }
        let keepCreated = false;
        try {
          let previousSha: Sha256 | null = null;
          if (!creating) {
            const beforeContent = await descriptorContent(opened.value);
            if (!beforeContent.ok) return beforeContent;
            const actualSha = sha256(beforeContent.value);
            if (request.expectedSha !== actualSha) {
              return {
                ok: false,
                error: {
                  kind: "stale-read",
                  path: request.path,
                  expectedSha: request.expectedSha ?? sha256(Buffer.alloc(0)),
                  actualSha,
                  recoverable: true,
                  callerAction: "reread-and-retry",
                } satisfies StaleReadError,
              };
            }
            previousSha = actualSha;
          }
          await overwriteDescriptor(opened.value, content, !creating);
          const verified = await verifyDescriptor(opened.value);
          if (!verified.ok) return verified;
          keepCreated = true;
          const result: FileWriteResult = {
            path: request.path,
            previousSha,
            sha: sha256(content),
            size: byteCount(content.byteLength),
          };
          return { ok: true, value: result };
        } catch (error) {
          return { ok: false, error: ioError("file.write-descriptor", errorCode(error as object)) };
        } finally {
          if (creating && !keepCreated) await removeCreatedFile(opened.value);
          await closeQuietly(opened.value.handle);
        }
      });
    },
  };
}

async function waitForPolicyResolution(
  policy: FileServiceDependencies["policy"],
  escalationId: Parameters<FileServiceDependencies["policy"]["getEscalation"]>[0],
  deadline: number,
): Promise<"allow" | "deny"> {
  while (Date.now() < deadline) {
    const current = await policy.getEscalation(escalationId);
    if (current.ok && current.value.state === "resolved") return current.value.resolution ?? "deny";
    if (!current.ok && current.error.kind !== "not-found") return "deny";
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return "deny";
}
