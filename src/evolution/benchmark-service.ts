import { randomUUID } from "node:crypto";

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
  Timestamp,
} from "../contracts/index.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { recordCanaryEvidence } from "./canary-monitor.js";
import { buildPromotionScorecard, pairReplicateRuns } from "./promotion-evaluator.js";
import { createOmegaBenchManifest, resolveTrustedOmegaBenchPrivateTask } from "./omega-bench-manifest.js";

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

  async function getManifest(id: BenchmarkSuiteId): Promise<Result<BenchmarkManifest, EvolutionError>> {
    if (id !== manifest.id) return { ok: false, error: notFound("benchmark-manifest", id) };
    return { ok: true, value: manifest };
  }

  async function runTaskWithHarness(
    taskId: BenchmarkTaskId,
    harness: HarnessManifest,
    route: ModelRouteSignature,
  ): Promise<Result<BenchmarkRun, EvolutionError>> {
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
    });
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
    runs.set(run.id, run);
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
  ): Promise<Result<PromotionScorecard, EvolutionError>> {
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
        const incumbentRun = await runTaskWithHarness(task.id, incumbent.value, route);
        if (!incumbentRun.ok) return incumbentRun;
        incumbentRuns.push(incumbentRun.value);

        const candidateRun = await runTaskWithHarness(task.id, candidate.value, route);
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
    scorecards.set(scorecard.id, scorecard);

    if (scorecard.decision.outcome === "promote") {
      const activated = await options.activation.promote({ ...scorecard, decision: scorecard.decision });
      if (!activated.ok) return activated;
    }
    return { ok: true, value: scorecard };
  }

  async function getScorecard(id: ScorecardId): Promise<Result<PromotionScorecard, EvolutionError>> {
    const scorecard = scorecards.get(id);
    return scorecard === undefined
      ? { ok: false, error: notFound("promotion-scorecard", id) }
      : { ok: true, value: scorecard };
  }

  async function listScorecards(
    projectId: HarnessManifest["projectId"],
    page: PageRequest,
  ): Promise<Result<Page<PromotionScorecard>, EvolutionError>> {
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
    recordCanary: (harnessId, source) => recordCanaryEvidence({
      harnessId,
      source,
      benchmarkRuns: runs,
      harnesses: options.harnesses,
      activation: options.activation,
    }),
  };
};
