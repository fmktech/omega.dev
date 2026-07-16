import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AbsolutePath,
  ByteCount,
  CapabilityEnvelope,
  DurationMs,
  ExecutionPolicy,
  HarnessId,
  NotFoundError,
  ProjectId,
  ProjectRecord,
  ProjectRepository,
  RelativePath,
  Sha256,
  SessionId,
  SessionRecord,
  SessionRepository,
  Timestamp,
  TokenCount,
  UsdMicros,
  WorkspaceId,
  WorkspaceRecord,
} from "../contracts/index.js";
import { createFileService } from "./file-service.js";

const PROJECT_ID = "project-test" as ProjectId;
const WORKSPACE_ID = "workspace-test" as WorkspaceId;
const SESSION_ID = "session-test" as SessionId;
const NOW = "2026-07-16T00:00:00.000Z" as Timestamp;

function digest(value: string): Sha256 {
  return createHash("sha256").update(value, "utf8").digest("hex") as Sha256;
}

function capabilities(kinds: readonly ("read-files" | "write-files")[]): CapabilityEnvelope {
  return {
    grants: kinds.map((kind) => ({ kind, pathPrefixes: ["." as RelativePath] })),
    modelRoles: [],
    maxCostUsdMicros: 0 as UsdMicros,
    maxModelCalls: 0,
    maxProcessStarts: 0,
    maxInputTokens: 0 as TokenCount,
    maxOutputTokens: 0 as TokenCount,
    wallTimeMs: 60_000 as DurationMs,
    createdAt: NOW,
  };
}

function repository(root: string): ProjectRepository {
  const workspace: WorkspaceRecord = {
    id: WORKSPACE_ID,
    projectId: PROJECT_ID,
    path: root as AbsolutePath,
    registeredAt: NOW,
    lastSeenAt: NOW,
  };
  const project: ProjectRecord = {
    id: PROJECT_ID,
    displayName: "test",
    repository: { canonicalRemote: null, initialRootHash: digest("") },
    activeHarnessId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    async registerWorkspace() { return { ok: true, value: { project, workspace } }; },
    async getProject() { return { ok: true, value: project }; },
    async getWorkspace() { return { ok: true, value: workspace }; },
    async listProjects() { return { ok: true, value: { items: [project], nextCursor: null } }; },
    async compareAndSetActiveHarness(_projectId, _expected, next) {
      return { ok: true, value: { ...project, activeHarnessId: next as HarnessId } };
    },
  };
}

function fileService(root: string) {
  const envelope = capabilities(["read-files", "write-files"]);
  const session: SessionRecord = {
    header: {
      id: SESSION_ID,
      threadId: "thread-test" as SessionRecord["header"]["threadId"],
      parentSessionId: null,
      continuation: null,
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      role: "main",
      objective: "test file interlocks",
      initialHarnessId: "harness-test" as HarnessId,
      initialModelRoutes: [],
      policyProfile: "guarded",
      capabilityEnvelope: envelope,
      credentialEnvNames: [],
      eventSchemaVersion: 1,
      createdAt: NOW,
    },
    state: "running",
    lastSequence: 0,
    completedAt: null,
    outcome: null,
  };
  const missing = (resource: string, id: string): NotFoundError => ({
    kind: "not-found",
    resource,
    id,
    recoverable: false,
    callerAction: "propagate",
  });
  const sessions: SessionRepository = {
    async create(header) { return { ok: true, value: { ...session, header } }; },
    async get() { return { ok: true, value: session }; },
    async list() { return { ok: true, value: { items: [session], nextCursor: null } }; },
    async append() { return { ok: false, error: missing("session-event", "unused") }; },
    async read() { return { ok: true, value: [] }; },
    async recordArtifact(record) { return { ok: true, value: record }; },
    async readArtifact(id) { return { ok: false, error: missing("artifact", String(id)) }; },
  };
  const policy: ExecutionPolicy = {
    async evaluate() {
      return { ok: true, value: { outcome: "allow", reason: "test policy", constraints: [] } };
    },
    async getEscalation(id) { return { ok: false, error: missing("policy-escalation", String(id)) }; },
    async listEscalations() { return { ok: false, error: missing("policy-escalation", "unused") }; },
    async resolve(request) { return { ok: false, error: missing("policy-escalation", String(request.escalationId)) }; },
  };
  return createFileService({ projects: repository(root), sessions, policy });
}

describe("process runtime file interlock", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "omega-process-"));
    await mkdir(join(root, "src"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns content, byte size, and SHA-256 from a capability-scoped read", async () => {
    await writeFile(join(root, "src", "hello.txt"), "olá");
    const files = fileService(root);

    const result = await files.read(WORKSPACE_ID, "src/hello.txt" as RelativePath, capabilities(["read-files"]));

    expect(result).toEqual({
      ok: true,
      value: {
        path: "src/hello.txt",
        content: "olá",
        sha: digest("olá"),
        size: Buffer.byteLength("olá", "utf8") as ByteCount,
      },
    });
  });

  it("rejects traversal before touching the filesystem", async () => {
    const files = fileService(root);
    const result = await files.read(WORKSPACE_ID, "../secret" as RelativePath, capabilities(["read-files"]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("validation");
  });

  it("rejects a symlink that escapes the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "omega-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "secret");
      await symlink(outside, join(root, "outside"));
      const files = fileService(root);
      const result = await files.read(WORKSPACE_ID, "outside/secret.txt" as RelativePath, capabilities(["read-files"]));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("validation");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("requires the matching file capability", async () => {
    await writeFile(join(root, "src", "locked.txt"), "locked");
    const files = fileService(root);
    const result = await files.read(WORKSPACE_ID, "src/locked.txt" as RelativePath, capabilities(["write-files"]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("capability-denied");
  });

  it("creates a file only when expectedSha is null and the path is absent", async () => {
    const files = fileService(root);
    const result = await files.write(
      { sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, path: "src/new.txt" as RelativePath, expectedSha: null, content: "new" },
      capabilities(["write-files"]),
    );
    expect(result).toEqual({
      ok: true,
      value: { path: "src/new.txt", previousSha: null, sha: digest("new"), size: 3 as ByteCount },
    });
  });

  it("blocks a stale compare-and-swap without modifying the file", async () => {
    await writeFile(join(root, "src", "cas.txt"), "current");
    const files = fileService(root);
    const result = await files.write(
      { sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, path: "src/cas.txt" as RelativePath, expectedSha: digest("old"), content: "replacement" },
      capabilities(["write-files"]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("stale-read");
      if (result.error.kind === "stale-read") expect(result.error.actualSha).toBe(digest("current"));
    }
    const read = await files.read(WORKSPACE_ID, "src/cas.txt" as RelativePath, capabilities(["read-files"]));
    expect(read.ok && read.value.content).toBe("current");
  });

  it("updates only after an exact read SHA", async () => {
    await writeFile(join(root, "src", "cas.txt"), "before");
    const files = fileService(root);
    const result = await files.write(
      { sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, path: "src/cas.txt" as RelativePath, expectedSha: digest("before"), content: "after" },
      capabilities(["write-files"]),
    );
    expect(result).toEqual({
      ok: true,
      value: { path: "src/cas.txt", previousSha: digest("before"), sha: digest("after"), size: 5 as ByteCount },
    });
  });
});
