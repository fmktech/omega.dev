import { randomUUID } from "node:crypto";

import type {
  ArtifactId,
  ArtifactRecord,
  CapabilityDeniedError,
  ChildSessionRecord,
  CreateRunnerProtocolDispatcher,
  HarnessError,
  HarnessId,
  KernelToRunnerEnvelope,
  ModelCompletion,
  ModelError,
  ModelStreamId,
  ModelStreamEvent,
  ObjectHash,
  ProcessCompletion,
  ProcessId,
  ProjectId,
  Result,
  RunnerReply,
  RunnerRequest,
  SessionError,
  SessionId,
  Timestamp,
} from "../contracts/index.js";

const PROTOCOL = "omega-runner-jsonl";
const VERSION = 1;
const CHILD_EVENT_READ_LIMIT = 10_000;

type ProcessArtifacts = {
  readonly sessionId: SessionId;
  readonly harnessId: HarnessId;
  readonly stdoutArtifactId: ArtifactId;
  readonly stderrArtifactId: ArtifactId;
};

export const createRunnerProtocolDispatcher: CreateRunnerProtocolDispatcher = (getContext) => {
  const pumps = new Map<SessionId, Promise<void>>();
  const processArtifacts = new Map<ProcessId, ProcessArtifacts>();
  const completedProcessEvidence = new Set<ProcessId>();

  async function run(sessionId: SessionId): Promise<void> {
    const context = getContext();
    try {
      for await (const envelope of context.runners.receive(sessionId)) {
        if (envelope.message.kind === "runner.protocol-error") {
          await context.sessions.completeFromRunner(sessionId, "failed");
          break;
        }
        if (envelope.message.kind !== "runner.request") continue;
        await dispatch(sessionId, envelope.message.request);
      }
    } catch {
      try {
        await context.sessions.completeFromRunner(sessionId, "failed");
      } catch {
        // A runner request must never reject the daemon-owned dispatcher pump.
      }
    } finally {
      try {
        const stopped = await context.runners.stop(sessionId, "runner request stream ended");
        if (stopped.ok) {
          const session = await context.sessionRepository.get(sessionId);
          if (session.ok) await context.sessions.recordRunnerEvent(sessionId, {
            kind: "runner.stopped",
            harnessId: session.value.header.initialHarnessId,
            outcome: stopped.value.state,
          }, session.value.header.initialHarnessId);
        }
      } catch {
        // Cleanup is best effort after a failed runner or dependency.
      }
      pumps.delete(sessionId);
    }
  }

  async function dispatch(sessionId: SessionId, request: RunnerRequest): Promise<void> {
    const context = getContext();
    const session = await context.sessionRepository.get(sessionId);
    if (!session.ok) return;
    const projectId = session.value.header.projectId;
    const capabilities = session.value.header.capabilityEnvelope;
    const harnessId = session.value.header.initialHarnessId;
    let reply: RunnerReply;
    let afterReply: (() => Promise<void>) | null = null;

    switch (request.kind) {
      case "context.bootstrap": {
        const workspace = await context.projects.getWorkspace(session.value.header.workspaceId);
        const harness = await context.harnesses.getHarness(session.value.header.initialHarnessId);
        const result = !workspace.ok ? workspace : !harness.ok ? harness : await context.context.bootstrap(workspace.value, harness.value);
        reply = { kind: "context.bootstrapped", requestId: request.requestId, result };
        break;
      }
      case "skill.read": {
        const harness = await context.harnesses.getHarness(request.harnessId);
        const result = !harness.ok
          ? harness
          : harness.value.projectId !== projectId
            ? denied("read-files", "The skill harness does not belong to this runner project")
            : await context.context.readSkill(request.harnessId, request.componentId);
        reply = { kind: "skill.read", requestId: request.requestId, result };
        if (result.ok) await context.sessions.recordRunnerEvent(sessionId, { kind: "skill.loaded", componentId: result.value.componentId }, harnessId);
        break;
      }
      case "model.start": {
        const result = request.request.sessionId === sessionId
          ? await context.models.stream(request.request, capabilities)
          : validationModel("Model request session does not match its runner", "request.sessionId");
        reply = {
          kind: "model.started",
          requestId: request.requestId,
          result: result.ok ? { ok: true, value: { streamId: result.value.id, route: result.value.route } } : result,
        };
        if (result.ok) {
          await context.sessions.recordRunnerEvent(sessionId, { kind: "model.started", streamId: result.value.id, route: result.value.route }, request.request.harnessId);
          afterReply = async () => { await pumpModel(sessionId, request.request.harnessId, result.value.events); };
        } else {
          await context.sessions.recordRunnerEvent(sessionId, {
            kind: "model.failed",
            streamId: `stream_start_failed_${request.requestId}` as ModelStreamId,
            error: result.error,
            partialArtifactId: null,
          }, request.request.harnessId);
        }
        break;
      }
      case "process.start": {
        const result = request.spec.sessionId === sessionId
          ? await context.processes.start(request.spec, capabilities)
          : validationProcess("Process request session does not match its runner", "spec.sessionId");
        reply = { kind: "process.started", requestId: request.requestId, result };
        if (result.ok) {
          const artifacts: ProcessArtifacts = {
            sessionId,
            harnessId: request.spec.harnessId,
            stdoutArtifactId: artifactId(),
            stderrArtifactId: artifactId(),
          };
          processArtifacts.set(result.value.id, artifacts);
          await context.sessions.recordRunnerEvent(sessionId, {
            kind: "process.started",
            handle: result.value,
            spec: request.spec,
            stdoutArtifactId: artifacts.stdoutArtifactId,
            stderrArtifactId: artifacts.stderrArtifactId,
          }, request.spec.harnessId);
        }
        break;
      }
      case "process.observe": {
        const result = ownsProcess(request.processId, sessionId)
          ? await context.processes.observe(request.processId, request.after)
          : denied("start-process", "The process is not owned by this runner session");
        reply = { kind: "process.observed", requestId: request.requestId, result };
        if (result.ok) {
          await context.sessions.recordRunnerEvent(sessionId, {
            kind: "process.observed",
            processId: request.processId,
            ranges: result.value.slices.map((slice) => ({ stream: slice.stream, range: slice.range })),
          }, harnessId);
          afterReply = async () => {
            for (const slice of result.value.slices) {
              const event = { processId: request.processId, stream: slice.stream, range: slice.range, encoding: slice.encoding, data: slice.data } as const;
              context.sessions.publishRunnerEvent({ kind: "process-output", sessionId, event });
              await sendEvent(sessionId, { kind: "process.output", event });
            }
            if (result.value.state !== "starting" && result.value.state !== "running") {
              await collectTerminalProcessCompletion(request.processId);
            }
          };
        }
        break;
      }
      case "process.input":
        reply = {
          kind: "process.input-accepted",
          requestId: request.requestId,
          result: ownsProcess(request.processId, sessionId)
            ? await context.processes.input(request.processId, request.input)
            : denied("start-process", "The process is not owned by this runner session"),
        };
        break;
      case "process.cancel": {
        const result = ownsProcess(request.processId, sessionId)
          ? await context.processes.cancel(request.processId, request.reason)
          : denied("start-process", "The process is not owned by this runner session");
        reply = { kind: "process.cancelled", requestId: request.requestId, result };
        if (result.ok) afterReply = async () => { await recordProcessCompletion(result.value); };
        break;
      }
      case "artifact.read": {
        const result = await context.sessionRepository.readArtifact(request.artifactId, request.offset, request.limit);
        const continuation = session.value.header.continuation;
        const suppliedArtifactIds = continuation === null
          ? []
          : [continuation.handoffArtifactId, ...continuation.contextArtifactIds];
        reply = {
          kind: "artifact.read",
          requestId: request.requestId,
          result: result.ok && result.value.artifact.sessionId !== sessionId && !suppliedArtifactIds.includes(request.artifactId)
            ? denied("read-files", "The artifact is neither owned by nor explicitly supplied to this runner session")
            : result,
        };
        break;
      }
      case "file.read":
        reply = {
          kind: "file.read",
          requestId: request.requestId,
          result: request.workspaceId === session.value.header.workspaceId
            ? await context.files.read(request.workspaceId, request.path, capabilities)
            : denied("read-files", "The workspace is not owned by this runner session"),
        };
        break;
      case "file.write":
        reply = {
          kind: "file.written",
          requestId: request.requestId,
          result: request.request.sessionId === sessionId && request.request.workspaceId === session.value.header.workspaceId
            ? await context.files.write(request.request, capabilities)
            : denied("write-files", "The session or workspace is not owned by this runner"),
        };
        break;
      case "child.spawn": {
        const result = request.request.parentSessionId === sessionId
          ? await context.sessions.spawnChild(request.request)
          : denied("spawn-child", "The parent session does not match this runner session");
        reply = { kind: "child.spawned", requestId: request.requestId, result: result.ok ? result : { ok: false, error: asSessionError(result.error) } };
        break;
      }
      case "child.observe":
        reply = { kind: "child.observed", requestId: request.requestId, result: await observeChild(sessionId, request.sessionId) };
        break;
      case "knowledge.catalog":
        reply = {
          kind: "knowledge.catalogued",
          requestId: request.requestId,
          result: request.query.projectId === session.value.header.projectId
            ? await context.knowledge.catalog(request.query)
            : denied("read-files", "The knowledge project does not match this runner session"),
        };
        break;
      case "knowledge.read":
        reply = { kind: "knowledge.read", requestId: request.requestId, result: await context.knowledge.read(session.value.header.projectId, request.documentId) };
        break;
      case "knowledge.write": {
        const result = request.request.projectId === session.value.header.projectId
          && request.request.document.projectId === session.value.header.projectId
          ? await context.knowledge.write(request.request, capabilities)
          : denied("write-files", "The knowledge project does not match this runner session");
        reply = { kind: "knowledge.written", requestId: request.requestId, result };
        if (result.ok) await context.sessions.recordRunnerEvent(sessionId, { kind: "knowledge.updated", documentId: result.value.frontmatter.id, objectHash: result.value.sha as unknown as ObjectHash }, harnessId);
        break;
      }
      case "marketplace.search":
        reply = { kind: "marketplace.found", requestId: request.requestId, result: await context.marketplace.search(request.query) };
        break;
      case "marketplace.install":
        reply = { kind: "marketplace.installed", requestId: request.requestId, result: await context.marketplace.install(session.value.header.projectId, request.artifactId, capabilities) };
        break;
      case "harness.evolve": {
        const result = request.request.projectId === session.value.header.projectId
          && request.request.sourceSessionId === sessionId
          ? await context.evolution.start(request.request, capabilities)
          : denied("create-harness-candidate", "The evolution source does not match this runner session");
        reply = { kind: "harness.evolution-started", requestId: request.requestId, result };
        if (result.ok) await context.sessions.recordRunnerEvent(sessionId, { kind: "evolution.updated", jobId: result.value.id, state: result.value.state }, harnessId);
        break;
      }
      case "harness.status":
        reply = {
          kind: "harness.status",
          requestId: request.requestId,
          result: request.projectId === session.value.header.projectId
            ? await context.harnesses.getActiveHarness(request.projectId)
            : denied("read-files", "The harness project does not match this runner session"),
        };
        break;
      case "evolution.observe": {
        const result = await context.evolution.get(request.jobId);
        reply = {
          kind: "evolution.observed",
          requestId: request.requestId,
          result: result.ok && !ownsEvolution(result.value.request.projectId, result.value.request.sourceSessionId)
            ? denied("create-harness-candidate", "The evolution job is not owned by this runner session")
            : result,
        };
        break;
      }
      case "evolution.cancel": {
        const existing = await context.evolution.get(request.jobId);
        const result = existing.ok && ownsEvolution(existing.value.request.projectId, existing.value.request.sourceSessionId)
          ? await context.evolution.cancel(request.jobId, request.reason)
          : existing.ok
            ? denied("create-harness-candidate", "The evolution job is not owned by this runner session")
            : existing;
        reply = { kind: "evolution.cancelled", requestId: request.requestId, result };
        break;
      }
      case "session.complete":
        reply = { kind: "session.completed", requestId: request.requestId, result: await context.sessions.completeFromRunner(sessionId, request.outcome) };
        break;
    }
    await context.runners.send(sessionId, kernelReply(reply));
    if (afterReply !== null) void afterReply().catch(async () => {
      try {
        await context.sessions.completeFromRunner(sessionId, "failed");
      } catch {
        // Background stream failures are contained to the owning session.
      }
    });

    function ownsProcess(processId: ProcessId, ownerSessionId: SessionId): boolean {
      return processArtifacts.get(processId)?.sessionId === ownerSessionId;
    }

    function ownsEvolution(jobProjectId: ProjectId, sourceSessionId: SessionId): boolean {
      return jobProjectId === projectId && sourceSessionId === sessionId;
    }
  }

  async function pumpModel(sessionId: SessionId, harnessId: HarnessId, events: AsyncIterable<ModelStreamEvent>): Promise<void> {
    const context = getContext();
    for await (const event of events) {
      context.sessions.publishRunnerEvent({ kind: "model-delta", sessionId, event });
      if (event.kind === "completed") await recordModelCompletion(sessionId, harnessId, event.completion);
      if (event.kind === "failed") await context.sessions.recordRunnerEvent(sessionId, {
        kind: "model.failed",
        streamId: event.streamId,
        error: event.error,
        partialArtifactId: event.partialArtifactId,
      }, harnessId);
      // Persist terminal model evidence before the runner can react by completing
      // its session. Evolution consumes the append-only log, not the live stream.
      await sendEvent(sessionId, { kind: "model.event", event });
    }
  }

  async function recordModelCompletion(sessionId: SessionId, harnessId: HarnessId, completion: ModelCompletion): Promise<void> {
    const context = getContext();
    const bytes = Buffer.from(`${JSON.stringify(completion)}\n`, "utf8");
    const stored = await context.objects.put("application/vnd.omega.model-response+json", oneChunk(bytes));
    if (!stored.ok) return;
    const artifact: ArtifactRecord = {
      id: artifactId(),
      kind: "model-response",
      object: stored.value,
      sessionId,
      createdAt: now(),
      metadata: { streamId: completion.streamId, harnessId },
    };
    const recorded = await context.sessionRepository.recordArtifact(artifact);
    if (!recorded.ok) return;
    await context.sessions.recordRunnerEvent(sessionId, { kind: "artifact.recorded", artifact: recorded.value }, harnessId);
    await context.sessions.recordRunnerEvent(sessionId, { kind: "model.completed", completion, aggregateArtifactId: recorded.value.id }, harnessId);
  }

  async function recordProcessCompletion(completion: ProcessCompletion): Promise<void> {
    if (completedProcessEvidence.has(completion.processId)) return;
    completedProcessEvidence.add(completion.processId);
    await persistProcessCompletion(completion);
  }

  async function collectTerminalProcessCompletion(processId: ProcessId): Promise<void> {
    if (completedProcessEvidence.has(processId)) return;
    completedProcessEvidence.add(processId);
    const completion = await getContext().processes.cancel(processId, "collect terminal process evidence");
    if (!completion.ok) {
      completedProcessEvidence.delete(processId);
      return;
    }
    await persistProcessCompletion(completion.value);
  }

  async function persistProcessCompletion(completion: ProcessCompletion): Promise<void> {
    const context = getContext();
    const artifacts = processArtifacts.get(completion.processId);
    if (artifacts === undefined) return;
    processArtifacts.delete(completion.processId);
    const stdout: ArtifactRecord = { id: artifacts.stdoutArtifactId, kind: "process-stdout", object: completion.stdout, sessionId: artifacts.sessionId, createdAt: now(), metadata: { processId: completion.processId } };
    const stderr: ArtifactRecord = { id: artifacts.stderrArtifactId, kind: "process-stderr", object: completion.stderr, sessionId: artifacts.sessionId, createdAt: now(), metadata: { processId: completion.processId } };
    const recordedOut = await context.sessionRepository.recordArtifact(stdout);
    const recordedErr = await context.sessionRepository.recordArtifact(stderr);
    if (recordedOut.ok) await context.sessions.recordRunnerEvent(artifacts.sessionId, { kind: "artifact.recorded", artifact: recordedOut.value }, artifacts.harnessId);
    if (recordedErr.ok) await context.sessions.recordRunnerEvent(artifacts.sessionId, { kind: "artifact.recorded", artifact: recordedErr.value }, artifacts.harnessId);
    await context.sessions.recordRunnerEvent(artifacts.sessionId, { kind: "process.completed", completion }, artifacts.harnessId);
    await sendEvent(artifacts.sessionId, { kind: "process.completed", completion });
  }

  async function observeChild(parentSessionId: SessionId, childSessionId: SessionId): Promise<Result<ChildSessionRecord, SessionError>> {
    const context = getContext();
    const child = await context.sessionRepository.get(childSessionId);
    if (!child.ok) return child;
    if (child.value.header.parentSessionId !== parentSessionId) return notFoundChild(childSessionId);
    let cursor = 0;
    for (;;) {
      const events = await context.sessionRepository.read(parentSessionId, cursor, CHILD_EVENT_READ_LIMIT);
      if (!events.ok) return events;
      const spawned = events.value.find((event) => event.payload.kind === "child.spawned" && event.payload.child.sessionId === childSessionId);
      if (spawned?.payload.kind === "child.spawned") return { ok: true, value: { ...spawned.payload.child, state: child.value.state } };
      if (events.value.length < CHILD_EVENT_READ_LIMIT) return notFoundChild(childSessionId);
      cursor = events.value.at(-1)?.sequence ?? cursor;
    }
  }

  async function sendEvent(sessionId: SessionId, event: KernelEvent): Promise<void> {
    await getContext().runners.send(sessionId, kernelEvent(event));
  }

  return {
    start(sessionId) {
      if (!pumps.has(sessionId)) pumps.set(sessionId, run(sessionId));
    },
    async stop(sessionId) {
      const context = getContext();
      await context.runners.stop(sessionId, "runner request dispatcher stopped");
      await pumps.get(sessionId);
    },
  };
};

type KernelEvent = Extract<KernelToRunnerEnvelope["message"], { readonly kind: "kernel.event" }>["event"];

function kernelReply(reply: RunnerReply): KernelToRunnerEnvelope {
  return { protocol: PROTOCOL, version: VERSION, message: { kind: "kernel.reply", reply } };
}

function kernelEvent(event: KernelEvent): KernelToRunnerEnvelope {
  return { protocol: PROTOCOL, version: VERSION, message: { kind: "kernel.event", event } };
}

function artifactId(): ArtifactId {
  return `artifact_${randomUUID()}` as ArtifactId;
}

function now(): Timestamp {
  return new Date().toISOString() as Timestamp;
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

function validationModel(message: string, field: string): Result<never, ModelError> {
  return { ok: false, error: { kind: "validation", message, field, recoverable: true, callerAction: "fix-request" } };
}

function validationProcess(message: string, field: string) {
  return { ok: false as const, error: { kind: "validation" as const, message, field, recoverable: true as const, callerAction: "fix-request" as const } };
}

function denied(capability: CapabilityDeniedError["capability"], reason: string) {
  return {
    ok: false as const,
    error: {
      kind: "capability-denied" as const,
      capability,
      reason,
      recoverable: true as const,
      callerAction: "request-new-child" as const,
    },
  };
}

function notFoundChild(id: SessionId): Result<never, SessionError> {
  return { ok: false, error: { kind: "not-found", resource: "child-session", id, recoverable: false, callerAction: "propagate" } };
}

function asSessionError(error: SessionError | HarnessError): SessionError {
  if (error.kind !== "harness-version-mismatch") return error;
  return { kind: "conflict", resource: "harness-version", expected: error.expected, actual: error.active, recoverable: true, callerAction: "refresh-version-and-retry" };
}
