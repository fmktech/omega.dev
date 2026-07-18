import { describe, expect, it } from "vitest";

import type { HarnessId, ModelRouter } from "../contracts/index.js";
import {
  compileProjectExperience,
  crystallizeWorkTrajectories,
  parseCrystallizationProposal,
  renderCrystallizationPrompt,
  type CrystallizationProposal,
  type WorkTrajectory,
} from "./crystallization-benchmark.js";

function trajectory(overrides: Partial<WorkTrajectory> = {}): WorkTrajectory {
  return {
    id: "daily-cafe-check",
    projectContext: "A café service with UTF-8 paths such as services/café.",
    objective: "Repair the local formatter.",
    timeline: ["The familiar command failed.", "Project guidance named ./outil vérifier.", "The declared command exited 0. ✅"],
    locallyObservedResult: "The local project check succeeded.",
    ...overrides,
  };
}

function proposal(value: Partial<CrystallizationProposal> = {}): CrystallizationProposal {
  return {
    reflection: "The process showed that repository guidance should override familiar defaults.",
    lessons: [{
      sourceIds: ["daily-cafe-check"],
      target: "skill",
      title: "Discover the project check",
      guidance: "Read scoped project guidance and use the repository-declared check before assuming a standard command.",
    }],
    ...value,
  };
}

describe("crystallization benchmark", () => {
  it("canonicalizes duplicate process evidence while preserving UTF-8 content", () => {
    const second = trajectory({ id: "daily-zebra-check", objective: "Run zèbre." });
    const result = renderCrystallizationPrompt([second, trajectory(), trajectory()]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prompt).toContain("services/café");
    expect(result.value.prompt.indexOf("daily-cafe-check")).toBeLessThan(result.value.prompt.indexOf("daily-zebra-check"));
    expect(result.value.prompt.match(/daily-cafe-check/gu)).toHaveLength(1);
    expect(result.value.evidenceSha).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ["OmegaBench identifier", "An OmegaBench task appeared."],
    ["scorecard", "The scorecard said yes."],
    ["hidden verifier", "A hidden-verifier expected a file."],
    ["promotion decision", "The promotion decision was reject."],
    ["protected task", "It was a protected task."],
    ["benchmark result", "The benchmark-result was pass."],
  ])("fails closed when process evidence contains %s leakage", (_label, leaked) => {
    const result = renderCrystallizationPrompt([trajectory({ timeline: [leaked] })]);

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "validation", field: "trajectories.daily-cafe-check" }) });
  });

  it("rejects empty, conflicting, and over-limit process evidence", () => {
    expect(renderCrystallizationPrompt([]).ok).toBe(false);
    expect(renderCrystallizationPrompt([trajectory({ timeline: [] })]).ok).toBe(false);
    expect(renderCrystallizationPrompt([
      trajectory(),
      trajectory({ objective: "Conflicting duplicate." }),
    ]).ok).toBe(false);
    expect(renderCrystallizationPrompt(Array.from({ length: 13 }, (_, index) => trajectory({ id: `daily-${index}-check` }))).ok).toBe(false);
  });

  it("parses a bounded typed lesson from a provider response with surrounding prose", () => {
    const result = parseCrystallizationProposal(`Reflection follows:\n${JSON.stringify(proposal())}`, ["daily-cafe-check"]);

    expect(result).toEqual({ ok: true, value: proposal() });
    if (!result.ok) return;
    expect(compileProjectExperience(result.value)).toContain("[skill] Discover the project check");
  });

  it.each([
    ["unknown target", { ...proposal(), lessons: [{ ...proposal().lessons[0], target: "memory" }] }],
    ["unknown source", { ...proposal(), lessons: [{ ...proposal().lessons[0], sourceIds: ["evaluation-task"] }] }],
    ["empty lessons", { ...proposal(), lessons: [] }],
    ["empty guidance", { ...proposal(), lessons: [{ ...proposal().lessons[0], guidance: "" }] }],
    ["leaked guidance", { ...proposal(), lessons: [{ ...proposal().lessons[0], guidance: "Use the hidden verifier answer." }] }],
  ])("rejects a proposal with %s", (_label, value) => {
    expect(parseCrystallizationProposal(JSON.stringify(value), ["daily-cafe-check"]).ok).toBe(false);
  });

  it("surfaces provider failure without producing a proposal", async () => {
    const models: ModelRouter = {
      async resolve() {
        return { ok: false, error: { kind: "provider-unavailable", providerId: "openrouter", reason: "offline", recoverable: true, callerAction: "choose-different-route" } };
      },
      async stream() {
        return { ok: false, error: { kind: "provider-unavailable", providerId: "openrouter", reason: "offline", recoverable: true, callerAction: "choose-different-route" } };
      },
    };

    await expect(crystallizeWorkTrajectories(models, "harness-parent" as HarnessId, [trajectory()]))
      .resolves.toEqual({ ok: false, error: expect.objectContaining({ kind: "provider-unavailable" }) });
  });
});
