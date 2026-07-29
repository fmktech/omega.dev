import { describe, expect, it } from "vitest";

import type { ComponentId, ModelRouteSignature, TokenCount, UsdMicros } from "../contracts/index.js";
import {
  TEST_QUALITY_MUTATIONS,
  calibrateTypeScriptTestQualityFixture,
  compareTypeScriptTestQualityRuns,
  parseTypeScriptTestJudgeReport,
  renderTypeScriptTestAuthorPrompt,
  scoreTypeScriptTestArtifact,
  typescriptTestFixtureFiles,
  type TypeScriptTestQualityRun,
} from "./typescript-test-quality-benchmark.js";

describe("TypeScript test-quality benchmark", () => {
  it("keeps hidden mutations and judge criteria out of the author prompt", () => {
    const messages = renderTypeScriptTestAuthorPrompt([]);
    const rendered = JSON.stringify(messages);

    expect(rendered).not.toContain("mutation");
    expect(rendered).not.toContain("Gemini");
    expect(rendered).not.toContain("100-point");
    expect(rendered).toContain("Improve the tests");
  });

  it("ships a sparse seed suite and nine effective source mutations", () => {
    const files = typescriptTestFixtureFiles();
    const source = files["src/plan-dispatch.ts"];
    const seed = files["tests/plan-dispatch.test.ts"];

    expect(source).toBeDefined();
    expect(seed?.match(/\btest\s*\(/gu)).toHaveLength(1);
    expect(TEST_QUALITY_MUTATIONS).toHaveLength(9);
    for (const mutation of TEST_QUALITY_MUTATIONS) {
      const mutated = mutation.apply(source ?? "");
      expect(mutated, mutation.id).not.toBe(source);
    }
  });

  it("calibrates the hidden oracle against weak and reference suites", async () => {
    const calibration = await calibrateTypeScriptTestQualityFixture();

    expect(calibration.seed.nativePass).toBe(true);
    expect(calibration.seed.killedMutationIds.length).toBeLessThanOrEqual(2);
    expect(calibration.reference.nativePass).toBe(true);
    expect(calibration.reference.killedMutationIds).toHaveLength(TEST_QUALITY_MUTATIONS.length);
  }, 120_000);

  it("normalizes judge arithmetic from normative finding costs", () => {
    const parsed = parseTypeScriptTestJudgeReport(JSON.stringify({
      total: 99,
      verdict: "Exemplary",
      dimensions: [
        { id: "D1", max: 10, earned: 10, findingIds: [] },
        { id: "D2", max: 20, earned: 20, findingIds: [] },
        { id: "D3", max: 20, earned: 20, findingIds: [] },
        { id: "D4", max: 30, earned: 30, findingIds: [] },
        { id: "D5", max: 10, earned: 10, findingIds: [] },
        { id: "D6", max: 10, earned: 10, findingIds: [] },
      ],
      tests: [{ id: "returns plan", assessment: "behavior assertion" }],
      behaviors: [{ behavior: "returns plan", coverage: "returns plan", mutation: "return empty object" }],
      findings: [], nits: [], caveats: [],
    }));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.total).toBe(100);
      expect(parsed.value.verdict).toBe("Exemplary");
      expect(parsed.value.caveats).toContain("Omega normalized the model-proposed arithmetic using normative fixed deductions, caps, and dimension floors.");
    }
  });

  it("accepts a mechanically consistent machine-readable judge report", () => {
    const parsed = parseTypeScriptTestJudgeReport(JSON.stringify({
      total: 91,
      verdict: "Exemplary",
      dimensions: [
        { id: "D1", max: 10, earned: 10, findingIds: [] },
        { id: "D2", max: 20, earned: 20, findingIds: [] },
        { id: "D3", max: 20, earned: 18, findingIds: ["F1"] },
        { id: "D4", max: 30, earned: 26, findingIds: ["F2"] },
        { id: "D5", max: 10, earned: 9, findingIds: ["F3"] },
        { id: "D6", max: 10, earned: 8, findingIds: ["F4"] },
      ],
      tests: [{ id: "returns plan", assessment: "behavior assertion" }],
      behaviors: [{ behavior: "empty input", coverage: "GAP", mutation: "remove guard" }],
      findings: [
        { id: "F1", classification: "VIOLATION", rubricId: "3.6", deduction: 2, location: "tests/x.test.ts:9", evidence: "weak assertion", fix: "assert fields" },
        { id: "F2", classification: "GAP", rubricId: "4.2", deduction: 4, location: "src/x.ts:12", evidence: "error path gap", fix: "add an error-path test" },
        { id: "F3", classification: "VIOLATION", rubricId: "5.2", deduction: 1, location: "tests/x.test.ts:9", evidence: "generic name", fix: "name the behavior" },
        { id: "F4", classification: "VIOLATION", rubricId: "6.7", deduction: 2, location: "tests/x.test.ts:10", evidence: "uses any", fix: "use a typed fixture" },
      ],
      nits: [], caveats: [],
    }));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.total).toBe(91);
  });

  it("requires executable validity before mutation quality can pass", () => {
    const score = scoreTypeScriptTestArtifact({
      sourcePreserved: true,
      nativePass: true,
      repeatedPass: false,
      typecheckPass: true,
      killedMutationIds: TEST_QUALITY_MUTATIONS.map((mutation) => mutation.id),
      totalMutations: TEST_QUALITY_MUTATIONS.length,
    });

    expect(score.executablePassed).toBe(false);
    expect(score.qualityPassed).toBe(false);
    expect(score.mutationScore).toBe(1);
  });

  it("declares improvement only for comparable valid runs with at least two additional kills", () => {
    const incumbent = run("incumbent", ["empty-list", "zero-units", "maximum-units"]);
    const candidate = run("candidate", ["empty-list", "zero-units", "maximum-units", "rush-window", "exact-capacity"]);
    const comparison = compareTypeScriptTestQualityRuns(incumbent, candidate);

    expect(comparison.comparable).toBe(true);
    expect(comparison.mutationKillDelta).toBe(2);
    expect(comparison.capabilityImproved).toBe(true);
  });

  it("invalidates comparison when the author routes differ", () => {
    const incumbent = run("incumbent", ["empty-list"]);
    const candidate = { ...run("candidate", ["empty-list", "zero-units", "maximum-units"]), route: { ...route(), modelId: "different/model" } };
    const comparison = compareTypeScriptTestQualityRuns(incumbent, candidate);

    expect(comparison.comparable).toBe(false);
    expect(comparison.invalidReason).toBe("different-model");
    expect(comparison.capabilityImproved).toBe(false);
  });
});

function run(condition: TypeScriptTestQualityRun["condition"], killedMutationIds: readonly string[]): TypeScriptTestQualityRun {
  return {
    condition,
    replicate: 1,
    route: route(),
    harnessId: `harness_${condition}` as TypeScriptTestQualityRun["harnessId"],
    sessionId: `session_${condition}` as TypeScriptTestQualityRun["sessionId"],
    providerGenerationIds: [],
    usage: { inputTokens: 0 as TokenCount, cachedInputTokens: 0 as TokenCount, reasoningTokens: 0 as TokenCount, outputTokens: 0 as TokenCount, costUsdMicros: 0 as UsdMicros },
    modelTurns: 1,
    providerRetries: 0,
    toolCalls: 0,
    skillReadComponentIds: condition === "candidate" ? ["component_skill" as ComponentId] : [],
    retrievalCorrect: true,
    fileReads: [],
    fileWrites: [],
    processCalls: [],
    toolErrors: [],
    response: "done",
    finalFiles: {},
    verification: { sourcePreserved: true, nativePass: true, repeatedPass: true, typecheckPass: true, killedMutationIds, survivingMutationIds: [], inconclusiveMutationIds: [], runs: [] },
    score: scoreTypeScriptTestArtifact({ sourcePreserved: true, nativePass: true, repeatedPass: true, typecheckPass: true, killedMutationIds, totalMutations: 9 }),
    judge: null,
  };
}

function route(): ModelRouteSignature {
  return {
    role: "main-coder",
    providerId: "openrouter",
    modelId: "deepseek/deepseek-v4-flash",
    variant: null,
    servingProvider: "GMICloud",
    quantization: null,
    reasoning: { mode: "effort", effort: "high" },
    temperature: 0,
    topP: null,
    seed: null,
    contextLimit: 1_000_000 as TokenCount,
    outputLimit: 16_384 as TokenCount,
    equivalentListPrice: { inputUsdMicrosPerMillionTokens: 0 as UsdMicros, cachedInputUsdMicrosPerMillionTokens: 0 as UsdMicros, outputUsdMicrosPerMillionTokens: 0 as UsdMicros },
  };
}
