import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import {
  REFLECTION_SCENARIOS,
  parseReflectionProposal,
  renderReflectionPrompt,
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

  it.each([
    ["unknown source", { reflection: "x", decision: "evolve", lessons: [{ sourceIds: ["t99"], target: "skill", title: "x", guidance: "x" }] }],
    ["lessons on no-change", { reflection: "x", decision: "no-change", lessons: [{ sourceIds: ["t01"], target: "skill", title: "x", guidance: "x" }] }],
    ["empty evolve", { reflection: "x", decision: "evolve", lessons: [] }],
    ["unknown target", { reflection: "x", decision: "evolve", lessons: [{ sourceIds: ["t01"], target: "memory", title: "x", guidance: "x" }] }],
  ])("rejects malformed reflection output with %s", (_label, value) => {
    expect(parseReflectionProposal(JSON.stringify(value), scenario("generated-config-correction").turns.map((turn) => turn.id)).ok).toBe(false);
  });
});
