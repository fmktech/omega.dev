import { describe, expect, it } from "vitest";

import type { ComponentId } from "../contracts/index.js";
import { assessOperationalInternalization } from "./operational-internalization-benchmark.js";
import type { ReflectionRun } from "./reflection-benchmark.js";
import type { InstalledTransferSkill } from "./reflection-skill-transfer-benchmark.js";
import type { WorkspaceSkillPair, WorkspaceSkillRun } from "./workspace-skill-transfer-benchmark.js";

const componentId = "component_operational" as ComponentId;

describe("operational internalization assessment", () => {
  it("reports worked only when behavior transfers, scope holds, and no measured dimension regresses", () => {
    const result = assessOperationalInternalization({ reflection: reflection(), installedSkills: skills(), pairs: successfulPairs() });

    expect(result.verdict).toBe("worked");
    expect(result.dimensions).toHaveLength(15);
    expect(result.dimensions.every((dimension) => dimension.comparison !== "regressed")).toBe(true);
    expect(result.dimensions.find((dimension) => dimension.id === "application")).toMatchObject({ met: true, candidate: 2, incumbent: 0 });
    expect(result.dimensions.find((dimension) => dimension.id === "scope")?.met).toBe(true);
  });

  it("reports mixed when behavior works but model economy regresses", () => {
    const pairs = successfulPairs();
    const expensive = pairs.map((pair) => ({
      ...pair,
      candidate: { ...pair.candidate, usage: { ...pair.candidate.usage, costUsdMicros: 10_000 } },
    })) as WorkspaceSkillPair[];

    const result = assessOperationalInternalization({ reflection: reflection(), installedSkills: skills(), pairs: expensive });

    expect(result.verdict).toBe("mixed");
    expect(result.dimensions.find((dimension) => dimension.id === "model-economy")?.comparison).toBe("regressed");
  });

  it("reports failed when the candidate merely recovers after repeating the learned command error", () => {
    const pairs = successfulPairs();
    const repeated = pairs.map((pair) => pair.scenarioId.startsWith("operational-macos") ? {
      ...pair,
      candidate: { ...pair.candidate, processCalls: ["timeout 10 ./verify-auth", "gtimeout 10 ./verify-auth"] },
    } : pair) as WorkspaceSkillPair[];

    const result = assessOperationalInternalization({ reflection: reflection(), installedSkills: skills(), pairs: repeated });

    expect(result.verdict).toBe("failed");
    expect(result.dimensions.find((dimension) => dimension.id === "application")?.met).toBe(false);
    expect(result.dimensions.find((dimension) => dimension.id === "internalization")?.met).toBe(false);
  });
});

function successfulPairs(): WorkspaceSkillPair[] {
  return [
    pair("operational-macos-timeout", ["timeout 10 ./verify-auth"], ["gtimeout 10 sh verify-auth"], false, true, 1),
    pair("operational-macos-lockout", ["timeout 10 ./verify-auth"], ["gtimeout 10 sh ./verify-auth"], false, true, 2),
    pair("operational-linux-negative-control", ["timeout 10 ./verify-auth"], ["timeout 10 ./verify-auth"], true, true, 3),
  ];
}

function pair(
  scenarioId: string,
  incumbentCommands: readonly string[],
  candidateCommands: readonly string[],
  incumbentPassed: boolean,
  candidatePassed: boolean,
  index: number,
): WorkspaceSkillPair {
  const incumbent = run(scenarioId, "incumbent", incumbentCommands, [], incumbentPassed, `incumbent-${index}`, 8, 2_000, 2_000);
  const candidateReads = scenarioId.endsWith("negative-control") ? [] : [componentId];
  const candidate = run(scenarioId, "candidate", candidateCommands, candidateReads, candidatePassed, `candidate-${index}`, 6, 1_000, 1_000);
  return {
    scenarioId,
    replicate: 1,
    incumbent,
    candidate,
    comparable: true,
    invalidReason: null,
    workspaceDelta: candidatePassed === incumbentPassed ? 0 : candidatePassed ? 1 : -1,
    closedLoopDelta: candidatePassed === incumbentPassed ? 0 : candidatePassed ? 1 : -1,
  };
}

function run(
  scenarioId: string,
  condition: WorkspaceSkillRun["condition"],
  processCalls: readonly string[],
  skillReadComponentIds: readonly ComponentId[],
  workspacePassed: boolean,
  sessionId: string,
  toolCalls: number,
  costUsdMicros: number,
  elapsedMs: number,
): WorkspaceSkillRun {
  return {
    scenarioId,
    condition,
    sessionId,
    processCalls,
    skillReadComponentIds,
    toolErrors: condition === "incumbent" && scenarioId.startsWith("operational-macos") ? ["command not found: timeout"] : [],
    toolCalls,
    elapsedMs,
    usage: { inputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, outputTokens: 0, costUsdMicros },
    score: {
      workspacePassed,
      retrievalCorrect: condition === "incumbent" || (scenarioId.endsWith("negative-control") ? skillReadComponentIds.length === 0 : skillReadComponentIds.length === 1),
      closedLoopPassed: workspacePassed,
      checks: {},
    },
  } as unknown as WorkspaceSkillRun;
}

function reflection(): ReflectionRun {
  return {
    score: { dimensions: { grounded: true, concepts: [true, true, true] } },
  } as unknown as ReflectionRun;
}

function skills(): readonly InstalledTransferSkill[] {
  return [{
    catalog: {
      componentId,
      name: "macos-timeout",
      description: "Use gtimeout on the development Mac",
      tags: [],
      relevantPaths: [],
      appliesWhen: ["running a deadline command on macOS"],
      doesNotApplyWhen: ["inside Linux"],
    },
    markdown: "# macOS timeout",
  }];
}
