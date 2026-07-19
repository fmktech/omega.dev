import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import type {
  ArtifactId,
  AbsolutePath,
  ByteCount,
  ComponentId,
  DurationMs,
  EventId,
  HarnessId,
  KernelToRunnerEnvelope,
  LiveEventEnvelope,
  ModelCompletion,
  ModelRouteSignature,
  ModelStreamEvent,
  ModelStreamId,
  ObjectHash,
  OmegaContext,
  PersistedEventPayload,
  ProcessCompletion,
  ProcessHandle,
  ProcessId,
  ProcessSpec,
  ProjectId,
  RequestId,
  RunnerHost,
  RunnerToKernelEnvelope,
  SessionEvent,
  SessionId,
  SessionRecord,
  Timestamp,
  TokenCount,
  UsdMicros,
} from "../contracts/index.js";
import { createRunnerProtocolDispatcher } from "./runner-protocol.js";

const SESSION_ID = "session-protocol" as SessionId;
const HARNESS_ID = "harness-protocol" as HarnessId;
const NOW = "2026-07-16T12:00:00.000Z" as Timestamp;

describe("runner protocol dispatcher", () => {
  it("bootstraps durable context and reads only skills installed in the requested project harness", async () => {
    const skillId = "component-context-skill" as ComponentId;
    const requests: RunnerToKernelEnvelope[] = [
      runnerRequest({ kind: "context.bootstrap", requestId: "request-context" as RequestId }),
      runnerRequest({ kind: "skill.read", requestId: "request-skill" as RequestId, harnessId: HARNESS_ID, componentId: skillId }),
    ];
    const sent: KernelToRunnerEnvelope[] = [];
    const calls: string[] = [];
    const record = sessionRecord();
    const workspace = { id: record.header.workspaceId, projectId: record.header.projectId, path: "/workspace", registeredAt: NOW, lastSeenAt: NOW };
    const harness = { id: HARNESS_ID, projectId: record.header.projectId, alias: "active", parents: [], components: [], sourceArtifacts: [], createdAt: NOW };
    const context = {
      runners: staticRunner(requests, sent),
      sessionRepository: { async get() { return { ok: true, value: record }; } },
      projects: { async getWorkspace() { return { ok: true, value: workspace }; } },
      harnesses: { async getHarness() { return { ok: true, value: harness }; } },
      context: {
        async bootstrap() {
          calls.push("bootstrap");
          return { ok: true, value: { instructions: [], knowledgeCatalog: [], skillCatalog: [] } };
        },
        async readSkill() {
          calls.push("skill.read");
          return { ok: true, value: {
            componentId: skillId,
            objectHash: "a".repeat(64),
            catalog: { componentId: skillId, name: "verify", description: "Verify project", tags: [], relevantPaths: [] },
            markdown: "# Verify\n",
          } };
        },
      },
      sessions: { async recordRunnerEvent(_sessionId: SessionId, payload: PersistedEventPayload) { return { ok: true, value: event(payload) }; } },
    } as unknown as OmegaContext;

    createRunnerProtocolDispatcher(() => context).start(SESSION_ID);
    await waitFor(() => sent.filter(isReplyEnvelope).length === 2);

    expect(sent.filter(isReplyEnvelope).map((envelope) => envelope.message.reply.kind)).toEqual(["context.bootstrapped", "skill.read"]);
    expect(calls).toEqual(["bootstrap", "skill.read"]);
  });

  it("gives every runner request one reply and persists aggregate model semantics while streaming deltas", async () => {
    const route = modelRoute();
    const completion = modelCompletion(route);
    const requests: RunnerToKernelEnvelope[] = [
      runnerRequest({ kind: "model.start", requestId: "request-model" as RequestId, request: {
        sessionId: SESSION_ID,
        harnessId: HARNESS_ID,
        role: "main-coder",
        messages: [{ role: "user", content: [{ kind: "text", text: "finish" }] }],
        tools: [],
        maxOutputTokens: 100 as TokenCount,
        abortAfterMs: 1_000 as SessionRecord["header"]["capabilityEnvelope"]["wallTimeMs"],
      } }),
      runnerRequest({ kind: "session.complete", requestId: "request-complete" as RequestId, outcome: "succeeded" }),
    ];
    const sent: KernelToRunnerEnvelope[] = [];
    const runner: RunnerHost = {
      async start() { return { ok: true, value: processHandle() }; },
      async send(_sessionId, envelope) { sent.push(envelope); return { ok: true, value: undefined }; },
      async *receive() { yield* requests; },
      async stop() { return { ok: true, value: processCompletion() }; },
    };
    const persisted: PersistedEventPayload[] = [];
    const live: LiveEventEnvelope[] = [];
    const artifacts: ArtifactId[] = [];
    const record = sessionRecord();
    const context = {
      runners: runner,
      models: {
        async resolve() { return { ok: true, value: route }; },
        async stream() {
          return { ok: true, value: { id: completion.streamId, route, events: modelEvents(completion), async cancel() { return; } } };
        },
      },
      objects: {
        async put(mediaType: string, chunks: AsyncIterable<Uint8Array>) {
          const bytes: Uint8Array[] = [];
          for await (const chunk of chunks) bytes.push(chunk);
          const size = Buffer.concat(bytes).byteLength as ByteCount;
          return { ok: true, value: { hash: "model-object" as ObjectHash, size, mediaType, createdAt: NOW } };
        },
      },
      sessionRepository: {
        async get() { return { ok: true, value: record }; },
        async recordArtifact(artifact: { readonly id: ArtifactId }) { artifacts.push(artifact.id); return { ok: true, value: artifact }; },
      },
      sessions: {
        async recordRunnerEvent(_sessionId: SessionId, payload: PersistedEventPayload): Promise<{ readonly ok: true; readonly value: SessionEvent }> {
          persisted.push(payload);
          return { ok: true, value: { id: `event-${persisted.length}` as EventId, sequence: persisted.length, at: NOW, harnessId: HARNESS_ID, payload } };
        },
        publishRunnerEvent(event: LiveEventEnvelope) { live.push(event); },
        async completeFromRunner() { return { ok: true, value: { ...record, state: "completed" as const, outcome: "succeeded" as const, completedAt: NOW } }; },
      },
    } as unknown as OmegaContext;
    const dispatcher = createRunnerProtocolDispatcher(() => context);

    dispatcher.start(SESSION_ID);
    await waitFor(() => sent.filter((envelope) => envelope.message.kind === "kernel.reply").length === 2 && persisted.some((event) => event.kind === "model.completed"));

    const replies = sent.flatMap((envelope) => envelope.message.kind === "kernel.reply" ? [envelope.message.reply] : []);
    expect(replies.map((reply) => reply.requestId)).toEqual(["request-model", "request-complete"]);
    expect(persisted.map((event) => event.kind)).toEqual(expect.arrayContaining(["model.started", "artifact.recorded", "model.completed", "runner.stopped"]));
    expect(artifacts).toHaveLength(1);
    expect(live.filter((event) => event.kind === "model-delta")).toHaveLength(2);
  });

  it("rejects cross-session and cross-workspace requests at the dispatcher boundary", async () => {
    const otherSession = "session-hostile" as SessionId;
    const otherProject = "project-hostile" as ProjectId;
    const otherWorkspace = "workspace-hostile" as SessionRecord["header"]["workspaceId"];
    const foreignProcess = "process-hostile" as ProcessId;
    const foreignArtifact = "artifact-hostile" as ArtifactId;
    const requests: RunnerToKernelEnvelope[] = [
      runnerRequest({ kind: "process.observe", requestId: "hostile-process" as RequestId, processId: foreignProcess, after: [] }),
      runnerRequest({ kind: "file.read", requestId: "hostile-read" as RequestId, workspaceId: otherWorkspace, path: "secret.txt" as never }),
      runnerRequest({ kind: "file.write", requestId: "hostile-write" as RequestId, request: { sessionId: otherSession, workspaceId: otherWorkspace, path: "secret.txt" as never, expectedSha: null, content: "mine" } }),
      runnerRequest({ kind: "child.spawn", requestId: "hostile-child" as RequestId, request: { parentSessionId: otherSession, role: "task", objective: "escape", contextArtifactIds: [], capabilityEnvelope: sessionRecord().header.capabilityEnvelope } }),
      runnerRequest({ kind: "knowledge.catalog", requestId: "hostile-knowledge" as RequestId, query: { projectId: otherProject, text: "secret", tags: [], relevantPaths: [], limit: 1 } }),
      runnerRequest({ kind: "harness.evolve", requestId: "hostile-evolve" as RequestId, request: {
        projectId: otherProject,
        sourceSessionId: otherSession,
        goal: "escape",
        evidenceArtifactIds: [],
        allowedComponentKinds: ["tool"],
        budget: { wallTimeMs: 1 as DurationMs, maxModelCalls: 1, maxInputTokens: 1 as TokenCount, maxOutputTokens: 1 as TokenCount, maxCostUsdMicros: 0 as UsdMicros, maxProcessStarts: 1 },
      } }),
      runnerRequest({ kind: "harness.status", requestId: "hostile-status" as RequestId, projectId: otherProject }),
      runnerRequest({ kind: "artifact.read", requestId: "hostile-artifact" as RequestId, artifactId: foreignArtifact, offset: 0 as ByteCount, limit: 10 as ByteCount }),
    ];
    const sent: KernelToRunnerEnvelope[] = [];
    const boundaryCalls: string[] = [];
    const record = sessionRecord();
    const foreignArtifactRecord = {
      id: foreignArtifact,
      kind: "process-stdout" as const,
      object: { hash: "foreign-object" as ObjectHash, size: 0 as ByteCount, mediaType: "text/plain", createdAt: NOW },
      sessionId: otherSession,
      createdAt: NOW,
      metadata: {},
    };
    const context = {
      runners: staticRunner(requests, sent),
      sessionRepository: {
        async get() { return { ok: true, value: record }; },
        async readArtifact() { boundaryCalls.push("artifact.read"); return { ok: true, value: { artifact: foreignArtifactRecord, range: { startInclusive: 0 as ByteCount, endExclusive: 0 as ByteCount }, encoding: "utf8" as const, data: "", complete: true } }; },
      },
      processes: { async observe() { boundaryCalls.push("process.observe"); throw new Error("boundary crossed"); } },
      files: {
        async read() { boundaryCalls.push("file.read"); throw new Error("boundary crossed"); },
        async write() { boundaryCalls.push("file.write"); throw new Error("boundary crossed"); },
      },
      knowledge: { async catalog() { boundaryCalls.push("knowledge.catalog"); throw new Error("boundary crossed"); } },
      harnesses: { async getActiveHarness() { boundaryCalls.push("harness.status"); throw new Error("boundary crossed"); } },
      evolution: { async start() { boundaryCalls.push("evolution.start"); throw new Error("boundary crossed"); } },
      sessions: {
        async spawnChild() { boundaryCalls.push("child.spawn"); throw new Error("boundary crossed"); },
        async recordRunnerEvent(_sessionId: SessionId, payload: PersistedEventPayload) { return { ok: true, value: event(payload) }; },
      },
    } as unknown as OmegaContext;

    createRunnerProtocolDispatcher(() => context).start(SESSION_ID);
    await waitFor(() => sent.filter(isReplyEnvelope).length === requests.length);

    const replies = sent.filter(isReplyEnvelope).map((envelope) => envelope.message.reply);
    expect(replies.every((reply) => "result" in reply && !reply.result.ok && reply.result.error.kind === "capability-denied")).toBe(true);
    expect(boundaryCalls).toEqual(["artifact.read"]);
  });

  it("lets an isolated child read only artifacts explicitly supplied in its continuation", async () => {
    const suppliedArtifactId = "artifact-supplied" as ArtifactId;
    const requestId = "request-supplied-artifact" as RequestId;
    const sent: KernelToRunnerEnvelope[] = [];
    const base = sessionRecord();
    const record: SessionRecord = {
      ...base,
      header: {
        ...base.header,
        parentSessionId: "session-parent" as SessionId,
        role: "evolution",
        continuation: {
          sourceSessionId: "session-parent" as SessionId,
          handoffArtifactId: "artifact-handoff" as ArtifactId,
          contextArtifactIds: [suppliedArtifactId],
        },
      },
    };
    const artifact = {
      id: suppliedArtifactId,
      kind: "model-response" as const,
      object: { hash: "supplied-object" as ObjectHash, size: 8 as ByteCount, mediaType: "text/plain", createdAt: NOW },
      sessionId: "session-parent" as SessionId,
      createdAt: NOW,
      metadata: {},
    };
    const context = {
      runners: staticRunner([
        runnerRequest({ kind: "artifact.read", requestId, artifactId: suppliedArtifactId, offset: 0 as ByteCount, limit: 8 as ByteCount }),
      ], sent),
      sessionRepository: {
        async get() { return { ok: true, value: record }; },
        async readArtifact() {
          return { ok: true, value: { artifact, range: { startInclusive: 0 as ByteCount, endExclusive: 8 as ByteCount }, encoding: "utf8" as const, data: "evidence", complete: true } };
        },
      },
    } as unknown as OmegaContext;

    createRunnerProtocolDispatcher(() => context).start(SESSION_ID);
    await waitFor(() => sent.filter(isReplyEnvelope).length === 1);

    const reply = sent.find(isReplyEnvelope)?.message.reply;
    expect(reply).toMatchObject({ kind: "artifact.read", requestId, result: { ok: true, value: { data: "evidence" } } });
  });

  it("records aggregate process evidence once when observation discovers natural completion", async () => {
    const toolProcessId = "process-tool" as ProcessId;
    const requests: RunnerToKernelEnvelope[] = [
      runnerRequest({ kind: "process.start", requestId: "process-start" as RequestId, spec: toolProcessSpec() }),
      runnerRequest({ kind: "process.observe", requestId: "process-observe-1" as RequestId, processId: toolProcessId, after: [] }),
      runnerRequest({ kind: "process.observe", requestId: "process-observe-2" as RequestId, processId: toolProcessId, after: [] }),
    ];
    const sent: KernelToRunnerEnvelope[] = [];
    const persisted: PersistedEventPayload[] = [];
    const artifacts: ArtifactId[] = [];
    const record = sessionRecord();
    const completion = toolProcessCompletion(toolProcessId);
    let completionReads = 0;
    const context = {
      runners: staticRunner(requests, sent),
      processes: {
        async start() { return { ok: true, value: { ...processHandle(), id: toolProcessId } }; },
        async observe() { return { ok: true, value: { processId: toolProcessId, state: "exited" as const, slices: [], observedAt: NOW } }; },
        async cancel() { completionReads += 1; return { ok: true, value: completion }; },
      },
      sessionRepository: {
        async get() { return { ok: true, value: record }; },
        async recordArtifact(artifact: { readonly id: ArtifactId }) { artifacts.push(artifact.id); return { ok: true, value: artifact }; },
      },
      sessions: {
        async recordRunnerEvent(_sessionId: SessionId, payload: PersistedEventPayload) { persisted.push(payload); return { ok: true, value: event(payload) }; },
        publishRunnerEvent() { return; },
      },
    } as unknown as OmegaContext;

    createRunnerProtocolDispatcher(() => context).start(SESSION_ID);
    await waitFor(() => persisted.some((payload) => payload.kind === "process.completed"));

    expect(completionReads).toBe(1);
    expect(artifacts).toHaveLength(2);
    expect(persisted.filter((payload) => payload.kind === "artifact.recorded")).toHaveLength(2);
    expect(persisted.filter((payload) => payload.kind === "process.completed")).toHaveLength(1);
  });

  it("contains a dispatch exception to its owning session", async () => {
    const toolProcessId = "process-failing-dispatch" as ProcessId;
    const sent: KernelToRunnerEnvelope[] = [];
    const failedOutcomes: string[] = [];
    const record = sessionRecord();
    const context = {
      runners: staticRunner([
        runnerRequest({ kind: "process.start", requestId: "failing-start" as RequestId, spec: toolProcessSpec() }),
        runnerRequest({ kind: "process.observe", requestId: "failing-observe" as RequestId, processId: toolProcessId, after: [] }),
      ], sent),
      processes: {
        async start() { return { ok: true, value: { ...processHandle(), id: toolProcessId } }; },
        async observe() { throw new Error("supervisor failed"); },
      },
      sessionRepository: { async get() { return { ok: true, value: record }; } },
      sessions: {
        async recordRunnerEvent(_sessionId: SessionId, payload: PersistedEventPayload) { return { ok: true, value: event(payload) }; },
        async completeFromRunner(_sessionId: SessionId, outcome: string) { failedOutcomes.push(outcome); return { ok: true, value: { ...record, state: "failed" as const, outcome: "failed" as const, completedAt: NOW } }; },
      },
    } as unknown as OmegaContext;

    createRunnerProtocolDispatcher(() => context).start(SESSION_ID);
    await waitFor(() => failedOutcomes.length === 1);

    expect(failedOutcomes).toEqual(["failed"]);
    expect(sent.filter(isReplyEnvelope)).toHaveLength(1);
  });
});

function runnerRequest(request: Extract<RunnerToKernelEnvelope["message"], { readonly kind: "runner.request" }>["request"]): RunnerToKernelEnvelope {
  return { protocol: "omega-runner-jsonl", version: 1, message: { kind: "runner.request", request } };
}

function staticRunner(requests: readonly RunnerToKernelEnvelope[], sent: KernelToRunnerEnvelope[]): RunnerHost {
  return {
    async start() { return { ok: true, value: processHandle() }; },
    async send(_sessionId, envelope) { sent.push(envelope); return { ok: true, value: undefined }; },
    async *receive() { yield* requests; },
    async stop() { return { ok: true, value: processCompletion() }; },
  };
}

function isReplyEnvelope(envelope: KernelToRunnerEnvelope): envelope is KernelToRunnerEnvelope & { readonly message: Extract<KernelToRunnerEnvelope["message"], { readonly kind: "kernel.reply" }> } {
  return envelope.message.kind === "kernel.reply";
}

function event(payload: PersistedEventPayload): SessionEvent {
  return { id: `event-${payload.kind}` as EventId, sequence: 1, at: NOW, harnessId: HARNESS_ID, payload };
}

function sessionRecord(): SessionRecord {
  return {
    header: {
      id: SESSION_ID,
      threadId: "thread-protocol" as SessionRecord["header"]["threadId"],
      parentSessionId: null,
      continuation: null,
      projectId: "project-protocol" as SessionRecord["header"]["projectId"],
      workspaceId: "workspace-protocol" as SessionRecord["header"]["workspaceId"],
      role: "main",
      objective: "finish",
      initialHarnessId: HARNESS_ID,
      initialModelRoutes: [modelRoute()],
      policyProfile: "guarded",
      capabilityEnvelope: { ...DEFAULT_CONFIG.sessions.mainCapabilities, createdAt: NOW },
      credentialEnvNames: [],
      eventSchemaVersion: 1,
      createdAt: NOW,
    },
    state: "running",
    lastSequence: 2,
    completedAt: null,
    outcome: null,
  };
}

function modelRoute(): ModelRouteSignature {
  return {
    role: "main-coder",
    providerId: "scripted",
    modelId: "scripted",
    variant: null,
    servingProvider: "scripted",
    quantization: null,
    reasoning: { mode: "off" },
    temperature: 0,
    topP: null,
    seed: 1,
    contextLimit: 4_096 as TokenCount,
    outputLimit: 1_024 as TokenCount,
    equivalentListPrice: { inputUsdMicrosPerMillionTokens: 0 as UsdMicros, cachedInputUsdMicrosPerMillionTokens: 0 as UsdMicros, outputUsdMicrosPerMillionTokens: 0 as UsdMicros },
  };
}

function modelCompletion(route: ModelRouteSignature): ModelCompletion {
  return {
    streamId: "stream-protocol" as ModelStreamId,
    providerGenerationId: "generation-protocol",
    route,
    content: [{ kind: "text", text: "done" }],
    usage: { inputTokens: 1 as TokenCount, cachedInputTokens: 0 as TokenCount, reasoningTokens: 0 as TokenCount, outputTokens: 1 as TokenCount, costUsdMicros: 0 as UsdMicros },
    startedAt: NOW,
    firstTokenAt: NOW,
    completedAt: NOW,
    finishReason: "stop",
  };
}

async function* modelEvents(completion: ModelCompletion): AsyncIterable<ModelStreamEvent> {
  yield { kind: "text-delta", streamId: completion.streamId, delta: "done" };
  yield { kind: "completed", completion };
}

function processHandle(): ProcessHandle {
  return { id: "runner-process" as ProcessHandle["id"], state: "running", harnessId: HARNESS_ID, sandbox: { backend: "docker", backendVersion: "test", image: "test", imageDigest: "0".repeat(64) as ProcessHandle["sandbox"]["imageDigest"], containerUser: "1000:1000" }, startedAt: NOW };
}

function processCompletion(): ProcessCompletion {
  const object = { hash: "empty" as ObjectHash, size: 0 as ByteCount, mediaType: "application/octet-stream", createdAt: NOW };
  return { processId: "runner-process" as ProcessCompletion["processId"], state: "cancelled", exitCode: null, signal: "SIGTERM", durationMs: 1 as ProcessCompletion["durationMs"], stdout: object, stderr: object };
}

function toolProcessSpec(): ProcessSpec {
  return {
    executable: "true",
    args: [],
    cwd: "/workspace" as AbsolutePath,
    credentialEnvNames: [],
    stdin: "closed",
    timeoutMs: 1_000 as DurationMs,
    sandbox: {
      filesystem: "workspace-read-write",
      network: "none",
      allowedHosts: [],
      memoryLimitBytes: 1_024 as ByteCount,
      cpuTimeLimitMs: 1_000 as DurationMs,
      runtime: {
        kind: "oci",
        image: "omega-test",
        expectedImageDigest: null,
        containerUser: "1000:1000",
        workspaceMountPath: "/workspace" as AbsolutePath,
      },
    },
    harnessId: HARNESS_ID,
    sessionId: SESSION_ID,
  };
}

function toolProcessCompletion(processId: ProcessId): ProcessCompletion {
  const object = { hash: "tool-output" as ObjectHash, size: 0 as ByteCount, mediaType: "text/plain", createdAt: NOW };
  return { processId, state: "exited", exitCode: 0, signal: null, durationMs: 2 as DurationMs, stdout: object, stderr: object };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for protocol pump");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}
