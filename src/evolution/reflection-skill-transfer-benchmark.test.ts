import { describe, expect, it } from "vitest";

import type {
  ComponentId,
  HarnessId,
  ModelCompletion,
  ModelRequest,
  ModelRouteSignature,
  ModelRouter,
  ModelStreamId,
  SessionId,
  TokenCount,
  UsdMicros,
} from "../contracts/index.js";
import {
  REFLECTION_SKILL_TRANSFER_SCENARIOS,
  compareSkillTransferPair,
  renderSkillTransferPrompt,
  runSkillTransferScenario,
  scoreSkillTransferResponse,
  type SkillTransferRun,
} from "./reflection-skill-transfer-benchmark.js";

const skillId = "component_auth_skill" as ComponentId;

describe("reflection skill transfer benchmark", () => {
  it("keeps evaluator-only acceptance criteria out of task and catalog prompts", () => {
    const scenario = relevantScenario();
    const rendered = renderSkillTransferPrompt(scenario, [{
      componentId: skillId,
      name: "regenerate-authentication-configuration",
      description: "Regenerate authentication configuration",
      tags: ["reflection", "project-scoped"],
      relevantPaths: [],
    }]);
    const prompt = JSON.stringify(rendered);

    expect(prompt).toContain("regenerate-authentication-configuration");
    expect(prompt).toContain("config/service.toml");
    expect(prompt).not.toContain("requiredConcepts");
    expect(prompt).not.toContain("forbiddenClaims");
    expect(prompt).not.toContain("runtime/defaults.json directly");
  });

  it("requires retrieval and the complete learned procedure on relevant tasks", () => {
    const scenario = relevantScenario();
    const complete = JSON.stringify({
      summary: "Update the canonical auth source and preserve unrelated work.",
      steps: [
        "Edit config/service.toml, not runtime/defaults.json directly.",
        "Run tools/render-config.",
        "Run ./verify-auth and leave the web workspace untouched.",
      ],
      filesTouched: ["config/service.toml", "runtime/defaults.json"],
      commands: ["tools/render-config", "./verify-auth"],
      constraints: ["Do not touch the web workspace"],
    });

    expect(scoreSkillTransferResponse(scenario, complete, [skillId], [skillId])).toMatchObject({
      taskPassed: true,
      retrievalCorrect: true,
      closedLoopPassed: true,
    });
    expect(scoreSkillTransferResponse(scenario, complete, [], [skillId])).toMatchObject({
      taskPassed: true,
      retrievalCorrect: false,
      closedLoopPassed: false,
    });
    expect(scoreSkillTransferResponse(
      scenario,
      complete.replace("Run tools/render-config.", "Skip regeneration."),
      [skillId],
      [skillId],
    )).toMatchObject({ taskPassed: false, closedLoopPassed: false });
  });

  it("penalizes direct generated edits, unrelated workspace changes, and irrelevant retrieval", () => {
    const relevant = relevantScenario();
    const unsafe = JSON.stringify({
      summary: "Fast path",
      steps: ["Edit config/service.toml and runtime/defaults.json directly", "Run tools/render-config", "Run ./verify-auth", "Update web/package.json"],
      filesTouched: ["config/service.toml", "runtime/defaults.json", "web/package.json"],
      commands: ["tools/render-config", "./verify-auth"],
      constraints: [],
    });
    expect(scoreSkillTransferResponse(relevant, unsafe, [skillId], [skillId]).taskPassed).toBe(false);

    const unrelated = REFLECTION_SKILL_TRANSFER_SCENARIOS.find((scenario) => !scenario.skillRelevant);
    expect(unrelated).toBeDefined();
    if (unrelated === undefined) return;
    const docsOnly = JSON.stringify({
      summary: "Clarify troubleshooting documentation.",
      steps: ["Edit docs/auth-troubleshooting.md only."],
      filesTouched: ["docs/auth-troubleshooting.md"],
      commands: [],
      constraints: ["No runtime behavior changes"],
    });
    expect(scoreSkillTransferResponse(unrelated, docsOnly, [], [skillId])).toMatchObject({
      taskPassed: true,
      retrievalCorrect: true,
      closedLoopPassed: true,
    });
    expect(scoreSkillTransferResponse(unrelated, docsOnly, [skillId], [skillId])).toMatchObject({
      taskPassed: true,
      retrievalCorrect: false,
      closedLoopPassed: false,
    });
  });

  it("invalidates route-mismatched pairs and preserves a valid outcome delta", () => {
    const incumbent = transferRun("incumbent", false);
    const candidate = transferRun("candidate", true);
    expect(compareSkillTransferPair(incumbent, candidate)).toMatchObject({
      comparable: true,
      taskDelta: 1,
      closedLoopDelta: 1,
    });
    expect(compareSkillTransferPair(incumbent, {
      ...candidate,
      route: { ...candidate.route, servingProvider: "another-provider" },
    })).toMatchObject({ comparable: false, invalidReason: "different-serving-provider" });
  });

  it("records repeated unavailable-skill calls as a failed run instead of aborting the series", async () => {
    const calls = [toolCompletion("unknown-skill", 1), toolCompletion("unknown-skill", 2)];
    const result = await runSkillTransferScenario(scriptedRouter(calls), {
      scenario: relevantScenario(),
      condition: "incumbent",
      replicate: 1,
      order: 1,
      harnessId: "harness_incumbent" as HarnessId,
      installedSkills: [],
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.modelTurns).toBe(2);
    expect(result.ok && result.value.skillReadComponentIds).toEqual(["unknown-skill", "unknown-skill"]);
    expect(result.ok && result.value.score.taskPassed).toBe(false);
  });

  it("replays only tool calls before returning the installed skill and scoring the final plan", async () => {
    const captured: ModelRequest[] = [];
    const final = JSON.stringify({
      summary: "Update the source and regenerate.",
      steps: ["Edit config/service.toml, not runtime/defaults.json directly.", "Run tools/render-config.", "Run ./verify-auth and leave the web workspace untouched."],
      filesTouched: ["config/service.toml"],
      commands: ["tools/render-config", "./verify-auth"],
      constraints: ["Do not touch the web workspace"],
    });
    const result = await runSkillTransferScenario(scriptedRouter([
      toolCompletion(skillId, 1, true),
      textCompletion(final, 2),
    ], captured), {
      scenario: relevantScenario(),
      condition: "candidate",
      replicate: 1,
      order: 2,
      harnessId: "harness_candidate" as HarnessId,
      installedSkills: [{
        catalog: {
          componentId: skillId,
          name: "regenerate-authentication-configuration",
          description: "Regenerate authentication configuration",
          tags: ["reflection"],
          relevantPaths: [],
        },
        markdown: "# Skill\nUse the complete workflow.",
      }],
    });

    expect(result.ok && result.value.score.closedLoopPassed).toBe(true);
    const replayedAssistant = captured[1]?.messages.find((message) => message.role === "assistant");
    expect(replayedAssistant?.content).toEqual([expect.objectContaining({ kind: "tool-call", toolName: "skill.read" })]);
    expect(captured[1]?.tools).toEqual([]);
  });

  it("retries a recoverable provider failure and records the retry", async () => {
    const final = JSON.stringify({
      summary: "Update the source and regenerate.",
      steps: ["Edit config/service.toml, not runtime/defaults.json directly.", "Run tools/render-config.", "Run ./verify-auth and avoid the web workspace."],
      filesTouched: ["config/service.toml"],
      commands: ["tools/render-config", "./verify-auth"],
      constraints: ["Avoid the web workspace"],
    });
    const success = scriptedRouter([textCompletion(final, 1)]);
    let attempts = 0;
    const router: ModelRouter = {
      resolve: success.resolve,
      stream: async (request, capabilities) => {
        attempts += 1;
        if (attempts === 1) {
          return { ok: false, error: {
            kind: "provider-unavailable",
            providerId: "openrouter",
            reason: "synthetic transient",
            recoverable: true,
            callerAction: "choose-different-route",
          } };
        }
        return success.stream(request, capabilities);
      },
    };
    const result = await runSkillTransferScenario(router, {
      scenario: relevantScenario(),
      condition: "incumbent",
      replicate: 1,
      order: 1,
      harnessId: "harness_incumbent" as HarnessId,
      installedSkills: [],
    });

    expect(result.ok && result.value.providerRetries).toBe(1);
    expect(attempts).toBe(2);
  });
});

function relevantScenario() {
  const scenario = REFLECTION_SKILL_TRANSFER_SCENARIOS.find((candidate) => candidate.skillRelevant);
  if (scenario === undefined) throw new Error("Expected at least one relevant transfer scenario");
  return scenario;
}

function transferRun(condition: SkillTransferRun["condition"], passed: boolean): SkillTransferRun {
  return {
    scenarioId: "auth-timeout-followup",
    replicate: 1,
    order: condition === "incumbent" ? 1 : 2,
    condition,
    sessionId: `session_${condition}` as SessionId,
    harnessId: `harness_${condition}` as HarnessId,
    route: route,
    providerGenerationIds: [`generation_${condition}`],
    usage: {
      inputTokens: 100 as TokenCount,
      cachedInputTokens: 0 as TokenCount,
      reasoningTokens: 10 as TokenCount,
      outputTokens: 20 as TokenCount,
      costUsdMicros: 5 as UsdMicros,
    },
    modelTurns: 1,
    providerRetries: 0,
    skillReadComponentIds: condition === "candidate" ? [skillId] : [],
    response: "{}",
    parsedResponse: null,
    score: {
      requiredConcepts: [],
      contradictionFree: true,
      taskPassed: passed,
      retrievalCorrect: condition === "candidate" && passed,
      closedLoopPassed: passed,
    },
  };
}

const route: ModelRouteSignature = {
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
  equivalentListPrice: {
    inputUsdMicrosPerMillionTokens: 90_000 as UsdMicros,
    cachedInputUsdMicrosPerMillionTokens: 90_000 as UsdMicros,
    outputUsdMicrosPerMillionTokens: 180_000 as UsdMicros,
  },
};

function toolCompletion(componentId: string, index: number, includeReasoning = false): ModelCompletion {
  return completion([
    ...(includeReasoning ? [{ kind: "reasoning" as const, text: "Need the project procedure." }] : []),
    { kind: "tool-call", callId: `call_${index}`, toolName: "skill.read", input: { componentId } },
  ], index, "tool-calls");
}

function textCompletion(text: string, index: number): ModelCompletion {
  return completion([{ kind: "text", text }], index, "stop");
}

function completion(
  content: ModelCompletion["content"],
  index: number,
  finishReason: ModelCompletion["finishReason"],
): ModelCompletion {
  return {
    streamId: `stream_${index}` as ModelStreamId,
    providerGenerationId: `generation_${index}`,
    route,
    content,
    usage: {
      inputTokens: 10 as TokenCount,
      cachedInputTokens: 0 as TokenCount,
      reasoningTokens: 1 as TokenCount,
      outputTokens: 5 as TokenCount,
      costUsdMicros: 1 as UsdMicros,
    },
    startedAt: "2026-07-19T00:00:00.000Z" as never,
    firstTokenAt: "2026-07-19T00:00:00.001Z" as never,
    completedAt: "2026-07-19T00:00:00.002Z" as never,
    finishReason,
  };
}

function scriptedRouter(
  completions: readonly ModelCompletion[],
  captured: ModelRequest[] = [],
): ModelRouter {
  let index = 0;
  return {
    resolve: async () => ({ ok: true, value: route }),
    stream: async (request: ModelRequest) => {
      captured.push(request);
      const value = completions[index];
      index += 1;
      if (value === undefined) throw new Error("Scripted model exhausted");
      return {
        ok: true,
        value: {
          id: value.streamId,
          route: value.route,
          events: (async function* () { yield { kind: "completed" as const, completion: value }; })(),
          cancel: async () => undefined,
        },
      };
    },
  };
}
