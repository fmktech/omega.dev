import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "./defaults.js";

describe("default benchmark budgets", () => {
  it("leaves headroom above the observed 32-turn HTTP generalization ceiling", () => {
    expect(DEFAULT_CONFIG.benchmarks.syntheticSkillTaskBudget).toMatchObject({
      wallTimeMs: 480_000,
      maxModelCalls: 40,
      maxInputTokens: 360_000,
      maxOutputTokens: 64_000,
      maxProcessStarts: 40,
    });
  });
});
