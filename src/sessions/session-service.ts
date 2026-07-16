import { randomUUID } from "node:crypto";

import type {
  ArtifactId,
  CapabilityDeniedError,
  ChildSessionRecord,
  CreateSessionService,
  EventId,
  HarnessError,
  HarnessId,
  HarnessManifest,
  KernelToRunnerEnvelope,
  LiveEventEnvelope,
  ModelError,
  PersistedEventPayload,
  ProcessError,
  ProcessId,
  Result,
  SessionError,
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionOutcome,
  SessionRecord,
  SpawnChildRequest,
  ThreadId,
  Timestamp,
  WorkspaceRecord,
} from "../contracts/index.js";
import {
  attenuateChildCapabilities,
  childCredentialNames,
  newChildIdentity,
} from "./child-sessions.js";
import {
  createChildResultArtifact,
  createStoredHandoff,
  loadHandoff,
  readAllEvents,
  verifyArtifacts,
} from "./handoffs.js";

const PROTOCOL = "omega-runner-jsonl";
const PROTOCOL_VERSION = 1;
const LIVE_READ_LIMIT = 10_000;

type LiveWaiter = (event: LiveEventEnvelope | null) => void;

class LiveQueue {
  readonly buffered: LiveEventEnvelope[] = [];
  readonly waiters: LiveWaiter[] = [];
  closed = false;

  push(event: LiveEventEnvelope): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.buffered.push(event);
    else waiter(event);
  }

  next(): Promise<LiveEventEnvelope | null> {
    const event = this.buffered.shift();
    if (event !== undefined) return Promise.resolve(event);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.(null);
  }
}

export const createSessionService: CreateSessionService = (options) => {
  const subscriptions = new Map<SessionId, Set<LiveQueue>>();

  function publish(event: LiveEventEnvelope): void {
    for (const queue of subscriptions.get(event.sessionId) ?? []) queue.push(event);
  }

  async function append(
    sessionId: SessionId,
    payload: PersistedEventPayload,
    harnessId: HarnessId,
    reservedEventId: EventId | null = null,
  ): Promise<Result<SessionEvent, SessionError>> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await options.repository.get(sessionId);
      if (!current.ok) return current;
      const appended = await options.repository.append(sessionId, current.value.lastSequence, payload, harnessId, reservedEventId);
      if (appended.ok) {
        publish({ kind: "session-event", sessionId, event: appended.value });
        return appended;
      }
      if (appended.error.kind !== "conflict") return appended;
    }
    return conflict("session-event-sequence", "available append slot", "concurrent writers did not settle");
  }

  async function launch(
    header: SessionHeader,
    harness: HarnessManifest,
    workspace: WorkspaceRecord,
    handoffArtifactId: ArtifactId | null,
  ): Promise<Result<SessionRecord, SessionError | HarnessError>> {
    const created = await options.repository.create(header);
    if (!created.ok) return created;
    const started = await append(header.id, { kind: "session.started" }, harness.id);
    if (!started.ok) return started;
    const runner = await options.runners.start({ session: header, workspace, harness, handoffArtifactId });
    if (!runner.ok) {
      await append(header.id, { kind: "session.completed", outcome: "failed" }, harness.id);
      return { ok: false, error: runnerStartupError(runner.error) };
    }
    const runnerEvent = await append(header.id, {
      kind: "runner.started",
      harnessId: harness.id,
      processId: runner.value.id,
    }, harness.id);
    if (!runnerEvent.ok) {
      await options.runners.stop(header.id, "session event persistence failed");
      return runnerEvent;
    }
    return options.repository.get(header.id);
  }

  async function createHandoffFor(sessionId: SessionId) {
    const session = await options.repository.get(sessionId);
    if (!session.ok) return session;
    const stored = await createStoredHandoff(options.repository, options.objects, session.value);
    if (!stored.ok) return stored;
    const artifactEvent = await append(sessionId, { kind: "artifact.recorded", artifact: stored.value.artifact }, stored.value.handoff.harnessId);
    if (!artifactEvent.ok) return artifactEvent;
    const handoffEvent = await append(sessionId, { kind: "handoff.created", handoff: stored.value.handoff }, stored.value.handoff.harnessId);
    return handoffEvent.ok ? { ok: true as const, value: stored.value.handoff } : handoffEvent;
  }

  async function stopRunner(session: SessionRecord, reason: string): Promise<void> {
    const stopped = await options.runners.stop(session.header.id, reason);
    if (!stopped.ok) return;
    await append(session.header.id, {
      kind: "runner.stopped",
      harnessId: session.header.initialHarnessId,
      outcome: stopped.value.state,
    }, session.header.initialHarnessId);
  }

  async function ensureParentCompletion(session: SessionRecord): Promise<Result<void, SessionError>> {
    const parentSessionId = session.header.parentSessionId;
    if (parentSessionId === null || session.outcome === null) return { ok: true, value: undefined };
    const parentEvents = await readAllEvents(options.repository, parentSessionId);
    if (!parentEvents.ok) return parentEvents;
    const spawned = parentEvents.value.find((event) => event.payload.kind === "child.spawned"
      && event.payload.child.sessionId === session.header.id);
    if (spawned?.payload.kind !== "child.spawned") {
      return validation("Parent session has no spawn record for this child", "parentSessionId");
    }
    const alreadyCompleted = parentEvents.value.some((event) => event.payload.kind === "child.completed"
      && event.payload.child.sessionId === session.header.id);
    if (alreadyCompleted) return { ok: true, value: undefined };

    const resultArtifact = await createChildResultArtifact(options.repository, options.objects, session);
    if (!resultArtifact.ok) return resultArtifact;
    const childArtifactEvents = await readAllEvents(options.repository, session.header.id);
    if (!childArtifactEvents.ok) return childArtifactEvents;
    if (!childArtifactEvents.value.some((event) => event.payload.kind === "artifact.recorded"
      && event.payload.artifact.id === resultArtifact.value.id)) {
      const artifactEvent = await append(session.header.id, {
        kind: "artifact.recorded",
        artifact: resultArtifact.value,
      }, session.header.initialHarnessId);
      if (!artifactEvent.ok) return artifactEvent;
    }
    const child: ChildSessionRecord = {
      ...spawned.payload.child,
      state: session.state,
    };
    const completed = await append(parentSessionId, {
      kind: "child.completed",
      child,
      resultArtifactId: resultArtifact.value.id,
    }, spawned.harnessId);
    if (!completed.ok) return completed;
    const envelope: KernelToRunnerEnvelope = {
      protocol: PROTOCOL,
      version: PROTOCOL_VERSION,
      message: { kind: "kernel.event", event: { kind: "child.completed", child, resultArtifactId: resultArtifact.value.id } },
    };
    await options.runners.send(parentSessionId, envelope);
    return { ok: true, value: undefined };
  }

  async function finalize(
    session: SessionRecord,
    outcome: SessionOutcome,
    shouldStopRunner: boolean,
  ): Promise<Result<SessionRecord, SessionError>> {
    if (session.outcome !== null) {
      if (session.outcome !== outcome) {
        return conflict("session-outcome", outcome, session.outcome);
      }
      const repaired = await ensureParentCompletion(session);
      return repaired.ok ? { ok: true, value: session } : repaired;
    }
    if (shouldStopRunner) await stopRunner(session, `session ${outcome}`);
    const completed = await append(session.header.id, { kind: "session.completed", outcome }, session.header.initialHarnessId);
    if (!completed.ok) return completed;
    const current = await options.repository.get(session.header.id);
    if (!current.ok) return current;
    const parent = await ensureParentCompletion(current.value);
    return parent.ok ? current : parent;
  }

  return {
    async startTask(request) {
      if (request.objective.trim().length === 0) return validation("Task objective must not be empty", "objective");
      const project = await options.projects.getProject(request.projectId);
      if (!project.ok) return project;
      const workspace = await options.projects.getWorkspace(request.workspaceId);
      if (!workspace.ok) return workspace;
      if (workspace.value.projectId !== project.value.id) {
        return validation("Workspace does not belong to the requested project", "workspaceId");
      }
      if (project.value.activeHarnessId === null) {
        return validation("Project harness initialization must finish before a task starts", "projectId");
      }
      const harness = await options.harnesses.getActiveHarness(project.value.id);
      if (!harness.ok) return harness;
      if (harness.value.id !== project.value.activeHarnessId) {
        return conflict("active-harness", project.value.activeHarnessId, harness.value.id);
      }
      const route = await options.models.resolve(request.modelRole);
      if (!route.ok) return route;
      const createdAt = now();
      const header: SessionHeader = {
        id: `session_${randomUUID()}` as SessionId,
        threadId: `thread_${randomUUID()}` as ThreadId,
        parentSessionId: null,
        continuation: null,
        projectId: project.value.id,
        workspaceId: workspace.value.id,
        role: "main",
        objective: request.objective.trim(),
        initialHarnessId: harness.value.id,
        initialModelRoutes: [route.value],
        policyProfile: options.config.defaultPolicyProfile,
        capabilityEnvelope: { ...options.config.mainCapabilities, createdAt },
        credentialEnvNames: [...options.config.credentialEnvNames],
        eventSchemaVersion: 1,
        createdAt,
      };
      return launch(header, harness.value, workspace.value, null);
    },

    async resumeThread(request) {
      const source = await options.repository.get(request.sourceSessionId);
      if (!source.ok) return source;
      const workspace = await options.projects.getWorkspace(request.workspaceId);
      if (!workspace.ok) return workspace;
      if (workspace.value.projectId !== source.value.header.projectId) {
        return validation("Resume workspace must belong to the source project", "workspaceId");
      }
      const handoff = await loadHandoff(options.repository, options.objects, request.handoffArtifactId, request.sourceSessionId);
      if (!handoff.ok) return handoff;
      const context = await verifyArtifacts(options.repository, request.contextArtifactIds);
      if (!context.ok) return context;
      const project = await options.projects.getProject(source.value.header.projectId);
      if (!project.ok) return project;
      if (project.value.activeHarnessId === null) {
        return validation("Project has no initialized active harness", "projectId");
      }
      const harness = await options.harnesses.getActiveHarness(project.value.id);
      if (!harness.ok) return harness;
      if (harness.value.id !== project.value.activeHarnessId) {
        return conflict("active-harness", project.value.activeHarnessId, harness.value.id);
      }
      const createdAt = now();
      const header: SessionHeader = {
        ...source.value.header,
        id: `session_${randomUUID()}` as SessionId,
        parentSessionId: source.value.header.id,
        continuation: {
          sourceSessionId: source.value.header.id,
          handoffArtifactId: handoff.value.artifactId,
          contextArtifactIds: [...request.contextArtifactIds],
        },
        workspaceId: workspace.value.id,
        objective: handoff.value.objective,
        initialHarnessId: harness.value.id,
        capabilityEnvelope: { ...source.value.header.capabilityEnvelope, createdAt },
        createdAt,
      };
      return launch(header, harness.value, workspace.value, handoff.value.artifactId);
    },

    async spawnChild(request: SpawnChildRequest) {
      const parent = await options.repository.get(request.parentSessionId);
      if (!parent.ok) return parent;
      if (parent.value.outcome !== null) return conflict("parent-session", "active", parent.value.state);
      if (request.objective.trim().length === 0) return validation("Child objective must not be empty", "objective");
      if (!parent.value.header.capabilityEnvelope.grants.some((grant) => grant.kind === "spawn-child")) {
        return childDenied("Parent session is not permitted to spawn children");
      }
      const context = await verifyArtifacts(options.repository, request.contextArtifactIds);
      if (!context.ok) return context;
      const createdAt = now();
      const envelope = attenuateChildCapabilities(parent.value.header.capabilityEnvelope, request.capabilityEnvelope, createdAt);
      if (!envelope.ok) return envelope;
      const decision = await options.policy.evaluate({
        sessionId: parent.value.header.id,
        facts: { kind: "child-spawn", parentSessionId: parent.value.header.id, requestedGrants: envelope.value.grants },
        capabilityEnvelope: parent.value.header.capabilityEnvelope,
        profile: parent.value.header.policyProfile,
      });
      if (!decision.ok) return { ok: false, error: policyFailure(decision.error) };
      const decisionEvent = await append(parent.value.header.id, {
        kind: "policy.decided",
        facts: { kind: "child-spawn", parentSessionId: parent.value.header.id, requestedGrants: envelope.value.grants },
        decision: decision.value,
      }, parent.value.header.initialHarnessId);
      if (!decisionEvent.ok) return decisionEvent;
      if (decision.value.outcome === "deny") return childDenied(decision.value.reason);
      if (decision.value.outcome === "escalate") {
        const escalation = await options.policy.getEscalation(decision.value.escalationId);
        if (escalation.ok) await append(parent.value.header.id, { kind: "policy.escalated", escalation: escalation.value }, parent.value.header.initialHarnessId);
        return childDenied(decision.value.reason);
      }
      const handoff = await createHandoffFor(parent.value.header.id);
      if (!handoff.ok) return handoff;
      const harness = await options.harnesses.getHarness(parent.value.header.initialHarnessId);
      if (!harness.ok) return harness;
      const workspace = await options.projects.getWorkspace(parent.value.header.workspaceId);
      if (!workspace.ok) return workspace;
      const identity = newChildIdentity(parent.value.header.id, request);
      const header: SessionHeader = {
        id: identity.sessionId,
        threadId: parent.value.header.threadId,
        parentSessionId: parent.value.header.id,
        continuation: {
          sourceSessionId: parent.value.header.id,
          handoffArtifactId: handoff.value.artifactId,
          contextArtifactIds: [...request.contextArtifactIds],
        },
        projectId: parent.value.header.projectId,
        workspaceId: parent.value.header.workspaceId,
        role: request.role,
        objective: request.objective.trim(),
        initialHarnessId: harness.value.id,
        initialModelRoutes: [...parent.value.header.initialModelRoutes],
        policyProfile: parent.value.header.policyProfile,
        capabilityEnvelope: envelope.value,
        credentialEnvNames: childCredentialNames(parent.value.header, envelope.value),
        eventSchemaVersion: 1,
        createdAt,
      };
      const launched = await launch(header, harness.value, workspace.value, handoff.value.artifactId);
      if (!launched.ok) return launched;
      const child: ChildSessionRecord = { ...identity, state: launched.value.state };
      const spawn = await append(
        parent.value.header.id,
        { kind: "child.spawned", child },
        parent.value.header.initialHarnessId,
        child.spawnEventId,
      );
      return spawn.ok ? { ok: true, value: child } : spawn;
    },

    async complete(sessionId, outcome) {
      const session = await options.repository.get(sessionId);
      return session.ok ? finalize(session.value, outcome, true) : session;
    },

    async cancel(sessionId, reason) {
      const session = await options.repository.get(sessionId);
      if (!session.ok) return session;
      if (session.value.outcome !== null) return session;
      const active = await options.processes.listActive(sessionId);
      if (!active.ok) return active;
      const events = await readAllEvents(options.repository, sessionId);
      if (!events.ok) return events;
      const runnerProcessIds = new Set<ProcessId>();
      for (const event of events.value) if (event.payload.kind === "runner.started") runnerProcessIds.add(event.payload.processId);
      await stopRunner(session.value, reason);
      for (const handle of active.value) {
        if (runnerProcessIds.has(handle.id)) continue;
        const cancelled = await options.processes.cancel(handle.id, reason);
        if (!cancelled.ok) return cancelled;
        const event = await append(sessionId, { kind: "process.completed", completion: cancelled.value }, session.value.header.initialHarnessId);
        if (!event.ok) return event;
      }
      const current = await options.repository.get(sessionId);
      return current.ok ? finalize(current.value, "cancelled", false) : current;
    },

    createHandoff(sessionId) {
      return createHandoffFor(sessionId);
    },

    async *subscribe(sessionId, afterSequence) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) return;
      const queue = new LiveQueue();
      const listeners = subscriptions.get(sessionId) ?? new Set<LiveQueue>();
      listeners.add(queue);
      subscriptions.set(sessionId, listeners);
      let cursor = afterSequence;
      try {
        while (true) {
          const persisted = await options.repository.read(sessionId, cursor, LIVE_READ_LIMIT);
          if (!persisted.ok) return;
          for (const event of persisted.value) {
            cursor = Math.max(cursor, event.sequence);
            yield { kind: "session-event", sessionId, event };
          }
          if (persisted.value.length < LIVE_READ_LIMIT) break;
        }
        while (true) {
          const event = await queue.next();
          if (event === null) return;
          if (event.kind === "session-event" && event.event.sequence <= cursor) continue;
          if (event.kind === "session-event") cursor = event.event.sequence;
          yield event;
        }
      } finally {
        queue.close();
        listeners.delete(queue);
        if (listeners.size === 0) subscriptions.delete(sessionId);
      }
    },
  };
};

function now(): Timestamp {
  return new Date().toISOString() as Timestamp;
}

function validation(message: string, field: string): { readonly ok: false; readonly error: SessionError } {
  return { ok: false, error: { kind: "validation", message, field, recoverable: true, callerAction: "fix-request" } };
}

function conflict(resource: string, expected: string, actual: string): { readonly ok: false; readonly error: SessionError } {
  return { ok: false, error: { kind: "conflict", resource, expected, actual, recoverable: true, callerAction: "refresh-version-and-retry" } };
}

function childDenied(reason: string): { readonly ok: false; readonly error: CapabilityDeniedError } {
  return {
    ok: false,
    error: {
      kind: "capability-denied",
      capability: "spawn-child",
      reason,
      recoverable: true,
      callerAction: "request-new-child",
    },
  };
}

function runnerStartupError(error: HarnessError | ProcessError): HarnessError {
  if (error.kind === "validation" || error.kind === "capability-denied" || error.kind === "io-error") return error;
  return {
    kind: "protocol-error",
    protocol: "runner-jsonl",
    message: `Runner startup failed: ${error.kind}`,
    recoverable: false,
    callerAction: "abort",
  };
}

function policyFailure(error: ModelError): SessionError {
  if (error.kind === "validation" || error.kind === "capability-denied") return error;
  return {
    kind: "protocol-error",
    protocol: "runner-jsonl",
    message: `Child spawn policy evaluation failed: ${error.kind}`,
    recoverable: false,
    callerAction: "abort",
  };
}
