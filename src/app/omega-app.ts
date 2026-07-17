import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import type {
  AbsolutePath,
  ApiError,
  ArtifactId,
  ArtifactRecord,
  BenchmarkMetrics,
  BenchmarkExecutionRequest,
  BenchmarkRunLauncher,
  CapabilityEnvelope,
  ClientRequest,
  ClientResponse,
  ClientResponseValue,
  ComponentId,
  CreateOmegaApplication,
  DurationMs,
  EvolutionError,
  HarnessError,
  HarnessManifest,
  HarnessRepository,
  ModelRouteSignature,
  ObjectStore,
  ProjectRepository,
  ProjectRecord,
  SessionRepository,
  SessionEvent,
  SessionService,
  TokenCount,
  UsdMicros,
  InternalError,
  JsonValue,
  OmegaApplication,
  OmegaContext,
  OmegaError,
  Result,
  Timestamp,
  ValidationError,
} from "../contracts/index.js";
import { createBenchmarkService } from "../evolution/benchmark-service.js";
import { createEvolutionService } from "../evolution/evolution-service.js";
import { createHarnessActivationService } from "../harness/activation-service.js";
import { createHarnessRepository } from "../harness/harness-repository.js";
import { createInitialHarness } from "../harness/initial-harness.js";
import { createRunnerHost } from "../harness/runner-host.js";
import { createKnowledgeService } from "../knowledge/knowledge-service.js";
import { createMarketplaceService } from "../knowledge/marketplace-service.js";
import { createModelRouter } from "../models/model-router.js";
import { createFileObjectStore } from "../persistence/object-store.js";
import { createFileProjectRepository } from "../persistence/project-repository.js";
import { createFileSessionRepository } from "../persistence/session-repository.js";
import { createExecutionPolicy } from "../policy/policy-engine.js";
import { createProcessRuntime } from "../process/process-supervisor.js";
import { createSessionService } from "../sessions/session-service.js";
import { createCoordinatedActivationService, recoverPersistedSessions } from "./lifecycle.js";
import { createRunnerProtocolDispatcher } from "./runner-protocol.js";

const encoder = new TextEncoder();

function timestamp(): Timestamp {
  return new Date().toISOString() as Timestamp;
}

function applicationCapabilities(context: OmegaContext): CapabilityEnvelope {
  return { ...context.config.sessions.mainCapabilities, createdAt: timestamp() };
}

function isApiError(error: OmegaError): error is ApiError {
  switch (error.kind) {
    case "unauthorized":
    case "validation":
    case "not-found":
    case "conflict":
    case "capability-denied":
    case "policy-denied":
    case "harness-version-mismatch":
    case "provider-rate-limited":
    case "provider-unavailable":
    case "budget-exceeded":
    case "unsupported":
    case "internal":
      return true;
    case "stale-read":
    case "process-not-running":
    case "process-interrupted":
    case "integrity-failure":
    case "protocol-error":
    case "io-error":
      return false;
  }
}

async function diagnosticError(context: OmegaContext, detail: JsonValue): Promise<InternalError> {
  const recorded = await recordDiagnostic(context, {
    boundary: "application",
    message: JSON.stringify(detail),
    stack: null,
    at: timestamp(),
  });
  if (!recorded.ok) throw new Error(`Diagnostic persistence failed: ${recorded.error.operation}`);
  return {
    kind: "internal",
    message: "An internal Omega error occurred",
    diagnosticArtifactId: recorded.value,
    recoverable: false,
    callerAction: "propagate",
  };
}

async function recordDiagnostic(
  context: OmegaContext,
  input: Parameters<OmegaApplication["recordDiagnostic"]>[0],
): ReturnType<OmegaApplication["recordDiagnostic"]> {
  const encoded = encoder.encode(`${JSON.stringify(input)}\n`);
  const stored = await context.objects.put("application/vnd.omega.diagnostic+json", (async function* (): AsyncIterable<Uint8Array> {
    yield encoded;
  })());
  if (!stored.ok) {
    return {
      ok: false,
      error: {
        kind: "io-error",
        operation: "record-diagnostic",
        code: stored.error.kind === "io-error" ? stored.error.code : null,
        recoverable: stored.error.kind === "io-error" && stored.error.recoverable,
        callerAction: stored.error.kind === "io-error" && stored.error.recoverable ? "retry-with-backoff" : "propagate",
      },
    };
  }
  return { ok: true, value: `diagnostic_${stored.value.hash}` as ArtifactId };
}

async function apiError(context: OmegaContext, error: OmegaError): Promise<ApiError> {
  if (isApiError(error)) return error;
  return diagnosticError(context, { boundary: "application", error: error as JsonValue });
}

async function response<T>(
  context: OmegaContext,
  request: ClientRequest,
  result: Result<T, OmegaError>,
  value: (item: T) => ClientResponseValue,
): Promise<ClientResponse> {
  return result.ok
    ? { requestId: request.requestId, result: { ok: true, value: value(result.value) } }
    : { requestId: request.requestId, result: { ok: false, error: await apiError(context, result.error) } };
}

async function errorResponse(context: OmegaContext, request: ClientRequest, error: OmegaError): Promise<ClientResponse> {
  return { requestId: request.requestId, result: { ok: false, error: await apiError(context, error) } };
}

export type BenchmarkLauncherDependencies = {
  readonly root: AbsolutePath;
  readonly objects: ObjectStore;
  readonly projects: Pick<ProjectRepository, "registerBenchmarkWorkspace">;
  readonly sessions: Pick<SessionService, "startBenchmarkTask" | "cancel">;
  readonly repository: Pick<SessionRepository, "get" | "read" | "recordArtifact">;
  readonly config: OmegaContext["config"];
};

type Check = { readonly path: string; readonly equals?: string; readonly contains?: string; readonly absent?: boolean };

function launcherIo(operation: string): EvolutionError {
  return { kind: "io-error", operation, code: null, recoverable: false, callerAction: "propagate" };
}

function launcherCancelled(): Result<never, EvolutionError> {
  return {
    ok: false,
    error: {
      kind: "validation",
      message: "Benchmark evaluation cancelled",
      field: "signal",
      recoverable: true,
      callerAction: "fix-request",
    },
  };
}

function benchmarkAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

async function objectBytes(objects: ObjectStore, hash: Parameters<ObjectStore["get"]>[0]): Promise<Result<Uint8Array, EvolutionError>> {
  const found = await objects.get(hash);
  if (!found.ok) return found;
  const chunks: Uint8Array[] = [];
  for await (const chunk of found.value) chunks.push(chunk);
  return { ok: true, value: Buffer.concat(chunks) };
}

function parseRecord(bytes: Uint8Array, label: string): Result<JsonValue, EvolutionError> {
  try {
    return { ok: true, value: JSON.parse(Buffer.from(bytes).toString("utf8")) as JsonValue };
  } catch {
    return { ok: false, error: { kind: "protocol-error", protocol: "session-jsonl", message: `${label} is not valid JSON`, recoverable: false, callerAction: "abort" } };
  }
}

function recordValue(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function materializeFixture(root: string, bytes: Uint8Array): Promise<Result<AbsolutePath, EvolutionError>> {
  const parsed = parseRecord(bytes, "Benchmark fixture");
  if (!parsed.ok) return parsed;
  if (!recordValue(parsed.value)) {
    return { ok: false, error: { kind: "validation", message: "Benchmark fixture must contain a files object", field: "fixture", recoverable: true, callerAction: "fix-request" } };
  }
  const files = parsed.value["files"];
  if (files === undefined || !recordValue(files)) {
    return { ok: false, error: { kind: "validation", message: "Benchmark fixture must contain a files object", field: "fixture", recoverable: true, callerAction: "fix-request" } };
  }
  try {
    await mkdir(join(root, "benchmark-workspaces"), { recursive: true });
    const workspace = await mkdtemp(join(root, "benchmark-workspaces", "run-"));
    for (const [path, content] of Object.entries(files)) {
      if (typeof content !== "string") return { ok: false, error: { kind: "validation", message: "Fixture file contents must be strings", field: "fixture.files", recoverable: true, callerAction: "fix-request" } };
      const target = resolve(workspace, path);
      const local = relative(workspace, target);
      if (local.startsWith("..") || local === ".git" || local.startsWith(`.git/`)) {
        return { ok: false, error: { kind: "validation", message: "Fixture path escapes the isolated workspace", field: "fixture.files", recoverable: true, callerAction: "fix-request" } };
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    return { ok: true, value: workspace as AbsolutePath };
  } catch {
    return { ok: false, error: launcherIo("materialize-benchmark-fixture") };
  }
}

function parseChecks(bytes: Uint8Array, label: string): Result<readonly Check[], EvolutionError> {
  const parsed = parseRecord(bytes, label);
  if (!parsed.ok) return parsed;
  if (!recordValue(parsed.value) || !Array.isArray(parsed.value["checks"])) {
    return { ok: false, error: { kind: "validation", message: `${label} must contain checks`, field: label, recoverable: true, callerAction: "fix-request" } };
  }
  const checks: Check[] = [];
  for (const value of parsed.value["checks"]) {
    if (!recordValue(value) || typeof value["path"] !== "string") {
      return { ok: false, error: { kind: "validation", message: `${label} contains an invalid check`, field: label, recoverable: true, callerAction: "fix-request" } };
    }
    const check: Check = {
      path: value["path"],
      ...(typeof value["equals"] === "string" ? { equals: value["equals"] } : {}),
      ...(typeof value["contains"] === "string" ? { contains: value["contains"] } : {}),
      ...(typeof value["absent"] === "boolean" ? { absent: value["absent"] } : {}),
    };
    checks.push(check);
  }
  return { ok: true, value: checks };
}

async function runChecks(workspace: string, checks: readonly Check[]): Promise<boolean> {
  for (const check of checks) {
    const target = resolve(workspace, check.path);
    if (relative(workspace, target).startsWith("..")) return false;
    let content: string | null;
    try { content = await readFile(target, "utf8"); } catch { content = null; }
    if (check.absent === true) { if (content !== null) return false; continue; }
    if (content === null || (check.equals !== undefined && content !== check.equals)
      || (check.contains !== undefined && !content.includes(check.contains))) return false;
  }
  return true;
}

async function putArtifact(
  options: BenchmarkLauncherDependencies,
  sessionId: Parameters<SessionRepository["get"]>[0],
  kind: ArtifactRecord["kind"],
  payload: JsonValue,
): Promise<Result<ArtifactId, EvolutionError>> {
  const bytes = encoder.encode(`${JSON.stringify(payload)}\n`);
  const object = await options.objects.put("application/json", (async function* (): AsyncIterable<Uint8Array> { yield bytes; })());
  if (!object.ok) return object;
  const at = timestamp();
  const artifact: ArtifactRecord = {
    id: `artifact_${randomUUID()}` as ArtifactId,
    kind,
    object: object.value,
    sessionId,
    createdAt: at,
    metadata: { benchmark: true },
  };
  const recorded = await options.repository.recordArtifact(artifact);
  return recorded.ok ? { ok: true, value: recorded.value.id } : recorded;
}

function zeroMetrics(verifierPassed: boolean, negativeInvariantsPassed: boolean, elapsed: number): BenchmarkMetrics {
  return {
    verifierPassed,
    negativeInvariantsPassed,
    usage: { inputTokens: 0 as TokenCount, cachedInputTokens: 0 as TokenCount, reasoningTokens: 0 as TokenCount, outputTokens: 0 as TokenCount, costUsdMicros: 0 as UsdMicros },
    equivalentListPriceUsdMicros: 0 as UsdMicros,
    wallTimeMs: elapsed as DurationMs,
    timeToFirstTokenMs: null,
    generationTimeMs: 0 as DurationMs,
    modelTurns: 0,
    toolCalls: 0,
    processStarts: 0,
    staleWrites: 0,
    policyAllows: 0,
    policyDenials: 0,
    policyEscalations: 0,
    retries: 0,
    childSessions: 0,
    harnessUpdates: 0,
  };
}

async function observedBenchmark(
  options: BenchmarkLauncherDependencies,
  sessionId: Parameters<SessionRepository["get"]>[0],
  requestedRoute: ModelRouteSignature,
  verifierPassed: boolean,
  negativeInvariantsPassed: boolean,
  startedAt: Timestamp,
  completedAt: Timestamp,
): Promise<Result<{ readonly route: ModelRouteSignature; readonly generationId: string | null; readonly metrics: BenchmarkMetrics }, EvolutionError>> {
  const events: SessionEvent[] = [];
  let cursor = 0;
  while (true) {
    const page = await options.repository.read(sessionId, cursor, 1_000);
    if (!page.ok) return page;
    events.push(...page.value);
    if (page.value.length < 1_000) break;
    cursor = page.value[page.value.length - 1]?.sequence ?? cursor;
  }
  const completions = events.flatMap((event) => event.payload.kind === "model.completed" ? [event.payload.completion] : []);
  const latest = completions[completions.length - 1];
  const usage = completions.reduce((sum, completion) => ({
    inputTokens: sum.inputTokens + Number(completion.usage.inputTokens),
    cachedInputTokens: sum.cachedInputTokens + Number(completion.usage.cachedInputTokens),
    reasoningTokens: sum.reasoningTokens + Number(completion.usage.reasoningTokens),
    outputTokens: sum.outputTokens + Number(completion.usage.outputTokens),
    costUsdMicros: sum.costUsdMicros + Number(completion.usage.costUsdMicros),
  }), { inputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, outputTokens: 0, costUsdMicros: 0 });
  const firstToken = completions.find((completion) => completion.firstTokenAt !== null);
  const generationMs = completions.reduce((sum, completion) => sum + Math.max(0, Date.parse(completion.completedAt) - Date.parse(completion.startedAt)), 0);
  const base = zeroMetrics(verifierPassed, negativeInvariantsPassed, Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)));
  return {
    ok: true,
    value: {
      route: latest?.route ?? requestedRoute,
      generationId: latest?.providerGenerationId ?? null,
      metrics: {
        ...base,
        usage: {
          inputTokens: usage.inputTokens as TokenCount,
          cachedInputTokens: usage.cachedInputTokens as TokenCount,
          reasoningTokens: usage.reasoningTokens as TokenCount,
          outputTokens: usage.outputTokens as TokenCount,
          costUsdMicros: usage.costUsdMicros as UsdMicros,
        },
        generationTimeMs: generationMs as DurationMs,
        timeToFirstTokenMs: firstToken?.firstTokenAt === null || firstToken === undefined
          ? null
          : Math.max(0, Date.parse(firstToken.firstTokenAt) - Date.parse(firstToken.startedAt)) as DurationMs,
        modelTurns: completions.length,
        processStarts: events.filter((event) => event.payload.kind === "process.started").length,
        policyAllows: events.filter((event) => event.payload.kind === "policy.decided" && event.payload.decision.outcome === "allow").length,
        policyDenials: events.filter((event) => event.payload.kind === "policy.decided" && event.payload.decision.outcome === "deny").length,
        policyEscalations: events.filter((event) => event.payload.kind === "policy.escalated").length,
        retries: events.filter((event) => event.payload.kind === "model.failed").length,
        childSessions: events.filter((event) => event.payload.kind === "child.spawned").length,
        harnessUpdates: events.filter((event) => event.payload.kind === "harness.updated").length,
      },
    },
  };
}

/** Trusted boundary: fixture/public inputs reach the pinned session; verifier bytes never do. */
export function createBenchmarkRunLauncher(options: BenchmarkLauncherDependencies): BenchmarkRunLauncher {
  return {
    async execute(request: BenchmarkExecutionRequest, signal?: AbortSignal) {
      if (benchmarkAborted(signal)) return launcherCancelled();
      if (request.privateTask.taskId !== request.task.id) {
        return {
          ok: false,
          error: {
            kind: "validation",
            message: "Benchmark private metadata does not match the public task",
            field: "privateTask.taskId",
            recoverable: true,
            callerAction: "fix-request",
          },
        };
      }
      const fixture = await objectBytes(options.objects, request.task.fixtureObjectHash);
      if (!fixture.ok) return fixture;
      if (benchmarkAborted(signal)) return launcherCancelled();
      const verifier = await objectBytes(options.objects, request.privateTask.verifierObjectHash);
      if (!verifier.ok) return verifier;
      const negativeInvariants = await objectBytes(options.objects, request.privateTask.negativeInvariantObjectHash);
      if (!negativeInvariants.ok) return negativeInvariants;
      const materialized = await materializeFixture(options.root, fixture.value);
      if (!materialized.ok) return materialized;
      if (benchmarkAborted(signal)) {
        await rm(materialized.value, { recursive: true, force: true }).catch(() => undefined);
        return launcherCancelled();
      }
      const startedAt = timestamp();
      try {
        const registered = await options.projects.registerBenchmarkWorkspace(
          request.harness.projectId,
          materialized.value,
          request.task.fixtureObjectHash,
        );
        if (!registered.ok) return registered;
        if (registered.value.projectId !== request.harness.projectId) {
          return { ok: false, error: { kind: "validation", message: "Materialized fixture did not resolve to the benchmark project", field: "fixture", recoverable: true, callerAction: "fix-request" } };
        }
        const capabilityEnvelope: CapabilityEnvelope = {
          ...options.config.sessions.mainCapabilities,
          maxCostUsdMicros: request.task.budget.maxCostUsdMicros,
          maxModelCalls: request.task.budget.maxModelCalls,
          maxProcessStarts: request.task.budget.maxProcessStarts,
          maxInputTokens: request.task.budget.maxInputTokens,
          maxOutputTokens: request.task.budget.maxOutputTokens,
          wallTimeMs: request.task.budget.wallTimeMs,
          createdAt: timestamp(),
        };
        const session = await options.sessions.startBenchmarkTask({
          projectId: request.harness.projectId,
          workspaceId: registered.value.id,
          objective: request.task.objective,
          harnessId: request.harness.id,
          route: request.route,
          policyProfile: options.config.policy.profile,
          capabilityEnvelope,
          credentialEnvNames: options.config.sessions.credentialEnvNames,
        });
        if (!session.ok) return session;
        let terminal = session.value;
        let abortCancellation: ReturnType<typeof options.sessions.cancel> | null = null;
        const cancelForAbort = (): ReturnType<typeof options.sessions.cancel> => {
          abortCancellation ??= options.sessions.cancel(terminal.header.id, "benchmark evaluation cancelled");
          return abortCancellation;
        };
        const onAbort = (): void => { void cancelForAbort(); };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (benchmarkAborted(signal)) onAbort();
        try {
        const deadline = Date.now() + Number(request.task.budget.wallTimeMs);
        while (terminal.outcome === null && Date.now() < deadline && !benchmarkAborted(signal)) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          const observed = await options.repository.get(terminal.header.id);
          if (!observed.ok) return observed;
          terminal = observed.value;
        }
        if (benchmarkAborted(signal)) {
          const cancelled = await cancelForAbort();
          if (!cancelled.ok) {
            switch (cancelled.error.kind) {
              case "policy-denied":
              case "process-not-running":
              case "process-interrupted":
              case "unsupported":
                return { ok: false, error: { kind: "validation", message: `Benchmark cancellation failed: ${cancelled.error.kind}`, field: "sessionId", recoverable: true, callerAction: "fix-request" } };
              default:
                return { ok: false, error: cancelled.error };
            }
          }
          return launcherCancelled();
        }
        if (terminal.outcome === null) {
          const cancelled = await options.sessions.cancel(terminal.header.id, "benchmark wall-time budget exceeded");
          if (!cancelled.ok) {
            switch (cancelled.error.kind) {
              case "policy-denied":
              case "process-not-running":
              case "process-interrupted":
              case "unsupported":
                return { ok: false, error: { kind: "validation", message: `Benchmark cancellation failed: ${cancelled.error.kind}`, field: "sessionId", recoverable: true, callerAction: "fix-request" } };
              default:
                return { ok: false, error: cancelled.error };
            }
          }
          terminal = cancelled.value;
        }
        const verifierChecks = parseChecks(verifier.value, "Benchmark verifier");
        if (!verifierChecks.ok) return verifierChecks;
        const invariantChecks = parseChecks(negativeInvariants.value, "Benchmark negative invariants");
        if (!invariantChecks.ok) return invariantChecks;
        const verifierPassed = terminal.outcome === "succeeded" && await runChecks(materialized.value, verifierChecks.value);
        const negativeInvariantsPassed = await runChecks(materialized.value, invariantChecks.value);
        const completedAt = timestamp();
        const outcome = verifierPassed && negativeInvariantsPassed ? "passed" : terminal.outcome === "cancelled" ? "budget-exceeded" : "failed";
        const diff = await putArtifact(options, terminal.header.id, "workspace-snapshot", { outcome, files: (await readdir(materialized.value, { recursive: true })).filter((path) => !path.startsWith(".git")) });
        if (!diff.ok) return diff;
        const report = await putArtifact(options, terminal.header.id, "benchmark-report", { outcome, verifierPassed, negativeInvariantsPassed });
        if (!report.ok) return report;
        const policyObject = await options.objects.put("application/vnd.omega.policy+json", (async function* (): AsyncIterable<Uint8Array> { yield encoder.encode(JSON.stringify(options.config.policy)); })());
        if (!policyObject.ok) return policyObject;
        const observed = await observedBenchmark(options, terminal.header.id, request.route, verifierPassed, negativeInvariantsPassed, startedAt, completedAt);
        if (!observed.ok) return observed;
        return {
          ok: true,
          value: {
            sessionId: terminal.header.id,
            executionPolicyComponentId: `component_${policyObject.value.hash}` as ComponentId,
            route: observed.value.route,
            servingProviderGenerationId: observed.value.generationId,
            outcome,
            failureCategory: outcome === "passed" ? null : terminal.outcome === "cancelled" ? "wall-time-budget" : "verification",
            metrics: observed.value.metrics,
            finalDiffArtifactId: diff.value,
            reportArtifactId: report.value,
            startedAt,
            completedAt,
          },
        };
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      } catch {
        return { ok: false, error: launcherIo("execute-benchmark") };
      } finally {
        await rm(materialized.value, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

function createContext(config: Parameters<CreateOmegaApplication>[0], environment: Parameters<CreateOmegaApplication>[1]): OmegaContext {
  const root = join(homedir(), config.homeDirectory.path) as AbsolutePath;
  const objects = createFileObjectStore(root);
  const projects = createFileProjectRepository(root, objects);
  const sessionRepository = createFileSessionRepository(root, objects);
  const models = createModelRouter(config.models, environment);
  const policy = createExecutionPolicy(config.policy, models, root);
  const runtime = createProcessRuntime({ config: config.processes, environment, projects, sessions: sessionRepository, objects, policy });
  const harnesses = createHarnessRepository(root, objects, projects);
  const runners = createRunnerHost(runtime.processes, harnesses);
  const baseActivation = createHarnessActivationService(projects, harnesses);
  let context: OmegaContext;
  const runnerRequests = createRunnerProtocolDispatcher(() => context);
  const sessions = createSessionService({
    config: config.sessions,
    repository: sessionRepository,
    projects,
    harnesses,
    runners,
    processes: runtime.processes,
    models,
    policy,
    objects,
    runnerRequests,
  });
  const activation = createCoordinatedActivationService({
    activation: baseActivation,
    repository: sessionRepository,
    sessions,
    runners,
  });
  const knowledge = createKnowledgeService(root, objects);
  const marketplace = createMarketplaceService({ root, objects, harnesses, activation });
  const launcher = createBenchmarkRunLauncher({ root, objects, projects, sessions, repository: sessionRepository, config });
  const benchmarks = createBenchmarkService({ root, objects, sessions, harnesses, activation, launcher });
  const evolution = createEvolutionService({
    root,
    objects,
    repository: sessionRepository,
    sessions,
    harnesses,
    benchmarks,
    activation,
  });
  context = {
    config,
    objects,
    projects,
    sessionRepository,
    files: runtime.files,
    processes: runtime.processes,
    models,
    policy,
    sessions,
    harnesses,
    runners,
    runnerRequests,
    activation,
    knowledge,
    marketplace,
    evolution,
    benchmarks,
  };
  return context;
}

export async function ensureProjectHarness(
  project: ProjectRecord,
  objects: ObjectStore,
  projects: ProjectRepository,
  harnesses: HarnessRepository,
): Promise<Result<HarnessManifest, HarnessError>> {
  if (project.activeHarnessId !== null) return harnesses.getHarness(project.activeHarnessId);
  const created = await createInitialHarness(project, objects, projects);
  if (!created.ok) return created;
  const indexed = await harnesses.putHarness(created.value);
  if (!indexed.ok) return indexed;
  const activated = await projects.compareAndSetActiveHarness(project.id, null, indexed.value.id);
  if (activated.ok) return { ok: true, value: indexed.value };
  const refreshed = await projects.getProject(project.id);
  if (refreshed.ok && refreshed.value.activeHarnessId === indexed.value.id) return { ok: true, value: indexed.value };
  return activated;
}

async function execute(context: OmegaContext, request: ClientRequest): Promise<ClientResponse> {
  switch (request.kind) {
    case "project.list":
      return response(context, request, await context.projects.listProjects(request.page), (page) => ({ kind: "projects", page }));
    case "project.register-workspace": {
      const registered = await context.projects.registerWorkspace(request.path);
      if (!registered.ok) return errorResponse(context, request, registered.error);
      const initial = await ensureProjectHarness(registered.value.project, context.objects, context.projects, context.harnesses);
      if (!initial.ok) return errorResponse(context, request, initial.error);
      const project = await context.projects.getProject(registered.value.project.id);
      if (!project.ok) return errorResponse(context, request, project.error);
      return {
        requestId: request.requestId,
        result: { ok: true, value: { kind: "workspace.registered", project: project.value, workspace: registered.value.workspace } },
      };
    }
    case "task.start":
      return response(context, request, await context.sessions.startTask(request.request), (session) => ({ kind: "session", session }));
    case "thread.resume":
      return response(context, request, await context.sessions.resumeThread(request.request), (session) => ({ kind: "session", session }));
    case "session.get":
      return response(context, request, await context.sessionRepository.get(request.sessionId), (session) => ({ kind: "session", session }));
    case "session.list":
      return response(context, request, await context.sessionRepository.list(request.projectId, request.page), (page) => ({ kind: "sessions", page }));
    case "artifact.read":
      return response(context, request, await context.sessionRepository.readArtifact(request.artifactId, request.offset, request.limit), (slice) => ({ kind: "artifact", slice }));
    case "session.cancel":
      return response(context, request, await context.sessions.cancel(request.sessionId, request.reason), (session) => ({ kind: "session", session }));
    case "policy.list":
      return response(context, request, await context.policy.listEscalations(request.sessionId, request.state, request.page), (page) => ({ kind: "policy-escalations", page }));
    case "policy.resolve":
      return response(context, request, await context.policy.resolve(request.request), (escalation) => ({ kind: "policy-escalation", escalation }));
    case "evolution.start": {
      const source = await context.sessionRepository.get(request.request.sourceSessionId);
      if (!source.ok) return response(context, request, source, () => ({ kind: "evolution", job: null as never }));
      return response(context, request, await context.evolution.start(request.request, source.value.header.capabilityEnvelope), (job) => ({ kind: "evolution", job }));
    }
    case "evolution.get":
      return response(context, request, await context.evolution.get(request.jobId), (job) => ({ kind: "evolution", job }));
    case "evolution.list":
      return response(context, request, await context.evolution.list(request.projectId, request.page), (page) => ({ kind: "evolutions", page }));
    case "evolution.retry":
      return response(context, request, await context.evolution.retry(request.jobId), (job) => ({ kind: "evolution", job }));
    case "evolution.cancel":
      return response(context, request, await context.evolution.cancel(request.jobId, request.reason), (job) => ({ kind: "evolution", job }));
    case "benchmark.run-task": {
      const configured = context.config.models.routes.find((route) => route.role === "promotion-evaluator");
      if (configured === undefined) {
        return errorResponse(context, request, {
          kind: "validation",
          message: "The promotion-evaluator route is not configured.",
          field: "models.routes",
          recoverable: true,
          callerAction: "fix-request",
        });
      }
      const route: ModelRouteSignature = {
        role: configured.role,
        providerId: configured.providerId,
        modelId: configured.modelId,
        variant: null,
        servingProvider: null,
        quantization: null,
        reasoning: configured.reasoning,
        temperature: configured.temperature,
        topP: configured.topP,
        seed: configured.seed,
        contextLimit: configured.contextLimit,
        outputLimit: configured.maxOutputTokens,
        equivalentListPrice: configured.equivalentListPrice,
      };
      return response(context, request, await context.benchmarks.runTask(request.suiteId, request.taskId, request.harnessId, route), (run) => ({ kind: "benchmark-run", run }));
    }
    case "benchmark.run-paired":
      return response(context, request, await context.benchmarks.runPaired(request.suiteId, request.incumbentId, request.candidateId), (scorecard) => ({ kind: "scorecard", scorecard }));
    case "scorecard.get":
      return response(context, request, await context.benchmarks.getScorecard(request.scorecardId), (scorecard) => ({ kind: "scorecard", scorecard }));
    case "scorecard.list":
      return response(context, request, await context.benchmarks.listScorecards(request.projectId, request.page), (page) => ({ kind: "scorecards", page }));
    case "knowledge.catalog":
      return response(context, request, await context.knowledge.catalog(request.query), (entries) => ({ kind: "knowledge-catalog", entries }));
    case "knowledge.read":
      return response(context, request, await context.knowledge.read(request.projectId, request.documentId), (document) => ({ kind: "knowledge-document", document }));
    case "marketplace.search":
      return response(context, request, await context.marketplace.search(request.query), (artifacts) => ({ kind: "marketplace-results", artifacts }));
    case "marketplace.transition":
      return response(context, request, await context.marketplace.transition(request.request, applicationCapabilities(context)), (artifact) => ({ kind: "marketplace-artifact", artifact }));
    case "harness.get":
      return response(context, request, await context.harnesses.getHarness(request.harnessId), (harness) => ({ kind: "harness", harness }));
    case "harness.list":
      return response(context, request, await context.harnesses.listProjectHarnesses(request.projectId, request.page), (page) => ({ kind: "harnesses", page }));
    case "harness.rollback":
      return response(context, request, await context.activation.rollback(request.projectId, request.targetHarnessId, request.reason), (update) => ({ kind: "harness-update", update }));
    case "harness.pin":
      return response(context, request, await context.activation.pin(request.projectId, request.targetHarnessId, request.reason), (update) => ({ kind: "harness-update", update }));
  }
}

function validationFromRecovery(error: OmegaError): ValidationError {
  return {
    kind: "validation",
    message: `Runtime recovery failed: ${error.kind}`,
    field: "processes",
    recoverable: true,
    callerAction: "fix-request",
  };
}

export const createOmegaApplication: CreateOmegaApplication = (config, environment): OmegaApplication => {
  const context = createContext(config, environment);
  let started = false;
  let stopped = false;
  return {
    async execute(request) {
      try {
        return await execute(context, request);
      } catch (error) {
        return {
          requestId: request.requestId,
          result: { ok: false, error: await diagnosticError(context, { boundary: "execute", thrown: String(error) }) },
        };
      }
    },
    events(sessionId, afterSequence) {
      return context.sessions.subscribe(sessionId, afterSequence);
    },
    recordDiagnostic(input) {
      return recordDiagnostic(context, input);
    },
    async start() {
      if (stopped) return { ok: false, error: await diagnosticError(context, { lifecycle: "start-after-stop" }) };
      if (started) return { ok: true, value: undefined };
      const recovered = await context.processes.recoverOrphans();
      if (!recovered.ok) return { ok: false, error: validationFromRecovery(recovered.error) };
      const sessionsRecovered = await recoverPersistedSessions({
        projects: context.projects,
        repository: context.sessionRepository,
        sessions: context.sessions,
      });
      if (!sessionsRecovered.ok) return { ok: false, error: validationFromRecovery(sessionsRecovered.error) };
      started = true;
      return { ok: true, value: undefined };
    },
    async stop(deadline) {
      if (stopped) return { ok: true, value: undefined };
      const shutdown = await context.processes.shutdown(deadline);
      if (!shutdown.ok) {
        if (shutdown.error.kind === "io-error") return { ok: false, error: shutdown.error };
        return { ok: false, error: await diagnosticError(context, { lifecycle: "shutdown", error: shutdown.error as JsonValue }) };
      }
      stopped = true;
      return { ok: true, value: undefined };
    },
  };
};
