import { createHash, randomUUID } from "node:crypto";

import type {
  CapabilityEnvelope,
  CreateEvolutionService,
  EvolutionError,
  EvolutionJob,
  EvolutionJobId,
  EvolutionRequest,
  EvolutionService,
  HarnessId,
  HarnessManifest,
  Page,
  PageRequest,
  Result,
  ProcessError,
  SessionError,
  Timestamp,
} from "../contracts/index.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";

function now(): Timestamp {
  return new Date().toISOString() as Timestamp;
}

function validation(message: string, field: string | null): EvolutionError {
  return { kind: "validation", message, field, recoverable: true, callerAction: "fix-request" };
}

function notFound(id: EvolutionJobId): EvolutionError {
  return { kind: "not-found", resource: "evolution-job", id, recoverable: false, callerAction: "propagate" };
}

function capabilityDenied(): EvolutionError {
  return {
    kind: "capability-denied",
    capability: "create-harness-candidate",
    reason: "The evolution child lacks candidate-creation authority.",
    recoverable: true,
    callerAction: "request-new-child",
  };
}

function cancellationError(error: SessionError | ProcessError): EvolutionError {
  switch (error.kind) {
    case "policy-denied":
    case "process-not-running":
    case "process-interrupted":
    case "unsupported":
      return validation(`Evolution child cancellation failed: ${error.kind}.`, "jobId");
    default:
      return error;
  }
}

function candidateId(incumbent: HarnessManifest, request: EvolutionRequest): HarnessId {
  const content = JSON.stringify({
    parent: incumbent.id,
    goal: request.goal,
    evidence: [...request.evidenceArtifactIds].sort(),
    componentKinds: [...request.allowedComponentKinds].sort(),
  });
  return createHash("sha256").update(content).digest("hex") as HarnessId;
}

function pageFrom(items: readonly EvolutionJob[], page: PageRequest): Result<Page<EvolutionJob>, EvolutionError> {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 1_000) {
    return { ok: false, error: validation("Page limit must be an integer between 1 and 1000.", "page.limit") };
  }
  const offset = page.cursor === null ? 0 : Number(page.cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return { ok: false, error: validation("Page cursor is invalid.", "page.cursor") };
  }
  const selected = items.slice(offset, offset + page.limit);
  const nextOffset = offset + selected.length;
  return { ok: true, value: { items: selected, nextCursor: nextOffset < items.length ? String(nextOffset) : null } };
}

export const createEvolutionService: CreateEvolutionService = (options): EvolutionService => {
  const jobs = new Map<EvolutionJobId, EvolutionJob>();

  function update(job: EvolutionJob, patch: Partial<Pick<EvolutionJob, "candidateHarnessId" | "scorecardId" | "state">>): EvolutionJob {
    const updated: EvolutionJob = { ...job, ...patch, updatedAt: now() };
    jobs.set(updated.id, updated);
    return updated;
  }

  function isCancelled(id: EvolutionJobId): boolean {
    return jobs.get(id)?.state === "cancelled";
  }

  async function finishFailed(id: EvolutionJobId): Promise<void> {
    const job = jobs.get(id);
    if (job === undefined || job.state === "cancelled") return;
    update(job, { state: "failed" });
    await options.sessions.complete(job.sessionId, "failed");
  }

  async function execute(id: EvolutionJobId): Promise<void> {
    const queued = jobs.get(id);
    if (queued === undefined || queued.state === "cancelled") return;
    const diagnosing = update(queued, { state: "diagnosing" });
    const incumbent = await options.harnesses.getHarness(diagnosing.incumbentHarnessId);
    if (!incumbent.ok) {
      await finishFailed(id);
      return;
    }
    if (isCancelled(id)) return;

    const mutating = update(jobs.get(id) ?? diagnosing, { state: "mutating" });
    const idForCandidate = candidateId(incumbent.value, mutating.request);
    const candidate: HarnessManifest = {
      id: idForCandidate,
      projectId: incumbent.value.projectId,
      alias: `candidate-${idForCandidate.slice(0, 12)}`,
      parents: [incumbent.value.id],
      components: incumbent.value.components,
      sourceArtifacts: [...new Set([...incumbent.value.sourceArtifacts, ...mutating.request.evidenceArtifactIds])],
      createdAt: now(),
    };
    const stored = await options.harnesses.putHarness(candidate);
    if (!stored.ok) {
      await finishFailed(id);
      return;
    }
    if (isCancelled(id)) return;

    const evaluating = update(jobs.get(id) ?? mutating, {
      state: "evaluating",
      candidateHarnessId: stored.value.id,
    });
    const scorecard = await options.benchmarks.runPaired(
      DEFAULT_CONFIG.benchmarks.developmentSuiteId,
      evaluating.incumbentHarnessId,
      stored.value.id,
    );
    if (!scorecard.ok) {
      await finishFailed(id);
      return;
    }
    if (isCancelled(id)) return;

    const terminalState = scorecard.value.decision.outcome === "promote" ? "promoted" : "rejected";
    update(jobs.get(id) ?? evaluating, { state: terminalState, scorecardId: scorecard.value.id });
    await options.sessions.complete(evaluating.sessionId, "succeeded");
  }

  async function start(
    request: EvolutionRequest,
    capabilities: CapabilityEnvelope,
  ): Promise<Result<EvolutionJob, EvolutionError>> {
    if (request.goal.trim().length === 0) return { ok: false, error: validation("Evolution goal cannot be empty.", "goal") };
    if (request.allowedComponentKinds.length === 0) {
      return { ok: false, error: validation("At least one mutable component kind is required.", "allowedComponentKinds") };
    }
    if (!capabilities.grants.some((grant) => grant.kind === "create-harness-candidate")) {
      return { ok: false, error: capabilityDenied() };
    }

    const incumbent = await options.harnesses.getActiveHarness(request.projectId);
    if (!incumbent.ok) return incumbent;
    const child = await options.sessions.spawnChild({
      parentSessionId: request.sourceSessionId,
      role: "evolution",
      objective: request.goal,
      contextArtifactIds: request.evidenceArtifactIds,
      capabilityEnvelope: capabilities,
    });
    if (!child.ok) return child;

    const createdAt = now();
    const job: EvolutionJob = {
      id: randomUUID() as EvolutionJobId,
      request,
      incumbentHarnessId: incumbent.value.id,
      sessionId: child.value.sessionId,
      childId: child.value.childId,
      candidateHarnessId: null,
      scorecardId: null,
      state: "queued",
      createdAt,
      updatedAt: createdAt,
    };
    jobs.set(job.id, job);
    queueMicrotask(() => { void execute(job.id); });
    return { ok: true, value: job };
  }

  async function get(id: EvolutionJobId): Promise<Result<EvolutionJob, EvolutionError>> {
    const job = jobs.get(id);
    return job === undefined ? { ok: false, error: notFound(id) } : { ok: true, value: job };
  }

  async function list(projectId: EvolutionRequest["projectId"], page: PageRequest): Promise<Result<Page<EvolutionJob>, EvolutionError>> {
    const matches = [...jobs.values()]
      .filter((job) => job.request.projectId === projectId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return pageFrom(matches, page);
  }

  async function cancel(id: EvolutionJobId, reason: string): Promise<Result<EvolutionJob, EvolutionError>> {
    const job = jobs.get(id);
    if (job === undefined) return { ok: false, error: notFound(id) };
    if (["promoted", "rejected", "cancelled", "failed"].includes(job.state)) return { ok: true, value: job };
    const cancelled = update(job, { state: "cancelled" });
    const session = await options.sessions.cancel(job.sessionId, reason);
    if (session.ok) return { ok: true, value: cancelled };
    return { ok: false, error: cancellationError(session.error) };
  }

  return { start, get, list, cancel };
};
