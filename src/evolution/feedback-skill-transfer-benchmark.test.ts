import { describe, expect, it } from "vitest";

import type { ModelUsage, TokenCount, UsdMicros } from "../contracts/index.js";
import {
  FEEDBACK_TRANSFER_FIXTURES,
  compareFeedbackTransferEpisodes,
  evaluatorFeedback,
  evaluatorFeedbackForRun,
  feedbackTrainingFixture,
  type FeedbackEpisode,
} from "./feedback-skill-transfer-benchmark.js";
import { calibrateCustomTypeScriptTestFixture } from "./typescript-test-quality-benchmark.js";

describe("feedback-to-skill transfer benchmark", () => {
  it("starts every task from a vague request without evaluator answers", () => {
    const training = feedbackTrainingFixture();
    const objectives = ["Create good tests for src/plan-dispatch.ts. Do not modify production code.", ...FEEDBACK_TRANSFER_FIXTURES.map((item) => item.objective)];

    expect(training.fixture.files["README.md"]).not.toContain("Public contract");
    for (const objective of objectives) {
      expect(objective).toMatch(/^Create good tests for /u);
      expect(objective).not.toMatch(/mutation|atomic|boundary|duplicate|preflight/iu);
    }
  });

  it("turns hidden failures into user-like procedural feedback without exposing patches", () => {
    const feedback = evaluatorFeedback(["exact-capacity", "capacity-atomicity", "reserve-failure"]);

    expect(feedback).toContain("both sides of each boundary");
    expect(feedback).toContain("earlier ordered item");
    expect(feedback).toContain("dependency write failure");
    expect(feedback).not.toContain("capacity-atomicity");
    expect(feedback).not.toContain("reserve-failure");
  });

  it("requires correctness before fewer feedback rounds count as transfer", () => {
    const incumbent = episode({ firstKills: 2, finalKills: 4, total: 4, feedback: 2, errors: 0, reached: true });
    const efficientCandidate = episode({ firstKills: 2, finalKills: 4, total: 4, feedback: 1, errors: 0, reached: true });
    const incorrectCandidate = episode({ firstKills: 3, finalKills: 3, total: 4, feedback: 0, errors: 0, reached: false });

    expect(compareFeedbackTransferEpisodes(incumbent, efficientCandidate).transferImproved).toBe(true);
    expect(compareFeedbackTransferEpisodes(incumbent, incorrectCandidate).transferImproved).toBe(false);
  });

  it("continues correction when mutations are killed but the suite does not typecheck", () => {
    const run = qualityRun({ typecheckPass: false, survivors: [] });

    expect(evaluatorFeedbackForRun(run)).toContain("fails strict TypeScript compilation");
  });

  it("calibrates every learning and transfer fixture against weak and reference controls", async () => {
    const training = feedbackTrainingFixture();
    const fixtures = [training, ...FEEDBACK_TRANSFER_FIXTURES];
    for (const item of fixtures) {
      const calibration = await calibrateCustomTypeScriptTestFixture(item.fixture, item.referenceFiles);
      expect(calibration.seed.nativePass, item.fixture.id).toBe(true);
      expect(calibration.seed.killedMutationIds.length, item.fixture.id).toBeLessThan(item.fixture.mutations.length);
      expect(calibration.reference.nativePass, item.fixture.id).toBe(true);
      expect(calibration.reference.killedMutationIds, item.fixture.id).toHaveLength(item.fixture.mutations.length);
      expect(calibration.reference.inconclusiveMutationIds, item.fixture.id).toHaveLength(0);
    }
  }, 180_000);
});

function episode(input: { firstKills: number; finalKills: number; total: number; feedback: number; errors: number; reached: boolean }): FeedbackEpisode {
  return {
    fixtureId: "fixture",
    condition: "incumbent",
    rounds: [],
    feedbackCount: input.feedback,
    reachedQuality: input.reached,
    firstAttemptMutationKills: input.firstKills,
    finalMutationKills: input.finalKills,
    totalMutations: input.total,
    modelTurns: 1,
    toolCalls: 1,
    toolErrors: input.errors,
    invalidToolCalls: input.errors,
    usage: zeroUsage(),
    reflectionScenario: {
      id: "fixture-reflection",
      title: "fixture",
      projectContext: "fixture",
      turns: [{ id: "t01", role: "user", content: "fixture" }],
      rubric: { decision: "evolve", target: "skill", requiredSourceIds: ["t01"], concepts: [
        { label: "one", alternatives: ["one"] }, { label: "two", alternatives: ["two"] }, { label: "three", alternatives: ["three"] },
      ], forbiddenClaims: [], maxLessons: 1 },
    },
  };
}

function zeroUsage(): ModelUsage {
  return { inputTokens: 0 as TokenCount, cachedInputTokens: 0 as TokenCount, reasoningTokens: 0 as TokenCount, outputTokens: 0 as TokenCount, costUsdMicros: 0 as UsdMicros };
}

function qualityRun(input: { typecheckPass: boolean; survivors: readonly string[] }) {
  const base = {
    condition: "incumbent" as const,
    replicate: 1,
    harnessId: "harness_test" as import("../contracts/index.js").HarnessId,
    sessionId: "session_test" as import("../contracts/index.js").SessionId,
    route: {
      role: "main-coder" as const, providerId: "openrouter", modelId: "model", variant: null, servingProvider: "provider", quantization: null,
      reasoning: { mode: "effort" as const, effort: "low" as const }, temperature: 0, topP: null, seed: null, contextLimit: 1 as TokenCount, outputLimit: 1 as TokenCount,
      equivalentListPrice: { inputUsdMicrosPerMillionTokens: 0 as UsdMicros, cachedInputUsdMicrosPerMillionTokens: 0 as UsdMicros, outputUsdMicrosPerMillionTokens: 0 as UsdMicros },
    },
    providerGenerationIds: [], usage: zeroUsage(), modelTurns: 1, providerRetries: 0, toolCalls: 0, skillReadComponentIds: [], retrievalCorrect: true,
    fileReads: [], fileWrites: [], processCalls: [], toolErrors: [], response: "done", finalFiles: {}, judge: null,
  };
  const verification = { sourcePreserved: true, nativePass: true, repeatedPass: true, typecheckPass: input.typecheckPass,
    killedMutationIds: [], survivingMutationIds: input.survivors, inconclusiveMutationIds: [],
    runs: [{ label: "typecheck", exitCode: input.typecheckPass ? 0 : 1, stdout: input.typecheckPass ? "" : "TS2322", stderr: "" }] };
  return { ...base, verification, score: { executablePassed: input.typecheckPass, mutationScore: 0, killedMutations: 0, totalMutations: input.survivors.length,
    mutationInfrastructurePassed: true, qualityPassed: false } };
}
