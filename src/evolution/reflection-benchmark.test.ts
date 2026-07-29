import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import type {
  ModelError,
  ModelRouter,
  ModelRouteSignature,
  ModelStreamEvent,
  ModelStreamId,
  Timestamp,
  TokenCount,
  UsdMicros,
} from "../contracts/index.js";
import {
  REFLECTION_SCENARIOS,
  parseReflectionProposal,
  renderReflectionPrompt,
  runReflectionScenarioWithRetries,
  scoreReflection,
  type ReflectionProposal,
} from "./reflection-benchmark.js";

function scenario(id: string) {
  const found = REFLECTION_SCENARIOS.find((item) => item.id === id);
  if (found === undefined) throw new Error(`Missing reflection scenario ${id}`);
  return found;
}

describe("reflection component benchmark", () => {
  it("keeps DeepSeek as the production reflection route only", () => {
    const crystallizer = DEFAULT_CONFIG.models.routes.find((route) => route.role === "crystallizer");

    expect(crystallizer).toMatchObject({
      providerId: "openrouter",
      modelId: "deepseek/deepseek-v4-flash",
      temperature: 0,
    });
    expect(DEFAULT_CONFIG.models.routes.filter((route) => route.role !== "crystallizer").map((route) => route.modelId))
      .not.toContain("openai/gpt-5.6-luna");
  });

  it("renders ordered user-assistant-tool evidence without leaking the hidden rubric", () => {
    const selected = scenario("generated-config-correction");
    const rendered = renderReflectionPrompt(selected);

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.prompt.indexOf("Increase the authentication timeout")).toBeLessThan(rendered.value.prompt.indexOf("Stop: runtime/defaults.json is generated"));
    expect(rendered.value.prompt).toContain('"role":"user"');
    expect(rendered.value.prompt).toContain('"role":"tool"');
    expect(rendered.value.prompt).not.toContain("requiredSourceIds");
    expect(rendered.value.prompt).not.toContain("forbiddenClaims");
    expect(rendered.value.prompt).toContain("relevantPaths");
    expect(rendered.value.prompt).toContain("doesNotApplyWhen");
    expect(rendered.value.prompt).toContain("observableContracts");
    expect(rendered.value.prompt).toContain("behaviorally portable");
    expect(rendered.value.prompt).toContain("each observable contract");
    expect(rendered.value.prompt).toContain("Never exclude a lesson merely because the same behavior appears in a renamed project");
    expect(rendered.value.prompt).toContain("tool output from one successful run is observational evidence");
    expect(rendered.value.prompt).toContain("not permission to rewrite an existing verifier or tool");
    expect(rendered.value.evidenceSha).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("covers knowledge, hard-rule, and guided-skill learning from realistic dialogue", () => {
    expect(REFLECTION_SCENARIOS.map((item) => item.id)).toEqual(expect.arrayContaining([
      "nonstandard-project-architecture",
      "local-environment-contract",
      "hard-production-migration-boundary",
      "guided-release-playbook",
    ]));
    expect(scenario("nonstandard-project-architecture").turns.some((turn) => turn.role === "user" && turn.content.includes("project-wide convention"))).toBe(true);
    expect(scenario("local-environment-contract").turns.some((turn) => turn.role === "user" && turn.content.includes("rootless Podman"))).toBe(true);
    expect(scenario("hard-production-migration-boundary").rubric).toMatchObject({ decision: "evolve", target: "policy" });
    expect(scenario("guided-release-playbook").rubric).toMatchObject({ decision: "evolve", target: "skill" });
    expect(scenario("repeated-jira-gap").turns.some((turn) => turn.content.includes("idempotency key") && turn.content.includes("Retry-After"))).toBe(true);
  });

  it("awards full credit to an independently specified grounded evolution", () => {
    const selected = scenario("generated-config-correction");
    const proposal: ReflectionProposal = {
      reflection: "The user corrected both the generated-file source and verifier scope.",
      decision: "evolve",
      lessons: [{
        sourceIds: ["t04", "t06"],
        target: "skill",
        title: "Regenerate service configuration from its canonical source",
        guidance: "Edit config/service.toml, run tools/render-config to regenerate generated output, then use the scoped verifier ./verify-auth.",
      }],
    };

    expect(scoreReflection(selected, proposal)).toMatchObject({
      points: 10,
      possiblePoints: 10,
      dimensions: { decision: true, bounded: true, target: true, grounded: true, concepts: [true, true, true], contradictionFree: true },
    });
  });

  it("does not treat an explicit prohibition of a forbidden action as endorsement", () => {
    const selected = scenario("generated-config-correction");
    const proposal: ReflectionProposal = {
      reflection: "The assistant first edited runtime/defaults.json directly before the user corrected it.",
      decision: "evolve",
      lessons: [{
        sourceIds: ["t04", "t06"],
        target: "skill",
        title: "Regenerate service configuration from its canonical source",
        guidance: "Edit config/service.toml, run tools/render-config, then use ./verify-auth. Never edit runtime/defaults.json directly or treat npm test as authoritative.",
      }],
    };

    expect(scoreReflection(selected, proposal)).toMatchObject({
      points: 10,
      dimensions: { contradictionFree: true },
    });
  });

  it("still rejects a positive recommendation of a forbidden action", () => {
    const selected = scenario("generated-config-correction");
    const proposal: ReflectionProposal = {
      reflection: "The generated output is convenient.",
      decision: "evolve",
      lessons: [{
        sourceIds: ["t04", "t06"],
        target: "skill",
        title: "Regenerate service configuration from its canonical source",
        guidance: "Edit config/service.toml and run tools/render-config with ./verify-auth, but edit runtime/defaults.json directly when rushed.",
      }],
    };

    expect(scoreReflection(selected, proposal).dimensions.contradictionFree).toBe(false);
  });

  it("penalizes wrong destination, weak grounding, missed concepts, and contradicted guidance independently", () => {
    const selected = scenario("generated-config-correction");
    const proposal: ReflectionProposal = {
      reflection: "Use npm everywhere.",
      decision: "evolve",
      lessons: [{
        sourceIds: ["t02"],
        target: "policy",
        title: "Use the familiar command",
        guidance: "npm test is authoritative and edit runtime/defaults.json directly.",
      }],
    };
    const score = scoreReflection(selected, proposal);

    expect(score.points).toBe(3);
    expect(score.dimensions).toEqual({
      decision: true,
      bounded: true,
      target: false,
      grounded: false,
      concepts: [false, false, false],
      contradictionFree: false,
    });
  });

  it("recognizes an explicit temporary workaround as no durable evolution", () => {
    const selected = scenario("temporary-one-off-no-change");
    const proposal: ReflectionProposal = {
      reflection: "This was a temporary one-off workaround explicitly marked as no durable project convention.",
      decision: "no-change",
      lessons: [],
    };

    expect(scoreReflection(selected, proposal).points).toBe(10);
  });

  it("still detects a forbidden generalization in a no-change reflection", () => {
    const selected = scenario("temporary-one-off-no-change");
    const proposal: ReflectionProposal = {
      reflection: "This was temporary, but the harness should duplicate dots in future package names.",
      decision: "no-change",
      lessons: [],
    };

    expect(scoreReflection(selected, proposal).dimensions.contradictionFree).toBe(false);
  });

  it("retries a recoverable reflection provider failure and preserves attempt evidence", async () => {
    const models = sequencedReflectionRouter([providerUnavailable(), "success"]);
    const waits: number[] = [];

    const result = await runReflectionScenarioWithRetries(models.router, scenario("generated-config-correction"), {
      waitBeforeRetry: async (delayMs) => { waits.push(delayMs); },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        attempts: 2,
        retries: [{ failedAttempt: 1, reason: "provider", error: { kind: "provider-unavailable" } }],
      },
    });
    expect(models.calls()).toBe(2);
    expect(waits).toEqual([1_000]);
  });

  it("returns the final recoverable provider failure after the bounded attempt limit", async () => {
    const models = sequencedReflectionRouter([providerUnavailable(), providerUnavailable(), providerUnavailable()]);

    const result = await runReflectionScenarioWithRetries(models.router, scenario("generated-config-correction"), {
      waitBeforeRetry: async () => undefined,
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "provider-unavailable" } });
    expect(models.calls()).toBe(3);
  });

  it("does not retry a non-recoverable reflection failure", async () => {
    const failure: ModelError = {
      kind: "budget-exceeded",
      budget: "tokens",
      limit: 1 as TokenCount,
      observed: 2 as TokenCount,
      recoverable: false,
      callerAction: "abort",
    };
    const models = sequencedReflectionRouter([failure, "success"]);

    const result = await runReflectionScenarioWithRetries(models.router, scenario("generated-config-correction"), {
      waitBeforeRetry: async () => undefined,
    });

    expect(result).toEqual({ ok: false, error: failure });
    expect(models.calls()).toBe(1);
  });

  it("preserves project paths and positive and negative applicability from reflection output", () => {
    const parsed = parseReflectionProposal(JSON.stringify({
      reflection: "A scoped generated-config procedure was established.",
      decision: "evolve",
      lessons: [{
        sourceIds: ["t04", "t06"],
        target: "skill",
        title: "Regenerate authentication configuration",
        guidance: "Edit the source and regenerate.",
        relevantPaths: ["config/service.toml", "runtime/defaults.json"],
        appliesWhen: ["Authentication runtime configuration changes"],
        doesNotApplyWhen: ["The task is documentation-only"],
        observableContracts: [observableContract()],
      }],
    }), scenario("generated-config-correction").turns.map((turn) => turn.id));

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        lessons: [{
          relevantPaths: ["config/service.toml", "runtime/defaults.json"],
          appliesWhen: ["Authentication runtime configuration changes"],
          doesNotApplyWhen: ["The task is documentation-only"],
        }],
      },
    });
  });

  it("accepts a complete multi-step skill procedure without forcing lossy compression", () => {
    const guidance = Array.from({ length: 24 }, (_, index) => `${index + 1}. Apply the project-specific rule and verify its observable result.`).join("\n");
    expect(guidance.length).toBeGreaterThan(1_600);

    const parsed = parseReflectionProposal(JSON.stringify({
      reflection: "The feedback established a detailed reusable workflow.",
      decision: "evolve",
      lessons: [{
        sourceIds: ["source-session"],
        target: "skill",
        title: "Apply the project workflow",
        guidance,
        relevantPaths: ["."],
        appliesWhen: ["The authentication configuration regeneration workflow applies"],
        doesNotApplyWhen: ["The task is unrelated"],
        observableContracts: [observableContract()],
      }],
    }), ["source-session"]);

    expect(parsed.ok).toBe(true);
  });

  it.each([
    ["unknown source", { reflection: "x", decision: "evolve", lessons: [{ sourceIds: ["t99"], target: "skill", title: "x", guidance: "x" }] }],
    ["lessons on no-change", { reflection: "x", decision: "no-change", lessons: [{ sourceIds: ["t01"], target: "skill", title: "x", guidance: "x" }] }],
    ["empty evolve", { reflection: "x", decision: "evolve", lessons: [] }],
    ["unknown target", { reflection: "x", decision: "evolve", lessons: [{ sourceIds: ["t01"], target: "memory", title: "x", guidance: "x" }] }],
  ])("rejects malformed reflection output with %s", (_label, value) => {
    expect(parseReflectionProposal(JSON.stringify(value), scenario("generated-config-correction").turns.map((turn) => turn.id)).ok).toBe(false);
  });

  it("rejects a skill reflection before candidate execution when observable contract categories are missing", () => {
    const parsed = parseReflectionProposal(JSON.stringify({
      reflection: "The feedback established storage behavior.",
      decision: "evolve",
      lessons: [{
        sourceIds: ["t04", "t06"],
        target: "skill",
        title: "Preserve storage contracts",
        guidance: "Keep stable errors and conflict-safe deletes.",
        relevantPaths: ["src/domain/storage.js"],
        appliesWhen: ["Storage behavior changes"],
        doesNotApplyWhen: ["Documentation-only work"],
        observableContracts: [{
          operation: "deleteLocation(id)",
          inputs: ["location id"],
          outputs: ["deleted location"],
          errors: ["throws CONFLICT when lots still reference the location"],
          sideEffects: [],
          exactValues: ["CONFLICT"],
        }],
      }],
    }), scenario("generated-config-correction").turns.map((turn) => turn.id));

    expect(parsed).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "modelOutput.lessons.0.observableContracts.0.sideEffects" },
    });
  });

  it("normalizes an explicit scalar contract clause without accepting an omitted clause", () => {
    const parsed = parseReflectionProposal(JSON.stringify({
      reflection: "The feedback established a generated-config procedure.",
      decision: "evolve",
      lessons: [{
        sourceIds: ["t04", "t06"],
        target: "skill",
        title: "Regenerate authentication configuration",
        guidance: "Edit the source and regenerate.",
        relevantPaths: ["config/service.toml"],
        appliesWhen: ["Authentication configuration changes"],
        doesNotApplyWhen: ["Documentation-only work"],
        observableContracts: [{
          ...observableContract(),
          errors: "none",
        }],
      }],
    }), scenario("generated-config-correction").turns.map((turn) => turn.id));

    expect(parsed).toMatchObject({
      ok: true,
      value: { lessons: [{ observableContracts: [{ errors: ["none"] }] }] },
    });
  });

  it("rejects a skill whose applicability is only a source project identity", () => {
    const parsed = parseReflectionProposal(JSON.stringify({
      reflection: "The feedback established portable HTTP behavior.",
      decision: "evolve",
      lessons: [{
        sourceIds: ["t04", "t06"],
        target: "skill",
        title: "Preserve HTTP boundary contracts",
        guidance: "Keep the observed response contracts.",
        relevantPaths: ["src/adapter/http.js"],
        appliesWhen: ["Modifying or extending the storage-app service"],
        doesNotApplyWhen: ["Working on a different project or service"],
        observableContracts: [{
          operation: "HTTP request body handling",
          inputs: ["request body larger than 1 MiB"],
          outputs: ["usable JSON response"],
          errors: ["HTTP 413"],
          sideEffects: ["storage remains unchanged"],
          exactValues: ["413", "1 MiB"],
        }],
      }],
    }), scenario("generated-config-correction").turns.map((turn) => turn.id));

    expect(parsed).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "modelOutput.lessons.0.appliesWhen" },
    });
  });

  it("accepts behavior-linked applicability across renamed projects", () => {
    const parsed = parseReflectionProposal(JSON.stringify({
      reflection: "The feedback established portable HTTP behavior.",
      decision: "evolve",
      lessons: [{
        sourceIds: ["t04", "t06"],
        target: "skill",
        title: "Preserve HTTP boundary contracts",
        guidance: "Keep the observed response contracts.",
        relevantPaths: ["src/adapter/http.js"],
        appliesWhen: ["An HTTP request body can exceed 1 MiB and must return status 413"],
        doesNotApplyWhen: ["The task cannot change request parsing or HTTP responses"],
        observableContracts: [{
          operation: "HTTP request body handling",
          inputs: ["request body larger than 1 MiB"],
          outputs: ["usable JSON response"],
          errors: ["HTTP 413"],
          sideEffects: ["storage remains unchanged"],
          exactValues: ["413", "1 MiB"],
        }],
      }],
    }), scenario("generated-config-correction").turns.map((turn) => turn.id));

    expect(parsed.ok).toBe(true);
  });

  it("rejects a multi-operation skill when any observable contract lacks a retrieval cue", () => {
    const parsed = parseReflectionProposal(JSON.stringify({
      reflection: "The feedback established two exact HTTP behaviors.",
      decision: "evolve",
      lessons: [{
        sourceIds: ["t04", "t06"],
        target: "skill",
        title: "Preserve HTTP status contracts",
        guidance: "Keep both observed response contracts.",
        relevantPaths: ["src/adapter/http.js"],
        appliesWhen: ["An HTTP request body can exceed 1 MiB and must return status 413"],
        doesNotApplyWhen: ["The task cannot change request parsing or HTTP responses"],
        observableContracts: [{
          operation: "HTTP request body handling",
          inputs: ["request body larger than 1 MiB"],
          outputs: ["usable JSON response"],
          errors: ["HTTP 413"],
          sideEffects: ["storage remains unchanged"],
          exactValues: ["413", "1 MiB"],
        }, {
          operation: "unknown route handling",
          inputs: ["unmatched route"],
          outputs: ["exact JSON error body"],
          errors: ["HTTP 404"],
          sideEffects: ["none"],
          exactValues: ["404", "Not found"],
        }],
      }],
    }), scenario("generated-config-correction").turns.map((turn) => turn.id));

    expect(parsed).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "modelOutput.lessons.0.appliesWhen" },
    });
  });
});

function observableContract() {
  return {
    operation: "authentication configuration regeneration",
    inputs: ["edit config/service.toml"],
    outputs: ["runtime/defaults.json is regenerated"],
    errors: ["none"],
    sideEffects: ["tools/render-config rewrites runtime/defaults.json"],
    exactValues: ["config/service.toml", "tools/render-config", "runtime/defaults.json", "./verify-auth"],
  } as const;
}

function providerUnavailable(): ModelError {
  return {
    kind: "provider-unavailable",
    providerId: "openrouter",
    reason: "transient empty provider generation",
    recoverable: true,
    callerAction: "choose-different-route",
  };
}

function sequencedReflectionRouter(outcomes: readonly (ModelError | "success")[]): {
  readonly router: ModelRouter;
  readonly calls: () => number;
} {
  let calls = 0;
  const route = crystallizerRoute();
  const router: ModelRouter = {
    async resolve() {
      return { ok: true, value: route };
    },
    async stream() {
      const outcome = outcomes[calls] ?? outcomes.at(-1) ?? providerUnavailable();
      calls += 1;
      if (outcome !== "success") return { ok: false, error: outcome };
      const streamId = `stream_reflection_retry_${calls}` as ModelStreamId;
      async function* events(): AsyncIterable<ModelStreamEvent> {
        yield {
          kind: "completed",
          completion: {
            streamId,
            providerGenerationId: `generation_${calls}`,
            route,
            content: [{ kind: "text", text: successfulReflectionBody() }],
            usage: {
              inputTokens: 10 as TokenCount,
              cachedInputTokens: 0 as TokenCount,
              reasoningTokens: 0 as TokenCount,
              outputTokens: 10 as TokenCount,
              costUsdMicros: 1 as UsdMicros,
            },
            startedAt: "2026-07-27T00:00:00.000Z" as Timestamp,
            firstTokenAt: "2026-07-27T00:00:00.001Z" as Timestamp,
            completedAt: "2026-07-27T00:00:00.002Z" as Timestamp,
            finishReason: "stop",
          },
        };
      }
      return {
        ok: true,
        value: {
          id: streamId,
          route,
          events: events(),
          async cancel() { return undefined; },
        },
      };
    },
  };
  return { router, calls: () => calls };
}

function crystallizerRoute(): ModelRouteSignature {
  const configured = DEFAULT_CONFIG.models.routes.find((route) => route.role === "crystallizer");
  if (configured === undefined) throw new Error("Missing crystallizer route");
  return {
    role: configured.role,
    providerId: configured.providerId,
    modelId: configured.modelId,
    variant: null,
    servingProvider: "test-provider",
    quantization: null,
    reasoning: configured.reasoning,
    temperature: configured.temperature,
    topP: configured.topP,
    seed: configured.seed,
    contextLimit: configured.contextLimit,
    outputLimit: configured.maxOutputTokens,
    equivalentListPrice: configured.equivalentListPrice,
  };
}

function successfulReflectionBody(): string {
  return JSON.stringify({
    reflection: "The feedback established the canonical generated-config workflow.",
    decision: "evolve",
    lessons: [{
      sourceIds: ["t04", "t06"],
      target: "skill",
      title: "Regenerate authentication configuration",
      guidance: "Edit config/service.toml, run tools/render-config, and verify with ./verify-auth.",
      relevantPaths: ["config/service.toml", "tools/render-config", "runtime/defaults.json"],
      appliesWhen: ["Authentication configuration is generated from a canonical source file"],
      doesNotApplyWhen: ["The task only changes documentation and cannot alter runtime configuration"],
      observableContracts: [observableContract()],
    }],
  });
}
