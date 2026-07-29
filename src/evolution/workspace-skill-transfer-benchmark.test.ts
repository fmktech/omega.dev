import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { ComponentId } from "../contracts/index.js";
import {
  OPERATIONAL_INTERNALIZATION_SCENARIOS,
  WORKSPACE_SKILL_SCENARIOS,
  assessWorkspaceEfficiency,
  renderWorkspaceSkillPrompt,
  scoreWorkspaceSkillRun,
  workspaceBaselineFiles,
} from "./workspace-skill-transfer-benchmark.js";
import {
  summarizeWorkspaceSkillPairs,
  workspaceSkillTransferModelConfig,
} from "../workspace-skill-transfer-benchmark-main.js";

const skillId = "component_project_auth" as ComponentId;

describe("workspace skill transfer benchmark", () => {
  it("changes only the reflection route when Codex subscription evolution is selected", () => {
    const configured = workspaceSkillTransferModelConfig("codex-subscription");
    const defaultMain = DEFAULT_CONFIG.models.routes.find((route) => route.role === "main-coder");
    const configuredMain = configured.routes.find((route) => route.role === "main-coder");
    const crystallizer = configured.routes.find((route) => route.role === "crystallizer");

    expect(configuredMain).toEqual(defaultMain);
    expect(crystallizer).toMatchObject({
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      role: "crystallizer",
    });
    expect(configured.providers).toContainEqual(expect.objectContaining({
      providerId: "openai-codex",
      adapter: "codex-app-server",
      credentialEnvName: null,
    }));
  });

  it("keeps verifier checks and expected files outside the model prompt", () => {
    const scenario = WORKSPACE_SKILL_SCENARIOS[0]!;
    const rendered = JSON.stringify(renderWorkspaceSkillPrompt(scenario, [{
      componentId: skillId,
      name: "auth-workflow",
      description: "Use the project authentication workflow",
      tags: ["auth"],
      relevantPaths: ["config/service.toml" as never],
      appliesWhen: ["authentication runtime settings change"],
      doesNotApplyWhen: ["documentation-only authentication work"],
    }]));

    expect(rendered).toContain(scenario.objective);
    expect(rendered).not.toContain(scenario.expected.runtime);
    expect(rendered).not.toContain("generatedOutputNotWritten");
    expect(rendered).not.toContain("verifierPreserved");
  });

  it("requires a candidate-only skill read and real canonical workflow on positive tasks", () => {
    const scenario = WORKSPACE_SKILL_SCENARIOS[0]!;
    const valid = scoreWorkspaceSkillRun(scenario, {
      condition: "candidate",
      installedComponentIds: [skillId],
      skillReadComponentIds: [skillId],
      fileWrites: ["config/service.toml"],
      processCalls: ["./tools/render-config", "./verify-auth"],
      finalFiles: fixtureFiles(scenario.expected),
    });
    const directGeneratedWrite = scoreWorkspaceSkillRun(scenario, {
      condition: "candidate",
      installedComponentIds: [skillId],
      skillReadComponentIds: [skillId],
      fileWrites: ["config/service.toml", "runtime/defaults.json"],
      processCalls: ["./tools/render-config", "./verify-auth"],
      finalFiles: fixtureFiles(scenario.expected),
    });

    expect(valid).toMatchObject({ workspacePassed: true, retrievalCorrect: true, closedLoopPassed: true });
    expect(directGeneratedWrite).toMatchObject({ workspacePassed: false, closedLoopPassed: false });
  });

  it("fails the adjacent negative control when the skill over-triggers", () => {
    const scenario = WORKSPACE_SKILL_SCENARIOS[2]!;
    const score = scoreWorkspaceSkillRun(scenario, {
      condition: "candidate",
      installedComponentIds: [skillId],
      skillReadComponentIds: [skillId],
      fileWrites: ["docs/auth-troubleshooting.md"],
      processCalls: [],
      finalFiles: fixtureFiles(scenario.expected),
    });

    expect(score).toMatchObject({ workspacePassed: true, retrievalCorrect: false, closedLoopPassed: false });
  });

  it("requires material cost and tool-call effects before calling equivalent capability an improvement", () => {
    expect(assessWorkspaceEfficiency({
      incumbentCostUsdMicros: 10_000,
      candidateCostUsdMicros: 8_500,
      incumbentToolCalls: 100,
      candidateToolCalls: 70,
    })).toMatchObject({ effectMet: true, costReduction: 0.15, toolCallReduction: 0.3 });
    expect(assessWorkspaceEfficiency({
      incumbentCostUsdMicros: 10_000,
      candidateCostUsdMicros: 9_500,
      incumbentToolCalls: 100,
      candidateToolCalls: 70,
    }).effectMet).toBe(false);
  });

  it("distinguishes first-action macOS application from recovery after the wrong command", () => {
    const scenario = OPERATIONAL_INTERNALIZATION_SCENARIOS[0]!;
    const applied = scoreWorkspaceSkillRun(scenario, {
      condition: "candidate",
      installedComponentIds: [skillId],
      skillReadComponentIds: [skillId],
      fileWrites: ["config/service.toml"],
      processCalls: ["./tools/render-config", "gtimeout 10 sh verify-auth"],
      finalFiles: fixtureFiles(scenario.expected),
    });
    const recovered = scoreWorkspaceSkillRun(scenario, {
      condition: "candidate",
      installedComponentIds: [skillId],
      skillReadComponentIds: [skillId],
      fileWrites: ["config/service.toml"],
      processCalls: ["./tools/render-config", "timeout 10 ./verify-auth", "gtimeout 10 ./verify-auth"],
      finalFiles: fixtureFiles(scenario.expected),
    });

    expect(applied).toMatchObject({ workspacePassed: true, retrievalCorrect: true, closedLoopPassed: true });
    expect(recovered.checks["forbiddenProcessAvoided"]).toBe(false);
    expect(recovered.workspacePassed).toBe(false);
  });

  it("keeps the macOS skill inactive on the Linux negative control", () => {
    const scenario = OPERATIONAL_INTERNALIZATION_SCENARIOS[2]!;
    const inhibited = scoreWorkspaceSkillRun(scenario, {
      condition: "candidate",
      installedComponentIds: [skillId],
      skillReadComponentIds: [],
      fileWrites: ["config/service.toml"],
      processCalls: ["./tools/render-config", "timeout 10 ./verify-auth"],
      finalFiles: fixtureFiles(scenario.expected),
    });
    const leaked = scoreWorkspaceSkillRun(scenario, {
      condition: "candidate",
      installedComponentIds: [skillId],
      skillReadComponentIds: [skillId],
      fileWrites: ["config/service.toml"],
      processCalls: ["./tools/render-config", "gtimeout 10 ./verify-auth"],
      finalFiles: fixtureFiles(scenario.expected),
    });

    expect(inhibited).toMatchObject({ workspacePassed: true, retrievalCorrect: true, closedLoopPassed: true });
    expect(leaked).toMatchObject({ workspacePassed: false, retrievalCorrect: false, closedLoopPassed: false });
  });

  it("never reports positive transfer from a partial benchmark", () => {
    const oneGain = {
      scenarioId: "workspace-auth-timeout",
      comparable: true,
      closedLoopDelta: 1,
      incumbent: {
        score: { workspacePassed: false },
        usage: { costUsdMicros: 100 },
        toolCalls: 10,
      },
      candidate: {
        score: { workspacePassed: true, closedLoopPassed: true, retrievalCorrect: true },
        usage: { costUsdMicros: 50 },
        toolCalls: 5,
      },
    } as unknown as import("./workspace-skill-transfer-benchmark.js").WorkspaceSkillPair;

    expect(summarizeWorkspaceSkillPairs([oneGain], 9).positiveTransfer).toBe(false);
  });
});

function fixtureFiles(expected: { readonly config: string; readonly runtime: string; readonly documentation: string }) {
  return {
    ...workspaceBaselineFiles(),
    "config/service.toml": expected.config,
    "runtime/defaults.json": expected.runtime,
    "docs/auth-troubleshooting.md": expected.documentation,
  };
}
