import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  BenchmarkManifest,
  BenchmarkRun,
  BenchmarkRunId,
  BenchmarkService,
  BenchmarkSuiteId,
  BenchmarkTaskId,
  CreateBenchmarkService,
  EvolutionError,
  HarnessManifest,
  ModelRoleRoute,
  ModelRouteSignature,
  Page,
  PageRequest,
  PairedTaskResult,
  PromotionScorecard,
  Result,
  ScorecardId,
  Sha256,
  Timestamp,
} from "../contracts/index.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { atomicWriteFile, ioError, safeStorageKey } from "../persistence/artifact-store.js";
import { recordCanaryEvidence } from "./canary-monitor.js";
import { buildPromotionScorecard, pairReplicateRuns } from "./promotion-evaluator.js";
import { createOmegaBenchManifest, omegaBenchAssets, resolveTrustedOmegaBenchPrivateTask } from "./omega-bench-manifest.js";

function now(): Timestamp {
  return new Date().toISOString() as Timestamp;
}

function notFound(resource: string, id: string): EvolutionError {
  return {
    kind: "not-found",
    resource,
    id,
    recoverable: false,
    callerAction: "propagate",
  };
}

function validation(message: string, field: string | null): EvolutionError {
  return {
    kind: "validation",
    message,
    field,
    recoverable: true,
    callerAction: "fix-request",
  };
}

function cancellation(): Result<never, EvolutionError> {
  return { ok: false, error: validation("Benchmark evaluation cancelled.", "signal") };
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

function routeSignature(route: ModelRoleRoute): ModelRouteSignature {
  return {
    role: route.role,
    providerId: route.providerId,
    modelId: route.modelId,
    variant: null,
    servingProvider: null,
    quantization: null,
    reasoning: route.reasoning,
    temperature: route.temperature,
    topP: route.topP,
    seed: route.seed,
    contextLimit: route.contextLimit,
    outputLimit: route.maxOutputTokens,
    equivalentListPrice: route.equivalentListPrice,
  };
}

function pageFrom<T>(items: readonly T[], request: PageRequest): Result<Page<T>, EvolutionError> {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) {
    return { ok: false, error: validation("Page limit must be an integer between 1 and 1000.", "page.limit") };
  }
  const offset = request.cursor === null ? 0 : Number(request.cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return { ok: false, error: validation("Page cursor is invalid.", "page.cursor") };
  }
  const pageItems = items.slice(offset, offset + request.limit);
  const nextOffset = offset + pageItems.length;
  return {
    ok: true,
    value: {
      items: pageItems,
      nextCursor: nextOffset < items.length ? String(nextOffset) : null,
    },
  };
}

export const createBenchmarkService: CreateBenchmarkService = (options): BenchmarkService => {
  const manifest = createOmegaBenchManifest(DEFAULT_CONFIG.benchmarks.developmentPromotionPolicy);
  const runs = new Map<BenchmarkRunId, BenchmarkRun>();
  const scorecards = new Map<ScorecardId, PromotionScorecard>();
  const loaded = loadPersistedState(String(options.root), runs, scorecards);
  let assetsLoaded = false;

  async function ensureLoaded(): Promise<Result<void, EvolutionError>> {
    try {
      await loaded;
      if (assetsLoaded) return { ok: true, value: undefined };
      for (const asset of omegaBenchAssets()) {
        const stored = await options.objects.put(asset.mediaType, (async function* (): AsyncIterable<Uint8Array> {
          yield asset.bytes;
        })());
        if (!stored.ok) return stored;
        if (stored.value.hash !== asset.hash || stored.value.size !== asset.size) {
          return { ok: false, error: {
            kind: "integrity-failure",
            resource: "omegabench-asset",
            expected: String(asset.hash) as Sha256,
            actual: String(stored.value.hash) as Sha256,
            recoverable: false,
            callerAction: "abort",
          } };
        }
      }
      assetsLoaded = true;
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: ioError("load-benchmark-state", error) };
    }
  }

  async function getManifest(id: BenchmarkSuiteId): Promise<Result<BenchmarkManifest, EvolutionError>> {
    if (id !== manifest.id) return { ok: false, error: notFound("benchmark-manifest", id) };
    return { ok: true, value: manifest };
  }

  async function runTaskWithHarness(
    taskId: BenchmarkTaskId,
    harness: HarnessManifest,
    route: ModelRouteSignature,
    signal?: AbortSignal,
  ): Promise<Result<BenchmarkRun, EvolutionError>> {
    if (isAborted(signal)) return cancellation();
    const ready = await ensureLoaded();
    if (!ready.ok) return ready;
    if (isAborted(signal)) return cancellation();
    const task = manifest.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) return { ok: false, error: notFound("benchmark-task", taskId) };
    const privateTask = resolveTrustedOmegaBenchPrivateTask(taskId);
    if (privateTask === null) return { ok: false, error: notFound("benchmark-private-task", taskId) };

    const launched = await options.launcher.execute({
      suiteId: manifest.id,
      manifestVersion: manifest.version,
      promotionPolicy: manifest.promotionPolicy,
      task,
      privateTask,
      harness,
      route,
    }, signal);
    if (!launched.ok) return launched;

    const run: BenchmarkRun = {
      id: randomUUID() as BenchmarkRunId,
      suiteId: manifest.id,
      taskId,
      sessionId: launched.value.sessionId,
      harnessId: harness.id,
      harnessComponentObjectHashes: harness.components.map((component) => component.objectHash),
      executionPolicyComponentId: launched.value.executionPolicyComponentId,
      route: launched.value.route,
      servingProviderGenerationId: launched.value.servingProviderGenerationId,
      fixtureObjectHash: task.fixtureObjectHash,
      environmentObjectHash: task.environmentObjectHash,
      effectiveBudget: task.budget,
      benchmarkManifestVersion: manifest.version,
      promotionPolicyId: manifest.promotionPolicy.id,
      outcome: launched.value.outcome,
      failureCategory: launched.value.failureCategory,
      metrics: launched.value.metrics,
      finalDiffArtifactId: launched.value.finalDiffArtifactId,
      reportArtifactId: launched.value.reportArtifactId,
      startedAt: launched.value.startedAt,
      completedAt: launched.value.completedAt,
    };
    const persisted = await persistBenchmarkRecord(String(options.root), "runs", run.id, run);
    if (!persisted.ok) return persisted;
    runs.set(run.id, run);
    if (isAborted(signal)) return cancellation();
    return { ok: true, value: run };
  }

  async function runTask(
    suiteId: BenchmarkSuiteId,
    taskId: BenchmarkTaskId,
    harnessId: HarnessManifest["id"],
    route: ModelRouteSignature,
  ): Promise<Result<BenchmarkRun, EvolutionError>> {
    if (suiteId !== manifest.id) return { ok: false, error: notFound("benchmark-manifest", suiteId) };
    const harness = await options.harnesses.getHarness(harnessId);
    if (!harness.ok) return harness;
    return runTaskWithHarness(taskId, harness.value, route);
  }

  async function runPaired(
    suiteId: BenchmarkSuiteId,
    incumbentId: HarnessManifest["id"],
    candidateId: HarnessManifest["id"],
    signal?: AbortSignal,
  ): Promise<Result<PromotionScorecard, EvolutionError>> {
    if (isAborted(signal)) return cancellation();
    const ready = await ensureLoaded();
    if (!ready.ok) return ready;
    if (suiteId !== manifest.id) return { ok: false, error: notFound("benchmark-manifest", suiteId) };
    if (incumbentId === candidateId) {
      return { ok: false, error: validation("Incumbent and candidate harness IDs must differ.", "candidateId") };
    }

    const incumbent = await options.harnesses.getHarness(incumbentId);
    if (!incumbent.ok) return incumbent;
    const candidate = await options.harnesses.getHarness(candidateId);
    if (!candidate.ok) return candidate;
    if (incumbent.value.projectId !== candidate.value.projectId) {
      return { ok: false, error: validation("Paired harnesses must belong to the same project.", "candidateId") };
    }

    const evaluatorRoute = DEFAULT_CONFIG.models.routes.find((route) => route.role === "promotion-evaluator");
    if (evaluatorRoute === undefined) {
      return { ok: false, error: validation("The promotion-evaluator route is not configured.", "models.routes") };
    }
    const route = routeSignature(evaluatorRoute);
    const pairedResults: PairedTaskResult[] = [];
    for (const task of manifest.tasks) {
      const incumbentRuns: BenchmarkRun[] = [];
      const candidateRuns: BenchmarkRun[] = [];
      for (let replicate = 0; replicate < manifest.promotionPolicy.replicatesPerHarness; replicate += 1) {
        if (isAborted(signal)) return cancellation();
        const incumbentRun = await runTaskWithHarness(task.id, incumbent.value, route, signal);
        if (!incumbentRun.ok) return incumbentRun;
        incumbentRuns.push(incumbentRun.value);

        if (isAborted(signal)) return cancellation();
        const candidateRun = await runTaskWithHarness(task.id, candidate.value, route, signal);
        if (!candidateRun.ok) return candidateRun;
        candidateRuns.push(candidateRun.value);
      }
      pairedResults.push(...pairReplicateRuns(incumbentRuns, candidateRuns));
    }

    const scorecard = buildPromotionScorecard({
      projectId: incumbent.value.projectId,
      incumbentHarnessId: incumbentId,
      candidateHarnessId: candidateId,
      policy: manifest.promotionPolicy,
      pairedResults,
      expectedPairCount: manifest.tasks.length * manifest.promotionPolicy.replicatesPerHarness,
      createdAt: now(),
    });
    const persisted = await persistBenchmarkRecord(String(options.root), "scorecards", scorecard.id, scorecard);
    if (!persisted.ok) return persisted;
    scorecards.set(scorecard.id, scorecard);

    if (isAborted(signal)) return cancellation();
    if (scorecard.decision.outcome === "promote") {
      if (isAborted(signal)) return cancellation();
      const activated = await options.activation.promote(
        { ...scorecard, decision: scorecard.decision },
        () => !isAborted(signal),
      );
      if (!activated.ok) {
        return isAborted(signal) ? cancellation() : activated;
      }
    }
    return { ok: true, value: scorecard };
  }

  async function getScorecard(id: ScorecardId): Promise<Result<PromotionScorecard, EvolutionError>> {
    const ready = await ensureLoaded();
    if (!ready.ok) return ready;
    const scorecard = scorecards.get(id);
    return scorecard === undefined
      ? { ok: false, error: notFound("promotion-scorecard", id) }
      : { ok: true, value: scorecard };
  }

  async function listScorecards(
    projectId: HarnessManifest["projectId"],
    page: PageRequest,
  ): Promise<Result<Page<PromotionScorecard>, EvolutionError>> {
    const ready = await ensureLoaded();
    if (!ready.ok) return ready;
    const matches = [...scorecards.values()]
      .filter((scorecard) => scorecard.projectId === projectId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return pageFrom(matches, page);
  }

  return {
    getManifest,
    runTask,
    runPaired,
    getScorecard,
    listScorecards,
    recordCanary: async (harnessId, source) => {
      const ready = await ensureLoaded();
      if (!ready.ok) return ready;
      return recordCanaryEvidence({
        harnessId,
        source,
        benchmarkRuns: runs,
        harnesses: options.harnesses,
        activation: options.activation,
      });
    },
  };
};

async function loadPersistedState(
  root: string,
  runs: Map<BenchmarkRunId, BenchmarkRun>,
  scorecards: Map<ScorecardId, PromotionScorecard>,
): Promise<void> {
  const [storedRuns, storedScorecards] = await Promise.all([
    loadBenchmarkRecords<BenchmarkRun>(root, "runs", isBenchmarkRun),
    loadBenchmarkRecords<PromotionScorecard>(root, "scorecards", isPromotionScorecard),
  ]);
  for (const run of storedRuns) runs.set(run.id, run);
  for (const scorecard of storedScorecards) scorecards.set(scorecard.id, scorecard);
}

async function loadBenchmarkRecords<T>(
  root: string,
  category: "runs" | "scorecards",
  validate: (value: unknown) => value is T,
): Promise<readonly T[]> {
  const directory = join(root, "benchmarks", category);
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(async (entry) => {
      const value: unknown = JSON.parse(await readFile(join(directory, entry.name), "utf8"));
      if (!validate(value)) throw new Error(`Stored benchmark ${category} record is malformed`);
      return value;
    }));
}

async function persistBenchmarkRecord(
  root: string,
  category: "runs" | "scorecards",
  id: string,
  value: BenchmarkRun | PromotionScorecard,
): Promise<Result<void, EvolutionError>> {
  try {
    const path = join(root, "benchmarks", category, `${safeStorageKey(id)}.json`);
    await atomicWriteFile(path, `${JSON.stringify(value)}\n`);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: ioError(`persist-benchmark-${category}`, error) };
  }
}

function isBenchmarkRun(value: unknown): value is BenchmarkRun {
  return isRecord(value) && typeof value["id"] === "string" && typeof value["suiteId"] === "string"
    && typeof value["taskId"] === "string" && typeof value["sessionId"] === "string"
    && typeof value["harnessId"] === "string" && isRecord(value["metrics"]);
}

function isPromotionScorecard(value: unknown): value is PromotionScorecard {
  return isRecord(value) && typeof value["id"] === "string" && typeof value["projectId"] === "string"
    && typeof value["suiteId"] === "string" && Array.isArray(value["pairedResults"])
    && isRecord(value["decision"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
