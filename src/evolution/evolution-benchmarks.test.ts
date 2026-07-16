import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  AbsolutePath,
  ArtifactRecord,
  ArtifactId,
  BenchmarkExecutionRequest,
  BenchmarkRun,
  BenchmarkRunLauncher,
  BenchmarkRunId,
  BenchmarkService,
  BenchmarkTaskId,
  ByteCount,
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
  PromotionScorecard,
  SessionId,
  SessionEvent,
  SessionRecord,
  SessionRepository,
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
import { createOmegaBenchManifest, omegaBenchAssets, resolveTrustedOmegaBenchPrivateTask } from "./omega-bench-manifest.js";

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

function fakeCompletedChildRecord(): SessionRecord {
  return {
    ...fakeSessionRecord("evolution-session" as SessionId),
    state: "completed",
    completedAt: timestamp,
    outcome: "succeeded",
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
    completeFromRunner: overrides.complete ?? (() => rejectUnexpected()),
    cancel: overrides.cancel ?? (() => rejectUnexpected()),
    createHandoff: () => rejectUnexpected(),
    recordRunnerEvent: () => rejectUnexpected(),
    publishRunnerEvent: () => undefined,
    subscribe: async function* () { return; },
  };
}

function fakeObjectStore(): ObjectStore {
  return {
    async put(mediaType, chunks) {
      const parts: Uint8Array[] = [];
      for await (const chunk of chunks) parts.push(chunk);
      const content = Buffer.concat(parts);
      return { ok: true, value: {
        hash: createHash("sha256").update(content).digest("hex") as ObjectHash,
        size: content.byteLength as ByteCount,
        mediaType,
        createdAt: timestamp,
      } };
    },
    get: () => rejectUnexpected(),
    describe: () => rejectUnexpected(),
  };
}

function mutationEvents(content = "improved harness guidance", replaceComponentId: ComponentId | null = null): readonly SessionEvent[] {
  const artifact: ArtifactRecord = {
    id: "mutation-output" as ArtifactId,
    kind: "model-response",
    object: {
      hash: createHash("sha256").update(content).digest("hex") as ObjectHash,
      size: Buffer.byteLength(content) as ByteCount,
      mediaType: "application/vnd.omega.model-response+json",
      createdAt: timestamp,
    },
    sessionId: "evolution-session" as SessionId,
    createdAt: timestamp,
    metadata: {},
  };
  return [
    {
      id: "artifact-event" as EventId,
      sequence: 1,
      at: timestamp,
      harnessId: incumbentId,
      payload: { kind: "artifact.recorded", artifact },
    },
    {
      id: "model-event" as EventId,
      sequence: 2,
      at: timestamp,
      harnessId: incumbentId,
      payload: {
        kind: "model.completed",
        aggregateArtifactId: artifact.id,
        completion: {
          streamId: "mutation-stream" as never,
          providerGenerationId: "generation",
          route,
          content: [{
            kind: "text",
            text: JSON.stringify({
              kind: "skill",
              runtime: "document",
              entrypoint: "SKILL.md",
              content,
              replaceComponentId,
            }),
          }],
          usage: {
            inputTokens: 1 as TokenCount,
            cachedInputTokens: 0 as TokenCount,
            reasoningTokens: 0 as TokenCount,
            outputTokens: 1 as TokenCount,
            costUsdMicros: 0 as UsdMicros,
          },
          startedAt: timestamp,
          firstTokenAt: timestamp,
          completedAt: timestamp,
          finishReason: "stop",
        },
      },
    },
  ];
}

function fakeSessionRepository(events: readonly SessionEvent[] = mutationEvents()): SessionRepository {
  return {
    create: () => rejectUnexpected(),
    get: async () => ({ ok: true, value: fakeCompletedChildRecord() }),
    list: () => rejectUnexpected(),
    append: () => rejectUnexpected(),
    read: async (_id, afterSequence, limit) => ({
      ok: true,
      value: events.filter((event) => event.sequence > afterSequence).slice(0, limit),
    }),
    recordArtifact: () => rejectUnexpected(),
    readArtifact: () => rejectUnexpected(),
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

function rejectedScorecard(candidateHarnessId: HarnessId): PromotionScorecard {
  return buildPromotionScorecard({
    projectId,
    incumbentHarnessId: incumbentId,
    candidateHarnessId,
    policy: DEFAULT_CONFIG.benchmarks.developmentPromotionPolicy,
    pairedResults: [],
    expectedPairCount: 10,
    createdAt: timestamp,
  });
}

async function waitForEvolutionTerminal(
  service: ReturnType<typeof createEvolutionService>,
  id: Parameters<ReturnType<typeof createEvolutionService>["get"]>[0],
): Promise<Awaited<ReturnType<ReturnType<typeof createEvolutionService>["get"]>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await service.get(id);
    if (!result.ok || ["promoted", "rejected", "cancelled", "failed"].includes(result.value.state)) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Evolution job did not reach a terminal state");
}

describe("OmegaBench manifest and trusted launcher boundary", () => {
  it("publishes exactly ten public tasks without verifier metadata", () => {
    const manifest = createOmegaBenchManifest(DEFAULT_CONFIG.benchmarks.developmentPromotionPolicy);
    expect(manifest.tasks).toHaveLength(10);
    expect(JSON.stringify(manifest.tasks)).not.toContain("diagnosticTags");
    expect(JSON.stringify(manifest.tasks)).not.toContain("verifierObjectHash");
    expect(manifest.promotionPolicy).toBe(DEFAULT_CONFIG.benchmarks.developmentPromotionPolicy);
    const hashes = new Set(omegaBenchAssets().map((asset) => asset.hash));
    expect(hashes.has(manifest.privateTaskMetadataObjectHash)).toBe(true);
    for (const task of manifest.tasks) {
      expect(hashes.has(task.fixtureObjectHash)).toBe(true);
      expect(hashes.has(task.environmentObjectHash)).toBe(true);
      const privateTask = resolveTrustedOmegaBenchPrivateTask(task.id);
      expect(privateTask).not.toBeNull();
      expect(hashes.has(privateTask?.verifierObjectHash ?? ("missing" as ObjectHash))).toBe(true);
      expect(hashes.has(privateTask?.negativeInvariantObjectHash ?? ("missing" as ObjectHash))).toBe(true);
    }
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

  it("reloads crash-safe benchmark runs and scorecards after service recreation", async () => {
    const root = await mkdtemp(join(tmpdir(), "omega-bench-persistence-"));
    try {
      const harnesses = fakeHarnessRepository([harness(incumbentId), harness(candidateId)]);
      const launcher: BenchmarkRunLauncher = {
        execute: async (request) => ({
          ok: true,
          value: {
            sessionId: `session-${request.harness.id}-${request.task.id}` as SessionId,
            executionPolicyComponentId: "policy" as ComponentId,
            route: { ...request.route, servingProvider: "provider-a", quantization: "fp8" },
            servingProviderGenerationId: "generation",
            outcome: "passed",
            failureCategory: null,
            metrics: run("template", request.harness.id, request.task.id, true).metrics,
            finalDiffArtifactId: `diff-${request.harness.id}-${request.task.id}` as ArtifactId,
            reportArtifactId: `report-${request.harness.id}-${request.task.id}` as ArtifactId,
            startedAt: timestamp,
            completedAt: timestamp,
          },
        }),
      };
      const options = {
        root: root as AbsolutePath,
        objects: fakeObjectStore(),
        sessions: fakeSessionService(),
        harnesses,
        activation: fakeActivation(),
        launcher,
      };
      const first = createBenchmarkService(options);
      const manifest = createOmegaBenchManifest(DEFAULT_CONFIG.benchmarks.developmentPromotionPolicy);
      const evaluated = await first.runPaired(manifest.id, incumbentId, candidateId);
      expect(evaluated.ok).toBe(true);
      if (!evaluated.ok) return;

      const recreated = createBenchmarkService(options);
      const loaded = await recreated.getScorecard(evaluated.value.id);
      const listed = await recreated.listScorecards(projectId, { cursor: null, limit: 10 });
      const runId = evaluated.value.pairedResults[0]?.incumbent.id;
      expect(loaded).toEqual(evaluated);
      expect(listed.ok && listed.value.items).toEqual([evaluated.value]);
      expect(runId).toBeDefined();
      if (runId !== undefined) {
        const canary = await recreated.recordCanary(incumbentId, { kind: "benchmark", benchmarkRunId: runId });
        expect(canary.ok && canary.value.outcome).toBe("healthy");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("propagates abort to the active launcher and never starts another run or promotes", async () => {
    const root = await mkdtemp(join(tmpdir(), "omega-bench-cancel-"));
    try {
      const entered = Promise.withResolvers<void>();
      const execute = vi.fn<BenchmarkRunLauncher["execute"]>(async (_request, signal) => {
        entered.resolve();
        return new Promise((resolve) => {
          const cancelled = (): void => resolve({ ok: false, error: {
            kind: "validation",
            message: "Benchmark evaluation cancelled",
            field: "signal",
            recoverable: true,
            callerAction: "fix-request",
          } });
          if (signal?.aborted === true) cancelled();
          else signal?.addEventListener("abort", cancelled, { once: true });
        });
      });
      const promote = vi.fn<HarnessActivationService["promote"]>(() => rejectUnexpected());
      const controller = new AbortController();
      const service = createBenchmarkService({
        root: root as AbsolutePath,
        objects: fakeObjectStore(),
        sessions: fakeSessionService(),
        harnesses: fakeHarnessRepository([harness(incumbentId), harness(candidateId)]),
        activation: { ...fakeActivation(), promote },
        launcher: { execute },
      });
      const manifest = createOmegaBenchManifest(DEFAULT_CONFIG.benchmarks.developmentPromotionPolicy);
      const evaluating = service.runPaired(manifest.id, incumbentId, candidateId, controller.signal);
      await entered.promise;
      controller.abort("operator cancellation");
      const result = await evaluating;

      expect(result.ok).toBe(false);
      expect(execute).toHaveBeenCalledOnce();
      expect(promote).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks the active-harness commit when cancellation begins during promotion", async () => {
    const root = await mkdtemp(join(tmpdir(), "omega-bench-promote-cancel-"));
    try {
      const enteredPromotion = Promise.withResolvers<void>();
      const releasePromotion = Promise.withResolvers<void>();
      let committed = false;
      const promote = vi.fn<HarnessActivationService["promote"]>(async (_scorecard, commitGuard) => {
        enteredPromotion.resolve();
        await releasePromotion.promise;
        if (commitGuard?.() === false) {
          return { ok: false, error: {
            kind: "conflict",
            resource: "activation-commit-guard",
            expected: "active",
            actual: "cancelled",
            recoverable: true,
            callerAction: "refresh-version-and-retry",
          } };
        }
        committed = true;
        return rejectUnexpected();
      });
      const launcher: BenchmarkRunLauncher = {
        execute: async (request) => {
          const passed = request.harness.id === candidateId;
          return { ok: true, value: {
            sessionId: `session-${request.harness.id}-${request.task.id}` as SessionId,
            executionPolicyComponentId: "policy" as ComponentId,
            route: { ...request.route, servingProvider: "provider-a", quantization: "fp8" },
            servingProviderGenerationId: "generation",
            outcome: passed ? "passed" : "failed",
            failureCategory: passed ? null : "verifier",
            metrics: run("template", request.harness.id, request.task.id, passed).metrics,
            finalDiffArtifactId: `diff-${request.harness.id}-${request.task.id}` as ArtifactId,
            reportArtifactId: `report-${request.harness.id}-${request.task.id}` as ArtifactId,
            startedAt: timestamp,
            completedAt: timestamp,
          } };
        },
      };
      const controller = new AbortController();
      const service = createBenchmarkService({
        root: root as AbsolutePath,
        objects: fakeObjectStore(),
        sessions: fakeSessionService(),
        harnesses: fakeHarnessRepository([harness(incumbentId), harness(candidateId)]),
        activation: { ...fakeActivation(), promote },
        launcher,
      });
      const manifest = createOmegaBenchManifest(DEFAULT_CONFIG.benchmarks.developmentPromotionPolicy);
      const evaluating = service.runPaired(manifest.id, incumbentId, candidateId, controller.signal);
      await enteredPromotion.promise;
      controller.abort("operator cancellation");
      releasePromotion.resolve();
      const result = await evaluating;

      expect(result.ok).toBe(false);
      expect(promote).toHaveBeenCalledOnce();
      expect(committed).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("evolution lifecycle", () => {
  it("persists a child-produced changed component and reloads the terminal job", async () => {
    const root = await mkdtemp(join(tmpdir(), "omega-evolution-persistence-"));
    try {
      const oldComponent: HarnessManifest["components"][number] = {
        id: "old-skill" as ComponentId,
        kind: "skill",
        runtime: "document",
        objectHash: createHash("sha256").update("old guidance").digest("hex") as ObjectHash,
        entrypoint: "SKILL.md",
        credentialEnvNames: [],
        capabilities: [],
      };
      const incumbent = { ...harness(incumbentId), components: [oldComponent] };
      const baseHarnesses = fakeHarnessRepository([incumbent]);
      const storedComponents: HarnessManifest["components"][number][] = [];
      const storedHarnesses: HarnessManifest[] = [];
      const harnesses: HarnessRepository = {
        ...baseHarnesses,
        putComponent: async (component) => {
          storedComponents.push(component);
          return baseHarnesses.putComponent(component);
        },
        putHarness: async (manifest) => {
          storedHarnesses.push(manifest);
          return baseHarnesses.putHarness(manifest);
        },
      };
      const runPaired = vi.fn<BenchmarkService["runPaired"]>(async (_suite, _incumbent, candidate) => ({
        ok: true,
        value: rejectedScorecard(candidate),
      }));
      const sessions = fakeSessionService({
        spawnChild: async () => ({ ok: true, value: fakeChildSession() }),
        cancel: async () => ({ ok: true, value: fakeCompletedChildRecord() }),
      });
      const options = {
        root: root as AbsolutePath,
        objects: fakeObjectStore(),
        repository: fakeSessionRepository(mutationEvents("new crystallized guidance", oldComponent.id)),
        sessions,
        harnesses,
        benchmarks: { ...fakeBenchmarkService(), runPaired },
        activation: fakeActivation(),
      };
      const service = createEvolutionService(options);
      const started = await service.start({
        projectId,
        sourceSessionId: "source" as SessionId,
        goal: "crystallize the successful recovery",
        evidenceArtifactIds: ["source-evidence" as ArtifactId],
        allowedComponentKinds: ["skill"],
        budget: createOmegaBenchManifest(DEFAULT_CONFIG.benchmarks.developmentPromotionPolicy).tasks[0]!.budget,
      }, { ...DEFAULT_CONFIG.sessions.mainCapabilities, createdAt: timestamp });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const terminal = await waitForEvolutionTerminal(service, started.value.id);

      expect(terminal.ok && terminal.value.state).toBe("rejected");
      expect(storedComponents).toHaveLength(1);
      expect(storedComponents[0]?.id).not.toBe(oldComponent.id);
      expect(storedComponents[0]?.objectHash).not.toBe(oldComponent.objectHash);
      expect(storedHarnesses[0]?.components).toEqual([storedComponents[0]]);
      expect(storedHarnesses[0]?.sourceArtifacts).toEqual(["source-evidence", "mutation-output"]);

      const recreated = createEvolutionService(options);
      const loaded = await recreated.get(started.value.id);
      const listed = await recreated.list(projectId, { cursor: null, limit: 10 });
      expect(loaded).toEqual(terminal);
      expect(listed.ok && listed.value.items).toEqual([terminal.ok ? terminal.value : null]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a child mutation that recreates an incumbent component", async () => {
    const root = await mkdtemp(join(tmpdir(), "omega-evolution-noop-"));
    try {
      const content = "unchanged guidance";
      const objectHash = createHash("sha256").update(content).digest("hex") as ObjectHash;
      const canonicalBody = `{"capabilities":[],"credentialEnvNames":[],"entrypoint":"SKILL.md","kind":"skill","objectHash":"${objectHash}","runtime":"document"}`;
      const componentId = `component_${createHash("sha256").update(canonicalBody).digest("hex")}` as ComponentId;
      const incumbent = {
        ...harness(incumbentId),
        components: [{
          id: componentId,
          kind: "skill" as const,
          runtime: "document" as const,
          objectHash,
          entrypoint: "SKILL.md",
          credentialEnvNames: [],
          capabilities: [],
        }],
      };
      const runPaired = vi.fn<BenchmarkService["runPaired"]>(() => rejectUnexpected());
      const service = createEvolutionService({
        root: root as AbsolutePath,
        objects: fakeObjectStore(),
        repository: fakeSessionRepository(mutationEvents(content, componentId)),
        sessions: fakeSessionService({
          spawnChild: async () => ({ ok: true, value: fakeChildSession() }),
          complete: async () => ({ ok: true, value: fakeCompletedChildRecord() }),
        }),
        harnesses: fakeHarnessRepository([incumbent]),
        benchmarks: { ...fakeBenchmarkService(), runPaired },
        activation: fakeActivation(),
      });
      const started = await service.start({
        projectId,
        sourceSessionId: "source" as SessionId,
        goal: "avoid a no-op",
        evidenceArtifactIds: [],
        allowedComponentKinds: ["skill"],
        budget: createOmegaBenchManifest(DEFAULT_CONFIG.benchmarks.developmentPromotionPolicy).tasks[0]!.budget,
      }, { ...DEFAULT_CONFIG.sessions.mainCapabilities, createdAt: timestamp });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const terminal = await waitForEvolutionTerminal(service, started.value.id);
      expect(terminal.ok && terminal.value.state).toBe("failed");
      expect(terminal.ok && terminal.value.candidateHarnessId).toBeNull();
      expect(runPaired).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
      objects: fakeObjectStore(),
      repository: fakeSessionRepository(),
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

  it("aborts an in-flight paired evaluation and waits for its cleanup", async () => {
    const entered = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const observedAbort: boolean[] = [];
    const runPaired = vi.fn<BenchmarkService["runPaired"]>(async (_suite, _incumbent, _candidate, signal) => {
      entered.resolve();
      await new Promise<void>((resolve) => {
        const aborted = (): void => {
          observedAbort.push(signal?.aborted === true);
          void cleanup.promise.then(resolve);
        };
        if (signal?.aborted === true) aborted();
        else signal?.addEventListener("abort", aborted, { once: true });
      });
      return { ok: false, error: {
        kind: "validation",
        message: "Benchmark evaluation cancelled",
        field: "signal",
        recoverable: true,
        callerAction: "fix-request",
      } };
    });
    const sessions = fakeSessionService({
      spawnChild: async () => ({ ok: true, value: fakeChildSession() }),
      cancel: async () => ({ ok: true, value: fakeSessionRecord() }),
      complete: async () => ({ ok: true, value: fakeSessionRecord() }),
    });
    const service = createEvolutionService({
      root: "/tmp/omega" as AbsolutePath,
      objects: fakeObjectStore(),
      repository: fakeSessionRepository(),
      sessions,
      harnesses: fakeHarnessRepository([harness(incumbentId)]),
      benchmarks: { ...fakeBenchmarkService(), runPaired },
      activation: fakeActivation(),
    });
    const started = await service.start({
      projectId,
      sourceSessionId: "source" as SessionId,
      goal: "cancel evaluation",
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
    }, { ...DEFAULT_CONFIG.sessions.mainCapabilities, createdAt: timestamp });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await entered.promise;

    let settled = false;
    const cancelling = service.cancel(started.value.id, "operator cancellation").finally(() => { settled = true; });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(observedAbort).toEqual([true]);
    expect(settled).toBe(false);
    cleanup.resolve();
    const cancelled = await cancelling;
    expect(cancelled.ok && cancelled.value.state).toBe("cancelled");
  });
});
