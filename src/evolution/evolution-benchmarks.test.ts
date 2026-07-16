import { describe, expect, it, vi } from "vitest";

import type {
  AbsolutePath,
  ArtifactId,
  BenchmarkExecutionRequest,
  BenchmarkRun,
  BenchmarkRunLauncher,
  BenchmarkRunId,
  BenchmarkService,
  BenchmarkTaskId,
  CapabilityEnvelope,
  ChildId,
  ChildSessionRecord,
  ComponentId,
  DurationMs,
  EvolutionRequest,
  EventId,
  HarnessActivationService,
  HarnessId,
  HarnessManifest,
  HarnessRepository,
  ModelRouteSignature,
  ObjectHash,
  ObjectStore,
  ProjectId,
  PromotionEvalPolicy,
  SessionId,
  SessionRecord,
  SessionService,
  ThreadId,
  Timestamp,
  TokenCount,
  UsdMicros,
  WorkspaceId,
} from "../contracts/index.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { createBenchmarkService } from "./benchmark-service.js";
import { createEvolutionService } from "./evolution-service.js";
import { assessPromotion, buildPromotionScorecard, findPairInvalidReason, pairReplicateRuns } from "./promotion-evaluator.js";
import { createOmegaBenchManifest } from "./omega-bench-manifest.js";

const timestamp = "2026-07-16T00:00:00.000Z" as Timestamp;
const projectId = "project" as ProjectId;
const incumbentId = "incumbent" as HarnessId;
const candidateId = "candidate" as HarnessId;

const route: ModelRouteSignature = {
  role: "promotion-evaluator",
  providerId: "openrouter",
  modelId: "model",
  variant: "free",
  servingProvider: "provider-a",
  quantization: "fp8",
  reasoning: { mode: "off" },
  temperature: 0,
  topP: null,
  seed: 7,
  contextLimit: 100 as TokenCount,
  outputLimit: 20 as TokenCount,
  equivalentListPrice: {
    inputUsdMicrosPerMillionTokens: 1 as UsdMicros,
    cachedInputUsdMicrosPerMillionTokens: 1 as UsdMicros,
    outputUsdMicrosPerMillionTokens: 1 as UsdMicros,
  },
};

function run(id: string, harnessId: HarnessId, taskId: BenchmarkTaskId, passed: boolean): BenchmarkRun {
  return {
    id: id as BenchmarkRunId,
    suiteId: "omegabench-10@1" as BenchmarkRun["suiteId"],
    taskId,
    sessionId: `session-${id}` as SessionId,
    harnessId,
    harnessComponentObjectHashes: ["component-hash" as ObjectHash],
    executionPolicyComponentId: "policy" as ComponentId,
    route,
    servingProviderGenerationId: "generation",
    fixtureObjectHash: "fixture" as ObjectHash,
    environmentObjectHash: "environment" as ObjectHash,
    effectiveBudget: {
      wallTimeMs: 100 as DurationMs,
      maxModelCalls: 1,
      maxInputTokens: 100 as TokenCount,
      maxOutputTokens: 20 as TokenCount,
      maxCostUsdMicros: 0 as UsdMicros,
      maxProcessStarts: 1,
    },
    benchmarkManifestVersion: "1",
    promotionPolicyId: "policy@1",
    outcome: passed ? "passed" : "failed",
    failureCategory: passed ? null : "verifier",
    metrics: {
      verifierPassed: passed,
      negativeInvariantsPassed: true,
      usage: {
        inputTokens: 1 as TokenCount,
        cachedInputTokens: 0 as TokenCount,
        reasoningTokens: 0 as TokenCount,
        outputTokens: 1 as TokenCount,
        costUsdMicros: 0 as UsdMicros,
      },
      equivalentListPriceUsdMicros: 10 as UsdMicros,
      wallTimeMs: 100 as DurationMs,
      timeToFirstTokenMs: 1 as DurationMs,
      generationTimeMs: 10 as DurationMs,
      modelTurns: 1,
      toolCalls: 1,
      processStarts: 1,
      staleWrites: 0,
      policyAllows: 1,
      policyDenials: 0,
      policyEscalations: 0,
      retries: 0,
      childSessions: 0,
      harnessUpdates: 0,
    },
    finalDiffArtifactId: `diff-${id}` as ArtifactId,
    reportArtifactId: `report-${id}` as ArtifactId,
    startedAt: timestamp,
    completedAt: timestamp,
  };
}

function harness(id: HarnessId): HarnessManifest {
  return {
    id,
    projectId,
    alias: id,
    parents: id === candidateId ? [incumbentId] : [],
    components: [],
    sourceArtifacts: [],
    createdAt: timestamp,
  };
}

function rejectUnexpected<T>(): Promise<T> {
  return Promise.reject(new Error("Unexpected fake collaborator call"));
}

function fakeSessionRecord(id = "session" as SessionId): SessionRecord {
  return {
    header: {
      id,
      threadId: "thread" as ThreadId,
      parentSessionId: null,
      continuation: null,
      projectId,
      workspaceId: "workspace" as WorkspaceId,
      role: "main",
      objective: "test",
      initialHarnessId: incumbentId,
      initialModelRoutes: [],
      policyProfile: "guarded",
      capabilityEnvelope: { ...DEFAULT_CONFIG.sessions.mainCapabilities, createdAt: timestamp },
      credentialEnvNames: [],
      eventSchemaVersion: 1,
      createdAt: timestamp,
    },
    state: "running",
    lastSequence: 0,
    completedAt: null,
    outcome: null,
  };
}

function fakeChildSession(): ChildSessionRecord {
  return {
    childId: "child" as ChildId,
    sessionId: "evolution-session" as SessionId,
    parentSessionId: "source" as SessionId,
    spawnEventId: "event" as EventId,
    role: "evolution",
    state: "running",
  };
}

function fakeHarnessRepository(initial: readonly HarnessManifest[]): HarnessRepository {
  const manifests = new Map(initial.map((manifest) => [manifest.id, manifest] as const));
  return {
    putComponent: async (component) => ({ ok: true, value: component }),
    putHarness: async (manifest) => {
      manifests.set(manifest.id, manifest);
      return { ok: true, value: manifest };
    },
    getHarness: async (id) => {
      const manifest = manifests.get(id);
      return manifest === undefined
        ? { ok: false, error: { kind: "not-found", resource: "harness", id, recoverable: false, callerAction: "propagate" } }
        : { ok: true, value: manifest };
    },
    getActiveHarness: async () => {
      const manifest = manifests.values().next().value;
      return manifest === undefined
        ? { ok: false, error: { kind: "not-found", resource: "harness", id: "active", recoverable: false, callerAction: "propagate" } }
        : { ok: true, value: manifest };
    },
    listProjectHarnesses: async (requestedProjectId, page) => ({
      ok: true,
      value: {
        items: [...manifests.values()].filter((manifest) => manifest.projectId === requestedProjectId).slice(0, page.limit),
        nextCursor: null,
      },
    }),
  };
}

function fakeSessionService(
  overrides: Partial<Pick<SessionService, "spawnChild" | "cancel" | "complete">> = {},
): SessionService {
  return {
    startTask: () => rejectUnexpected(),
    startBenchmarkTask: () => rejectUnexpected(),
    resumeThread: () => rejectUnexpected(),
    spawnChild: overrides.spawnChild ?? (() => rejectUnexpected()),
    complete: overrides.complete ?? (() => rejectUnexpected()),
    cancel: overrides.cancel ?? (() => rejectUnexpected()),
    createHandoff: () => rejectUnexpected(),
    subscribe: async function* () { return; },
  };
}

function fakeObjectStore(): ObjectStore {
  return {
    put: () => rejectUnexpected(),
    get: () => rejectUnexpected(),
    describe: () => rejectUnexpected(),
  };
}

function fakeActivation(): HarnessActivationService {
  return {
    promote: () => rejectUnexpected(),
    pin: () => rejectUnexpected(),
    rollback: () => rejectUnexpected(),
  };
}

function fakeBenchmarkService(): BenchmarkService {
  return {
    getManifest: () => rejectUnexpected(),
    runTask: () => rejectUnexpected(),
    runPaired: () => rejectUnexpected(),
    getScorecard: () => rejectUnexpected(),
    listScorecards: () => rejectUnexpected(),
    recordCanary: () => rejectUnexpected(),
  };
}

describe("OmegaBench manifest and trusted launcher boundary", () => {
  it("publishes exactly ten public tasks without verifier metadata", () => {
    const manifest = createOmegaBenchManifest(DEFAULT_CONFIG.benchmarks.developmentPromotionPolicy);
    expect(manifest.tasks).toHaveLength(10);
    expect(JSON.stringify(manifest.tasks)).not.toContain("diagnosticTags");
    expect(JSON.stringify(manifest.tasks)).not.toContain("verifierObjectHash");
    expect(manifest.promotionPolicy).toBe(DEFAULT_CONFIG.benchmarks.developmentPromotionPolicy);
  });

  it("passes private metadata only through the trusted launcher request", async () => {
    const captured: BenchmarkExecutionRequest[] = [];
    const launcher: BenchmarkRunLauncher = {
      execute: async (request) => {
        captured.push(request);
        return { ok: true, value: {
          sessionId: "benchmark-session" as SessionId,
          executionPolicyComponentId: "policy" as ComponentId,
          route,
          servingProviderGenerationId: "generation",
          outcome: "passed",
          failureCategory: null,
          metrics: run("template", incumbentId, request.task.id, true).metrics,
          finalDiffArtifactId: "diff" as ArtifactId,
          reportArtifactId: "report" as ArtifactId,
          startedAt: timestamp,
          completedAt: timestamp,
        } };
      },
    };
    const harnesses = fakeHarnessRepository([harness(incumbentId)]);
    const service = createBenchmarkService({
      root: "/tmp/omega" as AbsolutePath,
      objects: fakeObjectStore(),
      sessions: fakeSessionService(),
      harnesses,
      activation: fakeActivation(),
      launcher,
    });
    const manifest = createOmegaBenchManifest(DEFAULT_CONFIG.benchmarks.developmentPromotionPolicy);
    const result = await service.runTask(manifest.id, manifest.tasks[0]?.id ?? ("missing" as BenchmarkTaskId), incumbentId, route);
    expect(result.ok).toBe(true);
    expect(captured[0]?.privateTask.diagnosticTags.length).toBeGreaterThan(0);
    expect(JSON.stringify(captured[0]?.task)).not.toContain("diagnosticTags");
  });
});

describe("paired promotion evaluation", () => {
  const taskId = "offline-dependency@1" as BenchmarkTaskId;
  const policy: PromotionEvalPolicy = {
    id: "policy@1",
    version: "1",
    replicatesPerHarness: 1,
    thresholds: { minimumComparablePairs: 1, minimumSuccessRateDelta: 1, maximumProtectedRegressions: 0, confidenceLevel: 0.8 },
    protectedTaskIds: [taskId],
    workspaceBaseline: "fixture-object-hash",
    comparisonOrder: ["invariants", "capability", "cost", "latency"],
  };

  it("invalidates actual provider, quantization, fixture, budget, policy, and component mismatches", () => {
    const incumbent = run("i", incumbentId, taskId, true);
    expect(findPairInvalidReason(incumbent, { ...run("c", candidateId, taskId, true), route: { ...route, servingProvider: "provider-b" } })).toBe("different-serving-provider");
    expect(findPairInvalidReason(incumbent, { ...run("c", candidateId, taskId, true), route: { ...route, quantization: "int8" } })).toBe("different-quantization");
    expect(findPairInvalidReason(incumbent, { ...run("c", candidateId, taskId, true), fixtureObjectHash: "other" as ObjectHash })).toBe("different-fixture");
    expect(findPairInvalidReason(incumbent, { ...run("c", candidateId, taskId, true), effectiveBudget: { ...incumbent.effectiveBudget, maxModelCalls: 2 } })).toBe("different-budget");
    expect(findPairInvalidReason(incumbent, { ...run("c", candidateId, taskId, true), executionPolicyComponentId: "other" as ComponentId })).toBe("different-policy");
    expect(findPairInvalidReason(incumbent, { ...run("c", candidateId, taskId, true), harnessComponentObjectHashes: ["other" as ObjectHash] })).toBe("different-component-set");
    expect(pairReplicateRuns([incumbent], [run("c1", candidateId, taskId, true), run("c2", candidateId, taskId, true)])[0]?.invalidReason).toBe("unequal-replicates");
  });

  it("promotes at the effect threshold and rejects a protected regression", () => {
    const improvement = pairReplicateRuns([run("i", incumbentId, taskId, false)], [run("c", candidateId, taskId, true)]);
    expect(assessPromotion(improvement, policy, 1).decision.outcome).toBe("promote");
    expect(buildPromotionScorecard({
      projectId,
      incumbentHarnessId: incumbentId,
      candidateHarnessId: candidateId,
      policy,
      pairedResults: improvement,
      expectedPairCount: 1,
      createdAt: timestamp,
    }).evaluatorHarnessId).toBe(incumbentId);

    const regression = pairReplicateRuns([run("i2", incumbentId, taskId, true)], [run("c2", candidateId, taskId, false)]);
    const permissive = { ...policy, thresholds: { ...policy.thresholds, minimumSuccessRateDelta: -1 } };
    expect(assessPromotion(regression, permissive, 1).decision.outcome).toBe("reject");
  });
});

describe("evolution lifecycle", () => {
  it("cancels the child and prevents queued work from advancing", async () => {
    const cancelSession: SessionService["cancel"] = vi.fn(async () => ({ ok: true as const, value: fakeSessionRecord() }));
    const sessions = fakeSessionService({
      spawnChild: async () => ({ ok: true, value: fakeChildSession() }),
      cancel: cancelSession,
      complete: async () => ({ ok: true, value: fakeSessionRecord() }),
    });
    const harnesses = fakeHarnessRepository([harness(incumbentId)]);
    const service = createEvolutionService({
      root: "/tmp/omega" as AbsolutePath,
      sessions,
      harnesses,
      benchmarks: fakeBenchmarkService(),
      activation: fakeActivation(),
    });
    const request: EvolutionRequest = {
      projectId,
      sourceSessionId: "source" as SessionId,
      goal: "crystallize the successful recovery",
      evidenceArtifactIds: [],
      allowedComponentKinds: ["skill"],
      budget: DEFAULT_CONFIG.benchmarks.fallbackBudget ?? {
        wallTimeMs: 1 as DurationMs,
        maxModelCalls: 1,
        maxInputTokens: 1 as TokenCount,
        maxOutputTokens: 1 as TokenCount,
        maxCostUsdMicros: 0 as UsdMicros,
        maxProcessStarts: 1,
      },
    };
    const capabilities = { ...DEFAULT_CONFIG.sessions.mainCapabilities, createdAt: timestamp } satisfies CapabilityEnvelope;
    const started = await service.start(request, capabilities);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const cancelled = await service.cancel(started.value.id, "operator cancellation");
    expect(cancelled.ok && cancelled.value.state).toBe("cancelled");
    expect(cancelSession).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const observed = await service.get(started.value.id);
    expect(observed.ok && observed.value.state).toBe("cancelled");
  });
});
