import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  ArtifactId,
  CapabilityEnvelope,
  ComponentId,
  ComponentKind,
  ComponentManifest,
  ComponentRuntime,
  CreateEvolutionService,
  EvolutionError,
  EvolutionJob,
  EvolutionJobId,
  EvolutionRequest,
  EvolutionService,
  HarnessId,
  HarnessManifest,
  JsonObject,
  JsonValue,
  Page,
  PageRequest,
  ProcessError,
  Result,
  SessionError,
  SessionRecord,
  Timestamp,
} from "../contracts/index.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { atomicWriteFile, ioError, safeStorageKey } from "../persistence/artifact-store.js";
import { readAllEvents } from "../sessions/handoffs.js";

const COMPONENT_KINDS: ReadonlySet<string> = new Set([
  "runner", "tool", "connector", "skill", "workflow", "context-compiler", "promotion-evaluator", "policy-prompt",
]);
const COMPONENT_RUNTIMES: ReadonlySet<string> = new Set(["node", "python", "bash", "native", "document"]);
const TERMINAL_STATES: ReadonlySet<EvolutionJob["state"]> = new Set(["promoted", "rejected", "cancelled", "failed"]);
const SINGLETON_COMPONENT_KINDS: ReadonlySet<ComponentKind> = new Set([
  "runner", "context-compiler", "promotion-evaluator", "policy-prompt",
]);

type ComponentDelta = {
  readonly kind: ComponentKind;
  readonly runtime: ComponentRuntime;
  readonly entrypoint: string;
  readonly content: string;
  readonly replaceComponentId: ComponentId | null;
};

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

function evolutionObjective(request: EvolutionRequest): string {
  return [
    request.goal,
    "Return the proposed harness mutation as the entire final response in this JSON shape:",
    '{"kind":"skill","runtime":"document","entrypoint":"SKILL.md","content":"...","replaceComponentId":null}',
    `Allowed component kinds: ${request.allowedComponentKinds.join(", ")}.`,
    "Use replaceComponentId to replace an existing component; omit it or use null to add a non-singleton component.",
    "The content must be complete executable or document content, not a description of the change.",
  ].join("\n\n");
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as JsonObject;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key] ?? null)}`).join(",")}}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function componentBody(component: Omit<ComponentManifest, "id">): JsonObject {
  return {
    kind: component.kind,
    runtime: component.runtime,
    objectHash: component.objectHash,
    entrypoint: component.entrypoint,
    credentialEnvNames: [...component.credentialEnvNames],
    capabilities: [...component.capabilities],
  };
}

function harnessBody(manifest: Omit<HarnessManifest, "id">): JsonObject {
  return {
    projectId: manifest.projectId,
    alias: manifest.alias,
    parents: [...manifest.parents],
    components: manifest.components.map((component) => ({ id: component.id, ...componentBody(component) })),
    sourceArtifacts: [...manifest.sourceArtifacts],
    createdAt: manifest.createdAt,
  };
}

function mediaType(runtime: ComponentRuntime): string {
  switch (runtime) {
    case "node": return "text/javascript";
    case "python": return "text/x-python";
    case "bash": return "text/x-shellscript";
    case "document": return "text/markdown";
    case "native": return "application/octet-stream";
  }
}

function isSafeEntrypoint(entrypoint: string): boolean {
  if (entrypoint.trim() !== entrypoint || entrypoint.length === 0 || entrypoint.startsWith("/") || entrypoint.includes("\\")) {
    return false;
  }
  return entrypoint.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function parseDelta(text: string, allowedKinds: readonly ComponentKind[]): Result<ComponentDelta, EvolutionError> {
  let source = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(source);
  if (fenced?.[1] !== undefined) source = fenced[1].trim();
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { ok: false, error: validation("Evolution child output must be one JSON component delta.", "childOutput") };
  }
  if (!isRecord(value) || typeof value["kind"] !== "string" || typeof value["runtime"] !== "string"
    || typeof value["entrypoint"] !== "string" || typeof value["content"] !== "string"
    || (value["replaceComponentId"] !== undefined && value["replaceComponentId"] !== null
      && typeof value["replaceComponentId"] !== "string")) {
    return { ok: false, error: validation("Evolution child output has an invalid component delta shape.", "childOutput") };
  }
  if (!COMPONENT_KINDS.has(value["kind"]) || !allowedKinds.includes(value["kind"] as ComponentKind)) {
    return { ok: false, error: validation("Evolution child selected a component kind outside its mutation envelope.", "childOutput.kind") };
  }
  if (!COMPONENT_RUNTIMES.has(value["runtime"])) {
    return { ok: false, error: validation("Evolution child selected an unsupported component runtime.", "childOutput.runtime") };
  }
  if (!isSafeEntrypoint(value["entrypoint"])) {
    return { ok: false, error: validation("Evolution component entrypoint must be a normalized relative path.", "childOutput.entrypoint") };
  }
  if (value["content"].trim().length === 0) {
    return { ok: false, error: validation("Evolution component content cannot be empty.", "childOutput.content") };
  }
  return {
    ok: true,
    value: {
      kind: value["kind"] as ComponentKind,
      runtime: value["runtime"] as ComponentRuntime,
      entrypoint: value["entrypoint"],
      content: value["content"],
      replaceComponentId: (value["replaceComponentId"] ?? null) as ComponentId | null,
    },
  };
}

export const createEvolutionService: CreateEvolutionService = (options): EvolutionService => {
  const jobs = new Map<EvolutionJobId, EvolutionJob>();
  const controls = new Map<EvolutionJobId, { readonly controller: AbortController; readonly completion: Promise<void> }>();
  const writes = new Map<EvolutionJobId, Promise<void>>();
  const loaded = loadPersistedJobs(String(options.root), jobs);

  async function ensureLoaded(): Promise<Result<void, EvolutionError>> {
    try {
      await loaded;
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: ioError("load-evolution-jobs", error) };
    }
  }

  async function store(job: EvolutionJob): Promise<Result<EvolutionJob, EvolutionError>> {
    const previous = writes.get(job.id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      await persistJob(String(options.root), job);
      jobs.set(job.id, job);
    });
    writes.set(job.id, current);
    try {
      await current;
      return { ok: true, value: job };
    } catch (error) {
      return { ok: false, error: ioError("persist-evolution-job", error) };
    } finally {
      if (writes.get(job.id) === current) writes.delete(job.id);
    }
  }

  async function update(
    job: EvolutionJob,
    patch: Partial<Pick<EvolutionJob, "candidateHarnessId" | "scorecardId" | "state">>,
  ): Promise<Result<EvolutionJob, EvolutionError>> {
    return store({ ...job, ...patch, updatedAt: now() });
  }

  function isCancelled(id: EvolutionJobId): boolean {
    return jobs.get(id)?.state === "cancelled";
  }

  async function finishFailed(id: EvolutionJobId): Promise<void> {
    const job = jobs.get(id);
    if (job === undefined || job.state === "cancelled") return;
    await update(job, { state: "failed" });
    await options.sessions.complete(job.sessionId, "failed");
  }

  async function waitForChild(job: EvolutionJob, signal: AbortSignal): Promise<Result<SessionRecord, EvolutionError>> {
    const deadline = Date.now() + Number(job.request.budget.wallTimeMs);
    while (!signal.aborted) {
      const child = await options.repository.get(job.sessionId);
      if (!child.ok) return child;
      if (child.value.outcome !== null) {
        return child.value.outcome === "succeeded"
          ? { ok: true, value: child.value }
          : { ok: false, error: validation(`Evolution child ended with ${child.value.outcome}.`, "childSession") };
      }
      if (Date.now() >= deadline) {
        return { ok: false, error: validation("Evolution child exceeded its wall-time budget.", "budget.wallTimeMs") };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
    return { ok: false, error: validation("Evolution was cancelled.", "signal") };
  }

  async function childDelta(job: EvolutionJob): Promise<Result<{ readonly delta: ComponentDelta; readonly artifactId: ArtifactId }, EvolutionError>> {
    const events = await readAllEvents(options.repository, job.sessionId);
    if (!events.ok) return events;
    for (let index = events.value.length - 1; index >= 0; index -= 1) {
      const event = events.value[index];
      if (event?.payload.kind !== "model.completed") continue;
      const payload = event.payload;
      const artifact = events.value.find((candidate) => candidate.payload.kind === "artifact.recorded"
        && candidate.payload.artifact.id === payload.aggregateArtifactId
        && candidate.payload.artifact.kind === "model-response");
      if (artifact === undefined) continue;
      const text = payload.completion.content
        .filter((part) => part.kind === "text")
        .map((part) => part.text)
        .join("");
      const parsed = parseDelta(text, job.request.allowedComponentKinds);
      return parsed.ok ? { ok: true, value: { delta: parsed.value, artifactId: payload.aggregateArtifactId } } : parsed;
    }
    return { ok: false, error: validation("Evolution child produced no recorded model-response component delta.", "childOutput") };
  }

  async function mutate(
    incumbent: HarnessManifest,
    job: EvolutionJob,
  ): Promise<Result<HarnessManifest, EvolutionError>> {
    const proposed = await childDelta(job);
    if (!proposed.ok) return proposed;
    const delta = proposed.value.delta;
    let replaceIndex = delta.replaceComponentId === null
      ? -1
      : incumbent.components.findIndex((component) => component.id === delta.replaceComponentId);
    if (delta.replaceComponentId !== null && replaceIndex < 0) {
      return { ok: false, error: validation("Evolution replacement component does not exist in the incumbent.", "childOutput.replaceComponentId") };
    }
    if (replaceIndex < 0 && SINGLETON_COMPONENT_KINDS.has(delta.kind)) {
      replaceIndex = incumbent.components.findIndex((component) => component.kind === delta.kind);
    }
    const replaced = replaceIndex < 0 ? null : incumbent.components[replaceIndex] ?? null;
    if (replaced !== null && replaced.kind !== delta.kind) {
      return { ok: false, error: validation("Evolution replacement must preserve the component kind.", "childOutput.replaceComponentId") };
    }

    const bytes = Buffer.from(delta.content, "utf8");
    const object = await options.objects.put(mediaType(delta.runtime), (async function* (): AsyncIterable<Uint8Array> {
      yield bytes;
    })());
    if (!object.ok) return object;
    const body: Omit<ComponentManifest, "id"> = {
      kind: delta.kind,
      runtime: delta.runtime,
      objectHash: object.value.hash,
      entrypoint: delta.entrypoint,
      credentialEnvNames: replaced?.credentialEnvNames ?? [],
      capabilities: replaced?.capabilities ?? [],
    };
    const component: ComponentManifest = {
      id: `component_${hash(canonical(componentBody(body)))}` as ComponentId,
      ...body,
    };
    if (replaced !== null && component.id === replaced.id) {
      return { ok: false, error: validation("Evolution child proposed an unchanged component.", "childOutput") };
    }
    if (incumbent.components.some((candidate) => candidate.id === component.id)) {
      return { ok: false, error: validation("Evolution child proposed a component already present in the incumbent.", "childOutput") };
    }
    const storedComponent = await options.harnesses.putComponent(component);
    if (!storedComponent.ok) return storedComponent;
    const components = [...incumbent.components];
    if (replaceIndex < 0) components.push(storedComponent.value);
    else components.splice(replaceIndex, 1, storedComponent.value);
    if (components.map((item) => item.id).join("\n") === incumbent.components.map((item) => item.id).join("\n")) {
      return { ok: false, error: validation("Evolution mutation did not change the harness component set.", "childOutput") };
    }

    const createdAt = now();
    const candidateBody: Omit<HarnessManifest, "id"> = {
      projectId: incumbent.projectId,
      alias: `candidate-${String(job.id).slice(0, 12)}`,
      parents: [incumbent.id],
      components,
      sourceArtifacts: [...new Set([
        ...incumbent.sourceArtifacts,
        ...job.request.evidenceArtifactIds,
        proposed.value.artifactId,
      ])],
      createdAt,
    };
    const candidate: HarnessManifest = {
      id: `harness_${hash(canonical(harnessBody(candidateBody)))}` as HarnessId,
      ...candidateBody,
    };
    return options.harnesses.putHarness(candidate);
  }

  async function execute(id: EvolutionJobId, signal: AbortSignal): Promise<void> {
    const queued = jobs.get(id);
    if (queued === undefined || queued.state === "cancelled") return;
    const diagnosingResult = await update(queued, { state: "diagnosing" });
    if (!diagnosingResult.ok) return;
    const diagnosing = diagnosingResult.value;
    if (signal.aborted || isCancelled(id)) return;
    const incumbent = await options.harnesses.getHarness(diagnosing.incumbentHarnessId);
    if (!incumbent.ok) {
      await finishFailed(id);
      return;
    }
    const child = await waitForChild(diagnosing, signal);
    if (!child.ok || isCancelled(id)) {
      if (!isCancelled(id)) await finishFailed(id);
      return;
    }

    const mutatingResult = await update(jobs.get(id) ?? diagnosing, { state: "mutating" });
    if (!mutatingResult.ok) return;
    const mutated = await mutate(incumbent.value, mutatingResult.value);
    if (!mutated.ok) {
      await finishFailed(id);
      return;
    }
    if (isCancelled(id)) return;

    const evaluatingResult = await update(jobs.get(id) ?? mutatingResult.value, {
      state: "evaluating",
      candidateHarnessId: mutated.value.id,
    });
    if (!evaluatingResult.ok) return;
    const evaluating = evaluatingResult.value;
    const scorecard = await options.benchmarks.runPaired(
      DEFAULT_CONFIG.benchmarks.developmentSuiteId,
      evaluating.incumbentHarnessId,
      mutated.value.id,
      signal,
    );
    if (!scorecard.ok) {
      if (!isCancelled(id)) await finishFailed(id);
      return;
    }
    if (isCancelled(id)) return;

    const terminalState = scorecard.value.decision.outcome === "promote" ? "promoted" : "rejected";
    await update(jobs.get(id) ?? evaluating, { state: terminalState, scorecardId: scorecard.value.id });
  }

  async function start(
    request: EvolutionRequest,
    capabilities: CapabilityEnvelope,
  ): Promise<Result<EvolutionJob, EvolutionError>> {
    const ready = await ensureLoaded();
    if (!ready.ok) return ready;
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
      objective: evolutionObjective(request),
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
    const persisted = await store(job);
    if (!persisted.ok) return persisted;
    const controller = new AbortController();
    const finished = Promise.withResolvers<void>();
    controls.set(job.id, { controller, completion: finished.promise });
    queueMicrotask(() => {
      void execute(job.id, controller.signal).finally(() => {
        finished.resolve();
        controls.delete(job.id);
      });
    });
    return { ok: true, value: job };
  }

  async function get(id: EvolutionJobId): Promise<Result<EvolutionJob, EvolutionError>> {
    const ready = await ensureLoaded();
    if (!ready.ok) return ready;
    const job = jobs.get(id);
    return job === undefined ? { ok: false, error: notFound(id) } : { ok: true, value: job };
  }

  async function list(projectId: EvolutionRequest["projectId"], page: PageRequest): Promise<Result<Page<EvolutionJob>, EvolutionError>> {
    const ready = await ensureLoaded();
    if (!ready.ok) return ready;
    const matches = [...jobs.values()]
      .filter((job) => job.request.projectId === projectId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return pageFrom(matches, page);
  }

  async function cancel(id: EvolutionJobId, reason: string): Promise<Result<EvolutionJob, EvolutionError>> {
    const ready = await ensureLoaded();
    if (!ready.ok) return ready;
    const job = jobs.get(id);
    if (job === undefined) return { ok: false, error: notFound(id) };
    if (TERMINAL_STATES.has(job.state)) return { ok: true, value: job };
    const control = controls.get(id);
    control?.controller.abort(reason);
    const cancelledResult = await update(job, { state: "cancelled" });
    if (!cancelledResult.ok) return cancelledResult;
    const sessionCancellation = options.sessions.cancel(job.sessionId, reason);
    if (control !== undefined) {
      await Promise.race([
        control.completion,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    const session = await sessionCancellation;
    if (session.ok) return cancelledResult;
    return { ok: false, error: cancellationError(session.error) };
  }

  return { start, get, list, cancel };
};

async function persistJob(root: string, job: EvolutionJob): Promise<void> {
  const path = join(root, "evolution", "jobs", `${safeStorageKey(job.id)}.json`);
  await atomicWriteFile(path, `${JSON.stringify(job)}\n`);
}

async function loadPersistedJobs(root: string, jobs: Map<EvolutionJobId, EvolutionJob>): Promise<void> {
  const directory = join(root, "evolution", "jobs");
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json"))) {
    const value: unknown = JSON.parse(await readFile(join(directory, entry.name), "utf8"));
    if (!isEvolutionJob(value)) throw new Error(`Stored evolution job ${entry.name} is malformed`);
    if (TERMINAL_STATES.has(value.state)) {
      jobs.set(value.id, value);
      continue;
    }
    const failed: EvolutionJob = { ...value, state: "failed", updatedAt: now() };
    jobs.set(failed.id, failed);
    await persistJob(root, failed);
  }
}

function isEvolutionJob(value: unknown): value is EvolutionJob {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["incumbentHarnessId"] !== "string"
    || typeof value["sessionId"] !== "string" || typeof value["childId"] !== "string"
    || (value["candidateHarnessId"] !== null && typeof value["candidateHarnessId"] !== "string")
    || (value["scorecardId"] !== null && typeof value["scorecardId"] !== "string")
    || typeof value["state"] !== "string" || !TERMINAL_STATES.has(value["state"] as EvolutionJob["state"])
      && !["queued", "diagnosing", "mutating", "evaluating"].includes(value["state"])
    || typeof value["createdAt"] !== "string" || typeof value["updatedAt"] !== "string" || !isRecord(value["request"])) {
    return false;
  }
  const request = value["request"];
  return typeof request["projectId"] === "string" && typeof request["sourceSessionId"] === "string"
    && typeof request["goal"] === "string" && Array.isArray(request["evidenceArtifactIds"])
    && request["evidenceArtifactIds"].every((item) => typeof item === "string")
    && Array.isArray(request["allowedComponentKinds"])
    && request["allowedComponentKinds"].every((item) => typeof item === "string" && COMPONENT_KINDS.has(item))
    && isRecord(request["budget"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
