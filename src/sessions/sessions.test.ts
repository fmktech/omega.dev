import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import type {
  AbsolutePath,
  ArtifactId,
  ArtifactRecord,
  ByteCount,
  CapabilityEnvelope,
  CredentialEnvName,
  DurationMs,
  EventId,
  ExecutionPolicy,
  HarnessId,
  HarnessManifest,
  HarnessRepository,
  ModelRole,
  ModelRouteSignature,
  ModelRouter,
  NotFoundError,
  ObjectDescriptor,
  ObjectHash,
  ObjectStore,
  Page,
  PageRequest,
  PersistedEventPayload,
  ProcessCompletion,
  ProcessError,
  ProcessHandle,
  ProcessId,
  ProcessSupervisor,
  ProjectId,
  ProjectRecord,
  ProjectRepository,
  RelativePath,
  Result,
  RunnerHost,
  SessionError,
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionRecord,
  SessionRepository,
  Sha256,
  StoreError,
  Timestamp,
  TokenCount,
  UsdMicros,
  ValidationError,
  WorkspaceId,
  WorkspaceRecord,
} from "../contracts/index.js";
import { attenuateChildCapabilities } from "./child-sessions.js";
import { recoverExistingSession } from "./recovery.js";
import { createSessionService } from "./session-service.js";

const NOW = "2026-07-16T12:00:00.000Z" as Timestamp;
const PROJECT_ID = "project-test" as ProjectId;
const WORKSPACE_ID = "workspace-test" as WorkspaceId;
const HARNESS_ID = "harness-test" as HarnessId;
const CANDIDATE_HARNESS_ID = "harness-candidate" as HarnessId;

class MemoryObjects implements ObjectStore {
  readonly values = new Map<ObjectHash, Uint8Array>();

  async put(mediaType: string, chunks: AsyncIterable<Uint8Array>): Promise<Result<ObjectDescriptor, StoreError>> {
    const parts: Uint8Array[] = [];
    for await (const chunk of chunks) parts.push(chunk);
    const bytes = Buffer.concat(parts);
    const hash = `object-${this.values.size + 1}` as ObjectHash;
    this.values.set(hash, bytes);
    return { ok: true, value: { hash, size: bytes.byteLength as ByteCount, mediaType, createdAt: NOW } };
  }

  async get(hash: ObjectHash): Promise<Result<AsyncIterable<Uint8Array>, StoreError>> {
    const value = this.values.get(hash);
    if (value === undefined) return notFound("object", hash);
    return { ok: true, value: (async function* chunks(): AsyncIterable<Uint8Array> { yield value; })() };
  }

  async describe(hash: ObjectHash): Promise<Result<ObjectDescriptor, StoreError>> {
    const value = this.values.get(hash);
    return value === undefined
      ? notFound("object", hash)
      : { ok: true, value: { hash, size: value.byteLength as ByteCount, mediaType: "application/json", createdAt: NOW } };
  }
}

class MemorySessions implements SessionRepository {
  readonly records = new Map<SessionId, SessionRecord>();
  readonly events = new Map<SessionId, SessionEvent[]>();
  readonly artifacts = new Map<ArtifactId, ArtifactRecord>();
  constructor(private readonly objects: MemoryObjects) {}

  async create(header: SessionHeader): Promise<Result<SessionRecord, SessionError>> {
    if (this.records.has(header.id)) return conflictResult("session", "absent", header.id);
    const record: SessionRecord = { header, state: "starting", lastSequence: 0, completedAt: null, outcome: null };
    this.records.set(header.id, record);
    this.events.set(header.id, []);
    return { ok: true, value: record };
  }

  async get(id: SessionId): Promise<Result<SessionRecord, SessionError>> {
    const value = this.records.get(id);
    return value === undefined ? notFound("session", id) : { ok: true, value };
  }

  async list(projectId: ProjectId, page: PageRequest): Promise<Result<Page<SessionRecord>, SessionError>> {
    const items = [...this.records.values()].filter((record) => record.header.projectId === projectId).slice(0, page.limit);
    return { ok: true, value: { items, nextCursor: null } };
  }

  async append(
    id: SessionId,
    expectedSequence: number,
    payload: PersistedEventPayload,
    harnessId: HarnessId,
    reservedEventId: EventId | null,
  ): Promise<Result<SessionEvent, SessionError>> {
    const record = this.records.get(id);
    if (record === undefined) return notFound("session", id);
    if (record.outcome !== null) {
      return conflictResult("session-terminal", payload.kind === "session.completed" ? payload.outcome : "non-terminal", record.outcome);
    }
    if (record.lastSequence !== expectedSequence) return conflictResult("sequence", String(expectedSequence), String(record.lastSequence));
    const sequence = expectedSequence + 1;
    const event: SessionEvent = { id: reservedEventId ?? `event-${id}-${sequence}` as EventId, sequence, at: NOW, harnessId, payload };
    this.events.get(id)?.push(event);
    const terminal = payload.kind === "session.completed";
    this.records.set(id, {
      ...record,
      state: terminal ? (payload.outcome === "succeeded" ? "completed" : payload.outcome) : payload.kind === "session.started" ? "running" : record.state,
      lastSequence: sequence,
      completedAt: terminal ? NOW : record.completedAt,
      outcome: terminal ? payload.outcome : record.outcome,
    });
    return { ok: true, value: event };
  }

  async read(id: SessionId, afterSequence: number, limit: number): Promise<Result<readonly SessionEvent[], SessionError>> {
    if (!this.records.has(id)) return notFound("session", id);
    return { ok: true, value: (this.events.get(id) ?? []).filter((event) => event.sequence > afterSequence).slice(0, limit) };
  }

  async recordArtifact(record: ArtifactRecord): Promise<Result<ArtifactRecord, SessionError>> {
    this.artifacts.set(record.id, record);
    return { ok: true, value: record };
  }

  async readArtifact(id: ArtifactId, offset: ByteCount, limit: ByteCount) {
    const artifact = this.artifacts.get(id);
    if (artifact === undefined) return notFound("artifact", id);
    const value = this.objects.values.get(artifact.object.hash);
    if (value === undefined) return notFound("object", artifact.object.hash);
    const start = Number(offset);
    const end = Math.min(value.byteLength, start + Number(limit));
    return {
      ok: true as const,
      value: {
        artifact,
        range: { startInclusive: offset, endExclusive: end as ByteCount },
        encoding: "utf8" as const,
        data: Buffer.from(value.subarray(start, end)).toString("utf8"),
        complete: end === value.byteLength,
      },
    };
  }
}

class FakeProcesses implements ProcessSupervisor {
  readonly active = new Map<ProcessId, ProcessHandle>();
  cancelled = 0;
  async start(): Promise<Result<ProcessHandle, ProcessError>> { return unsupportedProcess(); }
  async observe(): Promise<Result<never, ProcessError>> { return unsupportedProcess(); }
  async input(): Promise<Result<never, ProcessError>> { return unsupportedProcess(); }
  async cancel(processId: ProcessId): Promise<Result<ProcessCompletion, ProcessError>> {
    this.cancelled += 1;
    this.active.delete(processId);
    return { ok: true, value: completion(processId) };
  }
  async listActive(sessionId: SessionId): Promise<Result<readonly ProcessHandle[], ProcessError>> {
    return { ok: true, value: [...this.active.values()].filter((handle) => String(handle.id).includes(sessionId)) };
  }
  async recoverOrphans(): Promise<Result<readonly ProcessId[], ProcessError>> { return { ok: true, value: [] }; }
  async shutdown(): Promise<Result<readonly ProcessCompletion[], ProcessError>> { return { ok: true, value: [] }; }
}

class FakeRunners implements RunnerHost {
  readonly starts: SessionHeader[] = [];
  readonly handles = new Map<SessionId, ProcessHandle>();
  async start(start: Parameters<RunnerHost["start"]>[0]) {
    this.starts.push(start.session);
    const handle = processHandle(`runner-${start.session.id}` as ProcessId);
    this.handles.set(start.session.id, handle);
    return { ok: true as const, value: handle };
  }
  async send() { return { ok: true as const, value: undefined }; }
  async *receive(): AsyncIterable<never> { return; }
  async stop(sessionId: SessionId) {
    const handle = this.handles.get(sessionId);
    if (handle === undefined) return notFound("runner", sessionId);
    this.handles.delete(sessionId);
    return { ok: true as const, value: completion(handle.id) };
  }
}

function fixture() {
  const objects = new MemoryObjects();
  const repository = new MemorySessions(objects);
  const processes = new FakeProcesses();
  const runners = new FakeRunners();
  const project: ProjectRecord = {
    id: PROJECT_ID,
    displayName: "Omega",
    repository: { canonicalRemote: null, initialRootHash: "0".repeat(64) as Sha256 },
    activeHarnessId: HARNESS_ID,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const workspace: WorkspaceRecord = {
    id: WORKSPACE_ID,
    projectId: PROJECT_ID,
    path: "/workspace" as AbsolutePath,
    registeredAt: NOW,
    lastSeenAt: NOW,
  };
  const harness: HarnessManifest = {
    id: HARNESS_ID,
    projectId: PROJECT_ID,
    alias: "active",
    parents: [],
    components: [],
    sourceArtifacts: [],
    createdAt: NOW,
  };
  const candidate: HarnessManifest = {
    ...harness,
    id: CANDIDATE_HARNESS_ID,
    alias: "candidate",
    parents: [HARNESS_ID],
  };
  const pointerWrites = { count: 0 };
  const pumpedSessions: SessionId[] = [];
  const service = createSessionService({
    config: DEFAULT_CONFIG.sessions,
    repository,
    projects: projectRepository(project, workspace, pointerWrites),
    harnesses: harnessRepository([harness, candidate], HARNESS_ID),
    runners,
    processes,
    models: modelRouter(),
    policy: allowPolicy(),
    objects,
    runnerRequests: {
      start(sessionId) { pumpedSessions.push(sessionId); },
      async stop() { return; },
    },
  });
  return { service, repository, objects, processes, runners, project, candidate, pointerWrites, pumpedSessions };
}

describe("session service", () => {
  it("starts a main session with the active harness, resolved route, configured policy, and semantic events", async () => {
    const f = fixture();
    const result = await f.service.startTask({ projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, objective: " build omega ", modelRole: "main-coder" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.header).toMatchObject({ role: "main", objective: "build omega", initialHarnessId: HARNESS_ID, policyProfile: "guarded" });
    expect(result.value.header.initialModelRoutes).toHaveLength(1);
    expect(result.value.header.capabilityEnvelope.createdAt).toBeTruthy();
    expect((f.repository.events.get(result.value.header.id) ?? []).map((event) => event.payload.kind)).toEqual([
      "session.started", "runner.started",
    ]);
    expect(f.pumpedSessions).toEqual([result.value.header.id]);
  });

  it("starts an inactive pinned candidate for benchmarking without touching the active harness pointer", async () => {
    const f = fixture();
    const suppliedRoute = route("main-coder");
    const suppliedCapabilities = envelope({
      grants: [{ kind: "read-files", pathPrefixes: ["fixtures" as RelativePath] }],
      modelRoles: ["main-coder"],
      maxModelCalls: 2,
      maxProcessStarts: 1,
    });
    const credentialEnvNames = ["BENCHMARK_TOKEN" as CredentialEnvName];

    const result = await f.service.startBenchmarkTask({
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      objective: " evaluate inactive candidate ",
      harnessId: f.candidate.id,
      route: suppliedRoute,
      policyProfile: "autonomous",
      capabilityEnvelope: suppliedCapabilities,
      credentialEnvNames,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.header).toMatchObject({
      role: "promotion-eval",
      objective: "evaluate inactive candidate",
      initialHarnessId: CANDIDATE_HARNESS_ID,
      initialModelRoutes: [suppliedRoute],
      policyProfile: "autonomous",
      capabilityEnvelope: suppliedCapabilities,
      credentialEnvNames,
    });
    expect(f.project.activeHarnessId).toBe(HARNESS_ID);
    expect(f.pointerWrites.count).toBe(0);
    expect(f.runners.starts.at(-1)?.initialHarnessId).toBe(CANDIDATE_HARNESS_ID);
  });

  it("cancels an idle live subscription immediately", async () => {
    const f = fixture();
    const started = await f.service.startTask({ projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, objective: "watch", modelRole: "main-coder" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const iterator = f.service.subscribe(started.value.header.id, started.value.lastSequence)[Symbol.asyncIterator]();
    const pending = iterator.next();
    await iterator.return?.();
    await expect(Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("subscription did not cancel")), 100)),
    ])).resolves.toMatchObject({ done: true });
  });

  it("resumes into a fresh linked session with exact handoff and context evidence", async () => {
    const f = fixture();
    const first = await f.service.startTask({ projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, objective: "continue me", modelRole: "main-coder" });
    if (!first.ok) throw new Error("fixture start failed");
    const handoff = await f.service.createHandoff(first.value.header.id);
    if (!handoff.ok) throw new Error("fixture handoff failed");
    const resumed = await f.service.resumeThread({
      sourceSessionId: first.value.header.id,
      workspaceId: WORKSPACE_ID,
      handoffArtifactId: handoff.value.artifactId,
      contextArtifactIds: [],
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.header.id).not.toBe(first.value.header.id);
    expect(resumed.value.header.threadId).toBe(first.value.header.threadId);
    expect(resumed.value.header.parentSessionId).toBe(first.value.header.id);
    expect(resumed.value.header.continuation).toEqual({
      sourceSessionId: first.value.header.id,
      handoffArtifactId: handoff.value.artifactId,
      contextArtifactIds: [],
    });
  });

  it("rejects a child capability widening before creating the child", async () => {
    const parent = envelope({ grants: [{ kind: "read-files", pathPrefixes: ["src" as RelativePath] }] });
    const requested = envelope({ grants: [{ kind: "read-files", pathPrefixes: ["." as RelativePath] }] });
    const result = attenuateChildCapabilities(parent, requested, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("capability-denied");
  });

  it("spawns a narrowed child in the parent's thread and records the assigned spawn identity", async () => {
    const f = fixture();
    const parent = await f.service.startTask({ projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, objective: "parent", modelRole: "main-coder" });
    if (!parent.ok) throw new Error("fixture start failed");
    const childEnvelope = envelope({ grants: [{ kind: "read-files", pathPrefixes: ["src" as RelativePath] }], modelRoles: ["diagnostician"] });
    const child = await f.service.spawnChild({
      parentSessionId: parent.value.header.id,
      role: "diagnostician",
      objective: "inspect",
      contextArtifactIds: [],
      capabilityEnvelope: childEnvelope,
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    const childSession = await f.repository.get(child.value.sessionId);
    expect(childSession.ok && childSession.value.header.threadId).toBe(parent.value.header.threadId);
    expect(childSession.ok && childSession.value.header.parentSessionId).toBe(parent.value.header.id);
    expect(childSession.ok && childSession.value.header.initialModelRoutes[0]?.role).toBe("diagnostician");
    const spawn = (f.repository.events.get(parent.value.header.id) ?? []).find((event) => event.payload.kind === "child.spawned");
    expect(spawn?.payload.kind === "child.spawned" && spawn.payload.child.spawnEventId).toBe(child.value.spawnEventId);
    expect(spawn?.id).toBe(child.value.spawnEventId);
  });

  it("completes idempotently and emits one child completion into the parent", async () => {
    const f = fixture();
    const parent = await f.service.startTask({ projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, objective: "parent", modelRole: "main-coder" });
    if (!parent.ok) throw new Error("fixture start failed");
    const child = await f.service.spawnChild({
      parentSessionId: parent.value.header.id,
      role: "diagnostician",
      objective: "inspect",
      contextArtifactIds: [],
      capabilityEnvelope: envelope({ grants: [{ kind: "read-files", pathPrefixes: ["src" as RelativePath] }], modelRoles: ["diagnostician"] }),
    });
    if (!child.ok) throw new Error("fixture child failed");
    expect((await f.service.complete(child.value.sessionId, "succeeded")).ok).toBe(true);
    expect((await f.service.complete(child.value.sessionId, "succeeded")).ok).toBe(true);
    const completed = (f.repository.events.get(parent.value.header.id) ?? []).filter((event) => event.payload.kind === "child.completed");
    expect(completed).toHaveLength(1);
  });

  it("cancels active tool processes and persists their terminal evidence", async () => {
    const f = fixture();
    const started = await f.service.startTask({ projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, objective: "cancel", modelRole: "main-coder" });
    if (!started.ok) throw new Error("fixture start failed");
    const tool = processHandle(`tool-${started.value.header.id}` as ProcessId);
    f.processes.active.set(tool.id, tool);
    const cancelled = await f.service.cancel(started.value.header.id, "operator request");
    expect(cancelled.ok && cancelled.value.outcome).toBe("cancelled");
    expect(f.processes.cancelled).toBe(1);
    expect((f.repository.events.get(started.value.header.id) ?? []).map((event) => event.payload.kind)).toContain("process.completed");
  });

  it("replays persisted events after the reconnect sequence without duplication", async () => {
    const f = fixture();
    const started = await f.service.startTask({ projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, objective: "stream", modelRole: "main-coder" });
    if (!started.ok) throw new Error("fixture start failed");
    const stream = f.service.subscribe(started.value.header.id, 1)[Symbol.asyncIterator]();
    const event = await stream.next();
    expect(event.value?.kind === "session-event" && event.value.event.sequence).toBe(2);
    await stream.return?.();
  });

  it("records crash recovery in the same session and does not create a continuation", async () => {
    const f = fixture();
    const started = await f.service.startTask({ projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, objective: "recover", modelRole: "main-coder" });
    if (!started.ok) throw new Error("fixture start failed");
    const recovered = await recoverExistingSession(f.repository, started.value.header.id, ["orphan-1" as ProcessId]);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value.header.id).toBe(started.value.header.id);
    expect(recovered.value.header.continuation).toBeNull();
    expect(recovered.value.outcome).toBe("failed");
    const afterFirstRecovery = f.repository.events.get(started.value.header.id) ?? [];
    expect(afterFirstRecovery.slice(-2).map((event) => event.payload.kind)).toEqual(["session.recovered", "session.completed"]);
    const repeated = await recoverExistingSession(f.repository, started.value.header.id, ["orphan-1" as ProcessId]);
    expect(repeated.ok && repeated.value.outcome).toBe("failed");
    expect(f.repository.events.get(started.value.header.id)).toHaveLength(afterFirstRecovery.length);
  });
});

function envelope(overrides: Partial<CapabilityEnvelope> = {}): CapabilityEnvelope {
  return {
    grants: [{ kind: "read-files", pathPrefixes: ["." as RelativePath] }, { kind: "spawn-child" }],
    modelRoles: ["main-coder", "diagnostician"],
    maxCostUsdMicros: 0 as UsdMicros,
    maxModelCalls: 8,
    maxProcessStarts: 4,
    maxInputTokens: 10_000 as TokenCount,
    maxOutputTokens: 2_000 as TokenCount,
    wallTimeMs: 60_000 as DurationMs,
    createdAt: NOW,
    ...overrides,
  };
}

function modelRouter(): ModelRouter {
  return {
    async resolve(role: ModelRole) { return { ok: true, value: route(role) }; },
    async stream() { return { ok: false, error: { kind: "validation", message: "unused", field: null, recoverable: true, callerAction: "fix-request" } }; },
  };
}

function route(role: ModelRole): ModelRouteSignature {
  return {
    role,
    providerId: "test",
    modelId: "scripted",
    variant: null,
    servingProvider: "test",
    quantization: null,
    reasoning: { mode: "off" },
    temperature: 0,
    topP: null,
    seed: 1,
    contextLimit: 10_000 as TokenCount,
    outputLimit: 2_000 as TokenCount,
    equivalentListPrice: {
      inputUsdMicrosPerMillionTokens: 0 as UsdMicros,
      cachedInputUsdMicrosPerMillionTokens: 0 as UsdMicros,
      outputUsdMicrosPerMillionTokens: 0 as UsdMicros,
    },
  };
}

function projectRepository(
  project: ProjectRecord,
  workspace: WorkspaceRecord,
  pointerWrites: { count: number },
): ProjectRepository {
  return {
    async registerWorkspace() { return { ok: true, value: { project, workspace } }; },
    async registerBenchmarkWorkspace(projectId) {
      return projectId === project.id ? { ok: true, value: workspace } : notFound("project", projectId);
    },
    async getProject(id) { return id === project.id ? { ok: true, value: project } : notFound("project", id); },
    async getWorkspace(id) { return id === workspace.id ? { ok: true, value: workspace } : notFound("workspace", id); },
    async listProjects() { return { ok: true, value: { items: [project], nextCursor: null } }; },
    async compareAndSetActiveHarness() {
      pointerWrites.count += 1;
      return { ok: true, value: project };
    },
  };
}

function harnessRepository(harnesses: readonly HarnessManifest[], activeHarnessId: HarnessId): HarnessRepository {
  return {
    async putComponent() { return { ok: false, error: validationError("unused") }; },
    async putHarness(manifest) { return { ok: true, value: manifest }; },
    async getHarness(id) {
      const harness = harnesses.find((candidate) => candidate.id === id);
      return harness === undefined ? notFound("harness", id) : { ok: true, value: harness };
    },
    async getActiveHarness() {
      const harness = harnesses.find((candidate) => candidate.id === activeHarnessId);
      return harness === undefined ? notFound("harness", activeHarnessId) : { ok: true, value: harness };
    },
    async listProjectHarnesses() { return { ok: true, value: { items: harnesses, nextCursor: null } }; },
  };
}

function allowPolicy(): ExecutionPolicy {
  return {
    async evaluate() { return { ok: true, value: { outcome: "allow", reason: "test", constraints: [] } }; },
    async getEscalation(id) { return notFound("escalation", id); },
    async listEscalations() { return { ok: true, value: { items: [], nextCursor: null } }; },
    async resolve(request) { return notFound("escalation", request.escalationId); },
  };
}

function processHandle(id: ProcessId): ProcessHandle {
  return {
    id,
    state: "running",
    harnessId: HARNESS_ID,
    sandbox: { backend: "docker", backendVersion: "1", image: "test", imageDigest: "1".repeat(64) as Sha256, containerUser: "1000" },
    startedAt: NOW,
  };
}

function completion(processId: ProcessId): ProcessCompletion {
  const descriptor: ObjectDescriptor = { hash: `object-${processId}` as ObjectHash, size: 0 as ByteCount, mediaType: "text/plain", createdAt: NOW };
  return { processId, state: "cancelled", exitCode: null, signal: "SIGTERM", durationMs: 1 as DurationMs, stdout: descriptor, stderr: descriptor };
}

function unsupportedProcess(): { readonly ok: false; readonly error: ProcessError } {
  return { ok: false, error: { kind: "unsupported", feature: "test", recoverable: false, callerAction: "propagate" } };
}

function validationError(message: string): ValidationError {
  return { kind: "validation", message, field: null, recoverable: true, callerAction: "fix-request" };
}

function notFound(resource: string, id: string): { readonly ok: false; readonly error: NotFoundError } {
  return { ok: false, error: { kind: "not-found", resource, id, recoverable: false, callerAction: "propagate" } };
}

function conflictResult(resource: string, expected: string, actual: string): { readonly ok: false; readonly error: SessionError } {
  return { ok: false, error: { kind: "conflict", resource, expected, actual, recoverable: true, callerAction: "refresh-version-and-retry" } };
}
