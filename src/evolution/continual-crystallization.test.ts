import { describe, expect, it } from "vitest";

import type {
  HarnessId,
  HarnessManifest,
  ModelRouteSignature,
  ProjectId,
  Sha256,
  Timestamp,
  TokenCount,
  UsdMicros,
} from "../contracts/index.js";
import type { CrystallizationRun } from "./crystallization-benchmark.js";
import { evolveContinualWorkstream } from "./continual-crystallization.js";

const ROUTE = {
  role: "crystallizer",
  providerId: "openrouter",
  modelId: "deepseek/deepseek-v4-flash",
  variant: null,
  servingProvider: "test-provider",
  quantization: null,
  reasoning: { mode: "off" },
  temperature: 0,
  topP: null,
  seed: null,
  contextLimit: 100_000 as TokenCount,
  outputLimit: 6_000 as TokenCount,
  equivalentListPrice: {
    inputUsdMicrosPerMillionTokens: 0 as UsdMicros,
    cachedInputUsdMicrosPerMillionTokens: 0 as UsdMicros,
    outputUsdMicrosPerMillionTokens: 0 as UsdMicros,
  },
} satisfies ModelRouteSignature;

function harness(id: string, parent: HarnessId | null = null): HarnessManifest {
  return {
    id: id as HarnessId,
    projectId: "project_continual" as ProjectId,
    alias: id,
    parents: parent === null ? [] : [parent],
    components: [],
    sourceArtifacts: [],
    createdAt: "2026-07-18T00:00:00.000Z" as Timestamp,
  };
}

function crystallization(cycle: number, sourceIds: readonly string[]): CrystallizationRun {
  return {
    evidenceSha: `${String(cycle).padStart(64, "0")}` as Sha256,
    proposal: {
      reflection: `Reflection ${cycle}`,
      lessons: [{
        sourceIds: [sourceIds.at(-1) ?? "missing"],
        target: "skill",
        title: `Lesson ${cycle}`,
        guidance: `Guidance learned on workday ${cycle}.`,
      }],
    },
    route: ROUTE,
    usage: {
      inputTokens: cycle as TokenCount,
      cachedInputTokens: 0 as TokenCount,
      reasoningTokens: 0 as TokenCount,
      outputTokens: cycle as TokenCount,
      costUsdMicros: cycle as UsdMicros,
    },
  };
}

describe("continual crystallization", () => {
  it("uses every valid workday mutation as the next workday parent without evaluation", async () => {
    const crystallizeParents: HarnessId[] = [];
    const evidenceSizes: number[] = [];
    const installParents: HarnessId[] = [];
    let installed = 0;
    const result = await evolveContinualWorkstream(harness("harness_initial"), {
      async crystallize(parentHarnessId, trajectories) {
        crystallizeParents.push(parentHarnessId);
        evidenceSizes.push(trajectories.length);
        return { ok: true, value: crystallization(evidenceSizes.length, trajectories.map((item) => item.id)) };
      },
      async install(parent) {
        installParents.push(parent.id);
        installed += 1;
        return { ok: true, value: harness(`harness_day_${installed}`, parent.id) };
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(evidenceSizes).toEqual([6, 7, 8, 9, 10]);
    expect(crystallizeParents).toEqual([
      "harness_initial", "harness_day_1", "harness_day_2", "harness_day_3", "harness_day_4",
    ]);
    expect(installParents).toEqual(crystallizeParents);
    expect(result.value.steps.map((step) => step.crystallizationAttempts)).toEqual([1, 1, 1, 1, 1]);
    expect(result.value.steps.map((step) => step.candidateHarnessId)).toEqual([
      "harness_day_1", "harness_day_2", "harness_day_3", "harness_day_4", "harness_day_5",
    ]);
    expect(result.value.finalHarness.id).toBe("harness_day_5");
  });

  it("retries malformed reflection against the same work evidence before advancing", async () => {
    let crystallized = 0;
    let installed = 0;
    const result = await evolveContinualWorkstream(harness("harness_initial"), {
      async crystallize(_parentHarnessId, trajectories) {
        crystallized += 1;
        if (crystallized === 3) {
          return { ok: false, error: {
            kind: "validation",
            message: "Malformed reflection",
            field: "modelOutput",
            recoverable: true,
            callerAction: "fix-request",
          } };
        }
        return { ok: true, value: crystallization(crystallized, trajectories.map((item) => item.id)) };
      },
      async install(parent) {
        installed += 1;
        return { ok: true, value: harness(`harness_day_${installed}`, parent.id) };
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(crystallized).toBe(6);
    expect(installed).toBe(5);
    expect(result.value.steps.map((step) => step.crystallizationAttempts)).toEqual([1, 1, 2, 1, 1]);
  });

  it("stops before exposing a final harness after exhausting malformed-reflection retries", async () => {
    let crystallized = 0;
    let installed = 0;
    const result = await evolveContinualWorkstream(harness("harness_initial"), {
      async crystallize(_parentHarnessId, trajectories) {
        crystallized += 1;
        if (crystallized >= 3) {
          return { ok: false, error: {
            kind: "validation",
            message: "Malformed reflection",
            field: "modelOutput",
            recoverable: true,
            callerAction: "fix-request",
          } };
        }
        return { ok: true, value: crystallization(crystallized, trajectories.map((item) => item.id)) };
      },
      async install(parent) {
        installed += 1;
        return { ok: true, value: harness(`harness_day_${installed}`, parent.id) };
      },
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "validation", field: "modelOutput" }) });
    expect(crystallized).toBe(5);
    expect(installed).toBe(2);
  });
});
