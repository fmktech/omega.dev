import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { basename, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import type {
  AbsolutePath,
  CreateFileProjectRepository,
  ObjectStore,
  Page,
  PageRequest,
  ProjectId,
  ProjectRecord,
  RepositoryIdentity,
  Result,
  Sha256,
  StoreError,
  WorkspaceId,
  WorkspaceRecord,
} from "../contracts/index.js";
import {
  atomicWriteFile,
  fileExists,
  ioError,
  safeStorageKey,
  timestampNow,
  validationError,
  withFileLock,
} from "./artifact-store.js";

const runFile = promisify(execFile);

export const createFileProjectRepository: CreateFileProjectRepository = (root, objects) => ({
  async registerWorkspace(path) {
    if (!isAbsolute(path)) {
      return { ok: false, error: validationError("Workspace path must be absolute", "path") };
    }
    let discovered: DiscoveredRepository;
    try {
      discovered = await discoverRepository(path);
    } catch (error) {
      return { ok: false, error: ioError("discover-repository", error) };
    }

    const projectId = `project_${hashText(discovered.identityKey).slice(0, 32)}` as ProjectId;
    const workspaceId = `workspace_${hashText(discovered.workspacePath).slice(0, 32)}` as WorkspaceId;
    const projectPath = projectRecordPath(root, projectId);
    const workspacePath = workspaceRecordPath(root, projectId, workspaceId);
    const workspaceIndexPath = globalWorkspacePath(root, workspaceId);
    try {
      return await withFileLock(projectPath, async () => {
        const now = timestampNow();
        const existingProject = await loadOptionalProject(projectPath);
        if (!existingProject.ok) {
          return existingProject;
        }
        const project: ProjectRecord = existingProject.value === null
          ? {
              id: projectId,
              displayName: discovered.displayName,
              repository: discovered.repository,
              activeHarnessId: null,
              createdAt: now,
              updatedAt: now,
            }
          : { ...existingProject.value, updatedAt: now };

        const existingWorkspace = await loadOptionalWorkspace(workspaceIndexPath);
        if (!existingWorkspace.ok) {
          return existingWorkspace;
        }
        if (existingWorkspace.value !== null && existingWorkspace.value.projectId !== projectId) {
          return {
            ok: false,
            error: {
              kind: "conflict",
              resource: "workspace-project",
              expected: projectId,
              actual: existingWorkspace.value.projectId,
              recoverable: true,
              callerAction: "refresh-version-and-retry",
            },
          };
        }
        const workspace: WorkspaceRecord = existingWorkspace.value === null
          ? {
              id: workspaceId,
              projectId,
              path: discovered.workspacePath as AbsolutePath,
              registeredAt: now,
              lastSeenAt: now,
            }
          : { ...existingWorkspace.value, lastSeenAt: now };

        const projectStored = await persistSnapshot(objects, project);
        if (!projectStored.ok) {
          return projectStored;
        }
        const workspaceStored = await persistSnapshot(objects, workspace);
        if (!workspaceStored.ok) {
          return workspaceStored;
        }
        await atomicWriteFile(projectPath, `${JSON.stringify(project)}\n`);
        await atomicWriteFile(workspacePath, `${JSON.stringify(workspace)}\n`);
        await atomicWriteFile(workspaceIndexPath, `${JSON.stringify(workspace)}\n`);
        return { ok: true, value: { project, workspace } };
      });
    } catch (error) {
      return { ok: false, error: ioError("register-workspace", error) };
    }
  },

  async registerBenchmarkWorkspace(projectId, path, fixtureHash) {
    if (!isAbsolute(path)) {
      return { ok: false, error: validationError("Benchmark workspace path must be absolute", "path") };
    }
    if (!/^[a-f0-9]{64}$/u.test(fixtureHash)) {
      return { ok: false, error: validationError("Fixture hash must be lowercase SHA-256 hexadecimal", "fixtureHash") };
    }
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(path);
    } catch (error) {
      return { ok: false, error: ioError("resolve-benchmark-workspace", error) };
    }
    const workspaceId = `workspace_benchmark_${hashText(`${projectId}:${canonicalPath}:${fixtureHash}`).slice(0, 32)}` as WorkspaceId;
    const projectPath = projectRecordPath(root, projectId);
    const workspacePath = workspaceRecordPath(root, projectId, workspaceId);
    const workspaceIndexPath = globalWorkspacePath(root, workspaceId);
    const benchmarkIdentityPath = join(
      root,
      "projects",
      safeStorageKey(projectId),
      "benchmark-workspaces",
      `${safeStorageKey(workspaceId)}.json`,
    );
    try {
      return await withFileLock(projectPath, async () => {
        const project = await loadOptionalProject(projectPath);
        if (!project.ok) {
          return project;
        }
        if (project.value === null) {
          return { ok: false, error: notFound("project", projectId) };
        }
        const existing = await loadOptionalWorkspace(workspaceIndexPath);
        if (!existing.ok) {
          return existing;
        }
        const now = timestampNow();
        if (existing.value !== null
          && (existing.value.projectId !== projectId || existing.value.path !== canonicalPath)) {
          return {
            ok: false,
            error: {
              kind: "conflict",
              resource: "benchmark-workspace-identity",
              expected: `${projectId}:${canonicalPath}`,
              actual: `${existing.value.projectId}:${existing.value.path}`,
              recoverable: true,
              callerAction: "refresh-version-and-retry",
            },
          };
        }
        const workspace: WorkspaceRecord = existing.value === null
          ? {
              id: workspaceId,
              projectId,
              path: canonicalPath as AbsolutePath,
              registeredAt: now,
              lastSeenAt: now,
            }
          : { ...existing.value, lastSeenAt: now };
        const stored = await persistSnapshot(objects, workspace);
        if (!stored.ok) {
          return stored;
        }
        await atomicWriteFile(workspacePath, `${JSON.stringify(workspace)}\n`);
        await atomicWriteFile(workspaceIndexPath, `${JSON.stringify(workspace)}\n`);
        await atomicWriteFile(benchmarkIdentityPath, `${JSON.stringify({ workspaceId, fixtureHash })}\n`);
        return { ok: true, value: workspace };
      });
    } catch (error) {
      return { ok: false, error: ioError("register-benchmark-workspace", error) };
    }
  },

  async getProject(id) {
    const path = projectRecordPath(root, id);
    try {
      const loaded = await loadOptionalProject(path);
      if (!loaded.ok) {
        return loaded;
      }
      return loaded.value === null
        ? { ok: false, error: notFound("project", id) }
        : { ok: true, value: loaded.value };
    } catch (error) {
      return { ok: false, error: ioError("get-project", error) };
    }
  },

  async getWorkspace(id) {
    const path = globalWorkspacePath(root, id);
    try {
      const loaded = await loadOptionalWorkspace(path);
      if (!loaded.ok) {
        return loaded;
      }
      return loaded.value === null
        ? { ok: false, error: notFound("workspace", id) }
        : { ok: true, value: loaded.value };
    } catch (error) {
      return { ok: false, error: ioError("get-workspace", error) };
    }
  },

  async listProjects(page) {
    const valid = validatePage(page);
    if (!valid.ok) {
      return valid;
    }
    try {
      const projectsDirectory = join(root, "projects");
      const entries = await readdir(projectsDirectory, { withFileTypes: true }).catch((error: unknown) => {
        if (isMissing(error)) {
          return [];
        }
        throw error;
      });
      const projects: ProjectRecord[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const loaded = await loadOptionalProject(join(projectsDirectory, entry.name, "project.json"));
        if (!loaded.ok) {
          return loaded;
        }
        if (loaded.value !== null) {
          projects.push(loaded.value);
        }
      }
      projects.sort((left, right) => left.id.localeCompare(right.id));
      const afterCursor = page.cursor === null
        ? projects
        : projects.filter((project) => project.id.localeCompare(page.cursor ?? "") > 0);
      const selected = afterCursor.slice(0, page.limit);
      const value: Page<ProjectRecord> = {
        items: selected,
        nextCursor: afterCursor.length > selected.length && selected.length > 0
          ? selected[selected.length - 1]?.id ?? null
          : null,
      };
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: ioError("list-projects", error) };
    }
  },

  async compareAndSetActiveHarness(projectId, expected, next, commitGuard) {
    const path = projectRecordPath(root, projectId);
    try {
      return await withFileLock(path, async () => {
        const loaded = await loadOptionalProject(path);
        if (!loaded.ok) {
          return loaded;
        }
        if (loaded.value === null) {
          return { ok: false, error: notFound("project", projectId) };
        }
        if (loaded.value.activeHarnessId !== expected) {
          return {
            ok: false,
            error: {
              kind: "conflict",
              resource: "project-active-harness",
              expected: expected ?? "null",
              actual: loaded.value.activeHarnessId ?? "null",
              recoverable: true,
              callerAction: "refresh-version-and-retry",
            },
          };
        }
        const updated: ProjectRecord = { ...loaded.value, activeHarnessId: next, updatedAt: timestampNow() };
        if (commitGuard !== undefined && !commitGuard()) {
          return {
            ok: false,
            error: {
              kind: "conflict",
              resource: "activation-commit-guard",
              expected: "active",
              actual: "cancelled",
              recoverable: true,
              callerAction: "refresh-version-and-retry",
            },
          };
        }
        const stored = await persistSnapshot(objects, updated);
        if (!stored.ok) {
          return stored;
        }
        if (commitGuard !== undefined && !commitGuard()) {
          return {
            ok: false,
            error: {
              kind: "conflict",
              resource: "activation-commit-guard",
              expected: "active",
              actual: "cancelled",
              recoverable: true,
              callerAction: "refresh-version-and-retry",
            },
          };
        }
        await atomicWriteFile(path, `${JSON.stringify(updated)}\n`);
        return { ok: true, value: updated };
      });
    } catch (error) {
      return { ok: false, error: ioError("compare-and-set-active-harness", error) };
    }
  },
});

type DiscoveredRepository = {
  readonly workspacePath: string;
  readonly displayName: string;
  readonly identityKey: string;
  readonly repository: RepositoryIdentity;
};

async function discoverRepository(inputPath: AbsolutePath): Promise<DiscoveredRepository> {
  const workspacePath = await realpath(inputPath);
  const topLevel = await gitValue(workspacePath, ["rev-parse", "--show-toplevel"]);
  if (topLevel === null) {
    const identityKey = `path:${workspacePath}`;
    return {
      workspacePath,
      displayName: basename(workspacePath),
      identityKey,
      repository: { canonicalRemote: null, initialRootHash: hashText(`root:${identityKey}`) as Sha256 },
    };
  }
  const repositoryRoot = await realpath(topLevel);
  const commonDirectoryValue = await gitValue(workspacePath, ["rev-parse", "--git-common-dir"]);
  const commonDirectory = commonDirectoryValue === null
    ? repositoryRoot
    : await realpath(resolve(workspacePath, commonDirectoryValue));
  const remoteValue = await gitValue(workspacePath, ["config", "--get", "remote.origin.url"]);
  const canonicalRemote = remoteValue === null ? null : normalizeRemote(remoteValue);
  const identityKey = canonicalRemote === null ? `git:${commonDirectory}` : `remote:${canonicalRemote}`;
  const rootCommit = await gitValue(workspacePath, ["rev-list", "--max-parents=0", "HEAD"]);
  return {
    workspacePath,
    displayName: basename(repositoryRoot),
    identityKey,
    repository: {
      canonicalRemote,
      initialRootHash: hashText(`root:${rootCommit ?? identityKey}`) as Sha256,
    },
  };
}

async function gitValue(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const result = await runFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5_000 });
    const value = result.stdout.trim().split("\n")[0]?.trim() ?? "";
    return value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

function normalizeRemote(remote: string): string {
  const trimmed = remote.trim().replace(/\\/gu, "/");
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/u.exec(trimmed);
  if (scp !== null && !/^[A-Za-z]:\//u.test(trimmed)) {
    return `${scp[1]?.toLowerCase() ?? ""}/${stripGitSuffix(scp[2] ?? "")}`;
  }
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    const pathname = stripGitSuffix(decodeURIComponent(url.pathname));
    return host.length === 0 ? pathname : `${host}/${pathname}`;
  } catch {
    return stripGitSuffix(trimmed);
  }
}

function stripGitSuffix(value: string): string {
  return value.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function projectRecordPath(root: string, id: ProjectId): string {
  return join(root, "projects", safeStorageKey(id), "project.json");
}

function workspaceRecordPath(root: string, projectId: ProjectId, workspaceId: WorkspaceId): string {
  return join(root, "projects", safeStorageKey(projectId), "workspaces", `${safeStorageKey(workspaceId)}.json`);
}

function globalWorkspacePath(root: string, id: WorkspaceId): string {
  return join(root, "workspace-index", `${safeStorageKey(id)}.json`);
}

async function loadOptionalProject(path: string): Promise<Result<ProjectRecord | null, StoreError>> {
  if (!(await fileExists(path))) {
    return { ok: true, value: null };
  }
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isProjectRecord(value)
      ? { ok: true, value }
      : { ok: false, error: validationError("Stored project record is malformed", null) };
  } catch (error) {
    return { ok: false, error: ioError("read-project-record", error) };
  }
}

async function loadOptionalWorkspace(path: string): Promise<Result<WorkspaceRecord | null, StoreError>> {
  if (!(await fileExists(path))) {
    return { ok: true, value: null };
  }
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isWorkspaceRecord(value)
      ? { ok: true, value }
      : { ok: false, error: validationError("Stored workspace record is malformed", null) };
  } catch (error) {
    return { ok: false, error: ioError("read-workspace-record", error) };
  }
}

function isProjectRecord(value: unknown): value is ProjectRecord {
  if (!isPlainRecord(value)) {
    return false;
  }
  return typeof value["id"] === "string" && typeof value["displayName"] === "string"
    && (value["activeHarnessId"] === null || typeof value["activeHarnessId"] === "string")
    && typeof value["createdAt"] === "string" && typeof value["updatedAt"] === "string"
    && isPlainRecord(value["repository"])
    && (value["repository"]["canonicalRemote"] === null || typeof value["repository"]["canonicalRemote"] === "string")
    && typeof value["repository"]["initialRootHash"] === "string";
}

function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  return isPlainRecord(value) && typeof value["id"] === "string" && typeof value["projectId"] === "string"
    && typeof value["path"] === "string" && isAbsolute(value["path"])
    && typeof value["registeredAt"] === "string" && typeof value["lastSeenAt"] === "string";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function persistSnapshot(objects: ObjectStore, value: ProjectRecord | WorkspaceRecord): Promise<Result<void, StoreError>> {
  const encoded = Buffer.from(JSON.stringify(value), "utf8");
  const stored = await objects.put("application/json", (async function* bytes(): AsyncIterable<Uint8Array> {
    yield encoded;
  })());
  return stored.ok ? { ok: true, value: undefined } : stored;
}

function validatePage(page: PageRequest): Result<void, StoreError> {
  return Number.isSafeInteger(page.limit) && page.limit > 0 && page.limit <= 1_000
    ? { ok: true, value: undefined }
    : { ok: false, error: validationError("Page limit must be an integer from 1 to 1000", "limit") };
}

function notFound(resource: string, id: string): StoreError {
  return { kind: "not-found", resource, id, recoverable: false, callerAction: "propagate" };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
