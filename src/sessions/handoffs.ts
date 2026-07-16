import { randomUUID } from "node:crypto";

import type {
  ArtifactId,
  ArtifactRecord,
  ByteCount,
  HandoffRecord,
  JsonObject,
  ObjectStore,
  ProcessId,
  ProcessState,
  Result,
  SessionError,
  SessionEvent,
  SessionId,
  SessionRecord,
  SessionRepository,
  Timestamp,
} from "../contracts/index.js";

const EVENT_PAGE_SIZE = 10_000;

export async function createStoredHandoff(
  repository: SessionRepository,
  objects: ObjectStore,
  session: SessionRecord,
): Promise<Result<{ readonly handoff: HandoffRecord; readonly artifact: ArtifactRecord }, SessionError>> {
  const eventsResult = await readAllEvents(repository, session.header.id);
  if (!eventsResult.ok) return eventsResult;
  const events = eventsResult.value;
  const artifactId = `artifact_${randomUUID()}` as ArtifactId;
  const createdAt = now();
  const processStates = collectProcessStates(events);
  const relevantArtifactIds = collectArtifactIds(events);
  const handoff: HandoffRecord = {
    artifactId,
    sourceSessionId: session.header.id,
    objective: session.header.objective,
    progress: progressSummary(session, events),
    decisions: collectDecisions(events),
    unresolvedWork: session.outcome === null ? [`Continue objective: ${session.header.objective}`] : [],
    relevantArtifactIds,
    processStates,
    observedFiles: [],
    harnessId: latestHarnessId(events, session),
    createdAt,
  };
  const stored = await objects.put("application/vnd.omega.handoff+json", bytes(JSON.stringify(handoff)));
  if (!stored.ok) return stored;
  const artifact: ArtifactRecord = {
    id: artifactId,
    kind: "handoff",
    object: stored.value,
    sessionId: session.header.id,
    createdAt,
    metadata: {
      sourceSessionId: session.header.id,
      threadId: session.header.threadId,
      eventCount: events.length,
      harnessId: handoff.harnessId,
    },
  };
  const recorded = await repository.recordArtifact(artifact);
  return recorded.ok ? { ok: true, value: { handoff, artifact: recorded.value } } : recorded;
}

export async function loadHandoff(
  repository: SessionRepository,
  objects: ObjectStore,
  artifactId: ArtifactId,
  sourceSessionId: SessionId,
): Promise<Result<HandoffRecord, SessionError>> {
  const slice = await repository.readArtifact(artifactId, 0 as ByteCount, 1 as ByteCount);
  if (!slice.ok) return slice;
  if (slice.value.artifact.kind !== "handoff" || slice.value.artifact.sessionId !== sourceSessionId) {
    return validation("The continuation artifact is not a handoff owned by the source session", "handoffArtifactId");
  }
  const object = await objects.get(slice.value.artifact.object.hash);
  if (!object.ok) return object;
  let encoded = "";
  for await (const chunk of object.value) encoded += Buffer.from(chunk).toString("utf8");
  const parsed = parseHandoff(encoded);
  if (!parsed.ok) return parsed;
  if (parsed.value.artifactId !== artifactId || parsed.value.sourceSessionId !== sourceSessionId) {
    return validation("The handoff contents do not match the requested continuation", "handoffArtifactId");
  }
  return parsed;
}

export async function verifyArtifacts(
  repository: SessionRepository,
  artifactIds: readonly ArtifactId[],
): Promise<Result<void, SessionError>> {
  for (const artifactId of new Set(artifactIds)) {
    const artifact = await repository.readArtifact(artifactId, 0 as ByteCount, 1 as ByteCount);
    if (!artifact.ok) return artifact;
  }
  return { ok: true, value: undefined };
}

export async function createChildResultArtifact(
  repository: SessionRepository,
  objects: ObjectStore,
  session: SessionRecord,
): Promise<Result<ArtifactRecord, SessionError>> {
  const events = await readAllEvents(repository, session.header.id);
  if (!events.ok) return events;
  const existing = events.value.find((event) => event.payload.kind === "artifact.recorded"
    && event.payload.artifact.metadata["purpose"] === "child-result");
  if (existing?.payload.kind === "artifact.recorded") return { ok: true, value: existing.payload.artifact };

  const payload: JsonObject = {
    sessionId: session.header.id,
    objective: session.header.objective,
    state: session.state,
    outcome: session.outcome,
    lastSequence: session.lastSequence,
  };
  const stored = await objects.put("application/vnd.omega.child-result+json", bytes(JSON.stringify(payload)));
  if (!stored.ok) return stored;
  const artifact: ArtifactRecord = {
    id: `artifact_${randomUUID()}` as ArtifactId,
    kind: "diagnostic",
    object: stored.value,
    sessionId: session.header.id,
    createdAt: now(),
    metadata: { purpose: "child-result", parentSessionId: session.header.parentSessionId },
  };
  return repository.recordArtifact(artifact);
}

export async function readAllEvents(
  repository: SessionRepository,
  sessionId: SessionId,
): Promise<Result<readonly SessionEvent[], SessionError>> {
  const events: SessionEvent[] = [];
  let after = 0;
  while (true) {
    const page = await repository.read(sessionId, after, EVENT_PAGE_SIZE);
    if (!page.ok) return page;
    events.push(...page.value);
    if (page.value.length < EVENT_PAGE_SIZE) return { ok: true, value: events };
    const last = page.value.at(-1);
    if (last === undefined || last.sequence <= after) {
      return validation("Session event pagination did not advance", "sequence");
    }
    after = last.sequence;
  }
}

function collectArtifactIds(events: readonly SessionEvent[]): readonly ArtifactId[] {
  const ids = new Set<ArtifactId>();
  for (const event of events) {
    const payload = event.payload;
    if (payload.kind === "artifact.recorded") ids.add(payload.artifact.id);
    if (payload.kind === "model.completed") ids.add(payload.aggregateArtifactId);
    if (payload.kind === "model.failed" && payload.partialArtifactId !== null) ids.add(payload.partialArtifactId);
    if (payload.kind === "child.completed") ids.add(payload.resultArtifactId);
  }
  return [...ids];
}

function collectProcessStates(events: readonly SessionEvent[]): readonly { readonly processId: ProcessId; readonly state: ProcessState }[] {
  const states = new Map<ProcessId, ProcessState>();
  for (const event of events) {
    if (event.payload.kind === "process.started") states.set(event.payload.handle.id, event.payload.handle.state);
    if (event.payload.kind === "process.completed") states.set(event.payload.completion.processId, event.payload.completion.state);
    if (event.payload.kind === "runner.started") states.set(event.payload.processId, "running");
    if (event.payload.kind === "runner.stopped") {
      const runner = [...states.keys()].find((processId) => states.get(processId) === "running");
      if (runner !== undefined) states.set(runner, event.payload.outcome);
    }
  }
  return [...states].map(([processId, state]) => ({ processId, state }));
}

function collectDecisions(events: readonly SessionEvent[]): readonly string[] {
  const decisions: string[] = [];
  for (const event of events) {
    if (event.payload.kind === "policy.decided") decisions.push(`${event.payload.decision.outcome}: ${event.payload.decision.reason}`);
    if (event.payload.kind === "harness.updated") decisions.push(`Harness ${event.payload.update.reason}: ${event.payload.update.activeHarnessId}`);
  }
  return decisions;
}

function latestHarnessId(events: readonly SessionEvent[], session: SessionRecord): SessionRecord["header"]["initialHarnessId"] {
  let harnessId = session.header.initialHarnessId;
  for (const event of events) if (event.payload.kind === "harness.updated") harnessId = event.payload.update.activeHarnessId;
  return harnessId;
}

function progressSummary(session: SessionRecord, events: readonly SessionEvent[]): string {
  const completedModels = events.filter((event) => event.payload.kind === "model.completed").length;
  const completedProcesses = events.filter((event) => event.payload.kind === "process.completed").length;
  return `${events.length} semantic events recorded; ${completedModels} model completions; ${completedProcesses} process completions; session state ${session.state}.`;
}

function parseHandoff(encoded: string): Result<HandoffRecord, SessionError> {
  try {
    const value: unknown = JSON.parse(encoded);
    if (!isRecord(value) || typeof value["artifactId"] !== "string" || typeof value["sourceSessionId"] !== "string"
      || typeof value["objective"] !== "string" || typeof value["progress"] !== "string" || !Array.isArray(value["decisions"])
      || !Array.isArray(value["unresolvedWork"]) || !Array.isArray(value["relevantArtifactIds"]) || !Array.isArray(value["processStates"])
      || !Array.isArray(value["observedFiles"]) || typeof value["harnessId"] !== "string" || typeof value["createdAt"] !== "string") {
      return validation("The handoff artifact is malformed", "handoffArtifactId");
    }
    return { ok: true, value: value as HandoffRecord };
  } catch {
    return validation("The handoff artifact is not valid JSON", "handoffArtifactId");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytes(value: string): AsyncIterable<Uint8Array> {
  return (async function* encoded(): AsyncIterable<Uint8Array> { yield Buffer.from(value, "utf8"); })();
}

function now(): Timestamp {
  return new Date().toISOString() as Timestamp;
}

function validation(message: string, field: string): { readonly ok: false; readonly error: SessionError } {
  return { ok: false, error: { kind: "validation", message, field, recoverable: true, callerAction: "fix-request" } };
}
