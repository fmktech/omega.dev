import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AbsolutePath,
  ByteCount,
  CapabilityEnvelope,
  DurationMs,
  ExecutionPolicy,
  HarnessId,
  NotFoundError,
  ObjectDescriptor,
  ObjectHash,
  ObjectStore,
  PolicyEscalation,
  PolicyEscalationId,
  ProcessId,
  ProcessSpec,
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
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { createFileService } from "./file-service.js";
import { createProcessSupervisor } from "./process-supervisor.js";
import type { SandboxBackend, SandboxChild } from "./sandbox-backend.js";

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
    async registerBenchmarkWorkspace(projectId, path, _fixtureHash) {
      return { ok: true, value: { ...workspace, projectId, path } };
    },
    async getProject() { return { ok: true, value: project }; },
    async getWorkspace() { return { ok: true, value: workspace }; },
    async listProjects() { return { ok: true, value: { items: [project], nextCursor: null } }; },
    async compareAndSetActiveHarness(_projectId, _expected, next) {
      return { ok: true, value: { ...project, activeHarnessId: next as HarnessId } };
    },
  };
}

function testSession(envelope: CapabilityEnvelope): SessionRecord {
  return {
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
}

function sessionRepository(envelope: CapabilityEnvelope): SessionRepository {
  const session = testSession(envelope);
  const missing = (resource: string, id: string): NotFoundError => ({
    kind: "not-found",
    resource,
    id,
    recoverable: false,
    callerAction: "propagate",
  });
  return {
    async create(header) { return { ok: true, value: { ...session, header } }; },
    async get() { return { ok: true, value: session }; },
    async list() { return { ok: true, value: { items: [session], nextCursor: null } }; },
    async append() { return { ok: false, error: missing("session-event", "unused") }; },
    async read() { return { ok: true, value: [] }; },
    async recordArtifact(record) { return { ok: true, value: record }; },
    async readArtifact(id) { return { ok: false, error: missing("artifact", String(id)) }; },
  };
}

function allowPolicy(): ExecutionPolicy {
  const missing = (resource: string, id: string): NotFoundError => ({
    kind: "not-found",
    resource,
    id,
    recoverable: false,
    callerAction: "propagate",
  });
  return {
    async evaluate() {
      return { ok: true, value: { outcome: "allow", reason: "test policy", constraints: [] } };
    },
    async getEscalation(id) { return { ok: false, error: missing("policy-escalation", String(id)) }; },
    async listEscalations() { return { ok: false, error: missing("policy-escalation", "unused") }; },
    async resolve(request) { return { ok: false, error: missing("policy-escalation", String(request.escalationId)) }; },
  };
}

function fileService(
  root: string,
  beforeDescriptorOpen?: (target: string) => Promise<void>,
) {
  const envelope = capabilities(["read-files", "write-files"]);
  return createFileService({
    projects: repository(root),
    sessions: sessionRepository(envelope),
    policy: allowPolicy(),
    ...(beforeDescriptorOpen === undefined ? {} : { beforeDescriptorOpen }),
  });
}

class MemoryObjectStore implements ObjectStore {
  readonly values = new Map<ObjectHash, { readonly descriptor: ObjectDescriptor; readonly content: Buffer }>();

  async put(mediaType: string, chunks: AsyncIterable<Uint8Array>) {
    const values: Buffer[] = [];
    for await (const chunk of chunks) values.push(Buffer.from(chunk));
    const content = Buffer.concat(values);
    const hash = createHash("sha256").update(content).digest("hex") as ObjectHash;
    const descriptor: ObjectDescriptor = {
      hash,
      size: content.byteLength as ByteCount,
      mediaType,
      createdAt: NOW,
    };
    this.values.set(hash, { descriptor, content });
    return { ok: true as const, value: descriptor };
  }

  async get(hash: ObjectHash) {
    const value = this.values.get(hash);
    if (value === undefined) {
      return { ok: false as const, error: { kind: "not-found" as const, resource: "object", id: String(hash), recoverable: false as const, callerAction: "propagate" as const } };
    }
    return {
      ok: true as const,
      value: (async function* (): AsyncIterable<Uint8Array> { yield value.content; })(),
    };
  }

  async describe(hash: ObjectHash) {
    const value = this.values.get(hash);
    return value === undefined
      ? { ok: false as const, error: { kind: "not-found" as const, resource: "object", id: String(hash), recoverable: false as const, callerAction: "propagate" as const } }
      : { ok: true as const, value: value.descriptor };
  }
}

type FakeChild = SandboxChild & {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly signals: string[];
};

class FakeBackend implements SandboxBackend {
  readonly children: FakeChild[] = [];

  async launch(): Promise<{ readonly ok: true; readonly value: SandboxChild }> {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const process = Object.assign(new EventEmitter(), { stdout, stderr, stdin: new PassThrough() }) as unknown as ChildProcess;
    const signals: string[] = [];
    const child: FakeChild = {
      process,
      stdout,
      stderr,
      signals,
      identity: {
        backend: "docker",
        backendVersion: "test",
        image: "omega-runner:test",
        imageDigest: digest("image"),
        containerUser: "1000:1000",
      },
      write(data) { return process.stdin?.write(data) ?? false; },
      closeStdin() { process.stdin?.end(); },
      async signal(signal) { signals.push(signal); return { ok: true, value: undefined }; },
    };
    this.children.push(child);
    return { ok: true, value: child };
  }

  async recoverOrphans() { return { ok: true as const, value: [] }; }
}

function processCapabilities(): CapabilityEnvelope {
  return {
    ...capabilities(["read-files", "write-files"]),
    grants: [
      { kind: "read-files", pathPrefixes: ["." as RelativePath] },
      { kind: "write-files", pathPrefixes: ["." as RelativePath] },
      { kind: "start-process", executableNames: [] },
    ],
    maxProcessStarts: 1_000,
    wallTimeMs: 60_000 as DurationMs,
    createdAt: new Date().toISOString() as Timestamp,
  };
}

function processSpec(root: string): ProcessSpec {
  return {
    executable: "node",
    args: ["--version"],
    cwd: root as AbsolutePath,
    credentialEnvNames: [],
    stdin: "closed",
    timeoutMs: null,
    sandbox: {
      filesystem: "workspace-read-write",
      network: "none",
      allowedHosts: [],
      memoryLimitBytes: 64_000_000 as ByteCount,
      cpuTimeLimitMs: 5_000 as DurationMs,
      runtime: {
        kind: "oci",
        image: "omega-runner:test",
        expectedImageDigest: null,
        containerUser: "1000:1000",
        workspaceMountPath: "/workspace" as AbsolutePath,
      },
    },
    harnessId: "harness-test" as HarnessId,
    sessionId: SESSION_ID,
  };
}

function supervisorFixture(root: string) {
  const envelope = processCapabilities();
  const backend = new FakeBackend();
  const objects = new MemoryObjectStore();
  const supervisor = createProcessSupervisor({
    config: { ...DEFAULT_CONFIG.processes, liveChunkBytes: 4 as ByteCount },
    environment: {},
    projects: repository(root),
    sessions: sessionRepository(envelope),
    objects,
    policy: allowPolicy(),
    backend,
  });
  return { supervisor, backend, objects, envelope };
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

  it("does not disclose a file when a checked parent is swapped to an external symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "omega-outside-race-"));
    try {
      await writeFile(join(root, "src", "secret.txt"), "inside");
      await writeFile(join(outside, "secret.txt"), "outside-secret");
      let swapped = false;
      const files = fileService(root, async () => {
        if (swapped) return;
        swapped = true;
        await rename(join(root, "src"), join(root, "src-original"));
        await symlink(outside, join(root, "src"));
      });

      const result = await files.read(WORKSPACE_ID, "src/secret.txt" as RelativePath, capabilities(["read-files"]));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("validation");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not modify an external file when a checked parent is swapped before descriptor open", async () => {
    const outside = await mkdtemp(join(tmpdir(), "omega-outside-write-race-"));
    try {
      await writeFile(join(root, "src", "cas.txt"), "inside");
      await writeFile(join(outside, "cas.txt"), "outside-secret");
      let swapped = false;
      const files = fileService(root, async () => {
        if (swapped) return;
        swapped = true;
        await rename(join(root, "src"), join(root, "src-original"));
        await symlink(outside, join(root, "src"));
      });

      const result = await files.write(
        { sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, path: "src/cas.txt" as RelativePath, expectedSha: digest("inside"), content: "changed" },
        capabilities(["write-files"]),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("validation");
      expect(await readFile(join(outside, "cas.txt"), "utf8")).toBe("outside-secret");
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
    expect(await readFile(join(root, "src", "cas.txt"), "utf8")).toBe("after");
  });

  it("holds an escalated write until the policy resolution allows it", async () => {
    const envelope = { ...capabilities(["write-files"]), createdAt: new Date().toISOString() as Timestamp };
    const escalationId = "policy-escalation-write" as PolicyEscalationId;
    let polls = 0;
    const escalation = (state: PolicyEscalation["state"]): PolicyEscalation => ({
      id: escalationId,
      sessionId: SESSION_ID,
      facts: { kind: "file-write", workspaceId: WORKSPACE_ID, path: "src/reviewed.txt" as RelativePath, expectedSha: null },
      reason: "review write",
      state,
      resolution: state === "resolved" ? "allow" : null,
      createdAt: envelope.createdAt,
      resolvedAt: state === "resolved" ? new Date().toISOString() as Timestamp : null,
    });
    const policy: ExecutionPolicy = {
      async evaluate() { return { ok: true, value: { outcome: "escalate", reason: "review write", escalationId } }; },
      async getEscalation() { polls += 1; return { ok: true, value: escalation(polls > 1 ? "resolved" : "pending") }; },
      async listEscalations() { return { ok: true, value: { items: [], nextCursor: null } }; },
      async resolve() { return { ok: true, value: escalation("resolved") }; },
    };
    const files = createFileService({ projects: repository(root), sessions: sessionRepository(envelope), policy });

    const result = await files.write(
      { sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, path: "src/reviewed.txt" as RelativePath, expectedSha: null, content: "approved" },
      envelope,
    );

    expect(result.ok).toBe(true);
    expect(polls).toBeGreaterThan(1);
    expect(await readFile(join(root, "src", "reviewed.txt"), "utf8")).toBe("approved");
  });
});

describe("process supervisor lifecycle bounds", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "omega-supervisor-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("holds an escalated process start until the policy resolution allows it", async () => {
    const envelope = processCapabilities();
    const spec = processSpec(root);
    const escalationId = "policy-escalation-process" as PolicyEscalationId;
    let polls = 0;
    const escalation = (state: PolicyEscalation["state"]): PolicyEscalation => ({
      id: escalationId,
      sessionId: SESSION_ID,
      facts: {
        kind: "process", executable: spec.executable, args: spec.args, cwd: spec.cwd,
        credentialEnvNames: spec.credentialEnvNames, sandbox: spec.sandbox,
      },
      reason: "review process",
      state,
      resolution: state === "resolved" ? "allow" : null,
      createdAt: envelope.createdAt,
      resolvedAt: state === "resolved" ? new Date().toISOString() as Timestamp : null,
    });
    const policy: ExecutionPolicy = {
      async evaluate() { return { ok: true, value: { outcome: "escalate", reason: "review process", escalationId } }; },
      async getEscalation() { polls += 1; return { ok: true, value: escalation(polls > 1 ? "resolved" : "pending") }; },
      async listEscalations() { return { ok: true, value: { items: [], nextCursor: null } }; },
      async resolve() { return { ok: true, value: escalation("resolved") }; },
    };
    const backend = new FakeBackend();
    const supervisor = createProcessSupervisor({
      config: DEFAULT_CONFIG.processes,
      environment: {},
      projects: repository(root),
      sessions: sessionRepository(envelope),
      objects: new MemoryObjectStore(),
      policy,
      backend,
    });

    const result = await supervisor.start(spec, envelope);

    expect(result.ok).toBe(true);
    expect(polls).toBeGreaterThan(1);
    expect(backend.children).toHaveLength(1);
  });

  it("serves bounded completed output from object descriptors", async () => {
    const fixture = supervisorFixture(root);
    const started = await fixture.supervisor.start(processSpec(root), fixture.envelope);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const child = fixture.backend.children[0];
    if (child === undefined) throw new Error("fake child was not launched");
    child.stdout.write("abcdef");
    child.process.emit("exit", 0, null);
    const completion = await fixture.supervisor.cancel(started.value.id, "observe completed output");
    expect(completion.ok).toBe(true);

    const first = await fixture.supervisor.observe(started.value.id, []);
    expect(first.ok && first.value.state).toBe("exited");
    expect(first.ok && first.value.slices[0]?.data).toBe("abcd");
    const second = await fixture.supervisor.observe(started.value.id, [{ stream: "stdout", offset: 4 as ByteCount }]);
    expect(second.ok && second.value.slices[0]?.data).toBe("ef");
  });

  it("evicts old completed-process metadata instead of retaining every output forever", async () => {
    const fixture = supervisorFixture(root);
    let firstId: ProcessId | null = null;
    let latestId: ProcessId | null = null;
    for (let index = 0; index < 257; index += 1) {
      const started = await fixture.supervisor.start(processSpec(root), fixture.envelope);
      if (!started.ok) throw new Error(`fake process ${index} failed to start`);
      firstId ??= started.value.id;
      latestId = started.value.id;
      const child = fixture.backend.children[index];
      if (child === undefined) throw new Error("fake child was not launched");
      child.stdout.write(String(index));
      child.process.emit("exit", 0, null);
      await fixture.supervisor.cancel(started.value.id, "complete fake process");
    }
    if (firstId === null || latestId === null) throw new Error("process IDs were not captured");

    const evicted = await fixture.supervisor.observe(firstId, []);
    expect(evicted.ok).toBe(false);
    if (!evicted.ok) expect(evicted.error.kind).toBe("process-not-running");
    const retained = await fixture.supervisor.observe(latestId, []);
    expect(retained.ok).toBe(true);
  });

  it("returns at the shutdown deadline even when a killed backend never emits exit", async () => {
    const fixture = supervisorFixture(root);
    const started = await fixture.supervisor.start(processSpec(root), fixture.envelope);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const deadline = new Date(Date.now() + 25).toISOString() as Timestamp;
    const began = Date.now();

    const result = await fixture.supervisor.shutdown(deadline);

    expect(Date.now() - began).toBeLessThan(250);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("io-error");
      if (result.error.kind === "io-error") expect(result.error.operation).toBe("process.shutdown-deadline");
    }
    expect(fixture.backend.children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
