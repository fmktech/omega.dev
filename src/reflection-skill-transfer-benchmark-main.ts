import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_CONFIG } from "./config/defaults.js";
import type {
  AbsolutePath,
  ArtifactId,
  ComponentManifest,
  HarnessId,
  HarnessManifest,
  HarnessRepository,
  ObjectStore,
  ProjectId,
  Result,
  SessionId,
  Timestamp,
} from "./contracts/index.js";
import {
  REFLECTION_SKILL_TRANSFER_SCENARIOS,
  compareSkillTransferPair,
  runSkillTransferScenario,
  type InstalledTransferSkill,
  type SkillTransferPair,
  type SkillTransferRun,
} from "./evolution/reflection-skill-transfer-benchmark.js";
import { REFLECTION_SCENARIOS, runReflectionScenario } from "./evolution/reflection-benchmark.js";
import { createReflectionSkillCandidate } from "./evolution/reflection-skills.js";
import { createModelRouter } from "./models/model-router.js";
import { atomicWriteFile, safeStorageKey } from "./persistence/artifact-store.js";
import { createFileObjectStore } from "./persistence/object-store.js";

const PROJECT_ID = "project_reflection_skill_transfer_v1" as ProjectId;
const INCUMBENT_ID = "harness_reflection_skill_transfer_incumbent_v1" as HarnessId;
const SOURCE_SESSION_ID = "session_generated_config_correction" as SessionId;

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const replicates = Number(argv[0] ?? "3");
  if (!Number.isSafeInteger(replicates) || replicates < 1 || replicates > 10) {
    process.stderr.write("Usage: pnpm benchmark:reflection-skill-transfer [replicates:1-10]\n");
    return 1;
  }
  const sourceScenario = REFLECTION_SCENARIOS.find((scenario) => scenario.id === "generated-config-correction");
  if (sourceScenario === undefined) {
    process.stderr.write("The frozen generated-config reflection scenario is missing.\n");
    return 2;
  }

  const root = resolve(process.env["OMEGA_HOME"] ?? join(homedir(), ".omega")) as AbsolutePath;
  const objects = createFileObjectStore(root);
  const models = createModelRouter(DEFAULT_CONFIG.models, process.env);
  process.stderr.write(`reflection-skill-transfer: reflecting with ${modelId("crystallizer")}\n`);
  const reflected = await runReflectionScenario(models, sourceScenario);
  if (!reflected.ok) {
    process.stderr.write(`${JSON.stringify(reflected.error)}\n`);
    return 3;
  }
  const incumbent: HarnessManifest = {
    id: INCUMBENT_ID,
    projectId: PROJECT_ID,
    alias: "reflection-skill-transfer-incumbent",
    parents: [],
    components: [],
    sourceArtifacts: [],
    createdAt: "2026-07-19T00:00:00.000Z" as Timestamp,
  };
  const harnesses: Pick<HarnessRepository, "putComponent" | "putHarness"> = {
    async putComponent(component) {
      return { ok: true, value: component };
    },
    async putHarness(harness) {
      return { ok: true, value: harness };
    },
  };
  const candidate = await createReflectionSkillCandidate({
    incumbent,
    proposal: reflected.value.proposal,
    sourceSessionId: SOURCE_SESSION_ID,
    evidenceArtifactIds: [`artifact_conversation_${reflected.value.evidenceSha}` as ArtifactId],
    proposalArtifactId: `artifact_reflection_${reflected.value.evidenceSha}` as ArtifactId,
    alias: "reflection-skill-transfer-candidate",
    createdAt: new Date().toISOString() as Timestamp,
  }, objects, harnesses);
  if (!candidate.ok) {
    const record = {
      kind: "reflection-skill-transfer-benchmark",
      version: 1,
      status: "no-candidate",
      sourceScenarioId: sourceScenario.id,
      reflection: reflected.value,
      error: candidate.error,
      replicates,
      pairs: [],
      createdAt: new Date().toISOString(),
    } as const;
    const recordPath = await persistRecord(root, reflected.value.evidenceSha, record);
    process.stdout.write(`${JSON.stringify({ ...record, recordPath }, null, 2)}\n`);
    return 4;
  }

  const installedSkills = await loadInstalledSkills(objects, candidate.value);
  if (!installedSkills.ok) {
    process.stderr.write(`${JSON.stringify(installedSkills.error)}\n`);
    return 5;
  }
  process.stderr.write(`reflection-skill-transfer: compiled ${installedSkills.value.length} skill(s); running ${replicates * REFLECTION_SKILL_TRANSFER_SCENARIOS.length * 2} downstream calls\n`);

  const runs: SkillTransferRun[] = [];
  let failure: unknown = null;
  let order = 0;
  outer: for (let replicate = 1; replicate <= replicates; replicate += 1) {
    for (const scenario of REFLECTION_SKILL_TRANSFER_SCENARIOS) {
      const conditions: readonly SkillTransferRun["condition"][] = replicate % 2 === 1
        ? ["incumbent", "candidate"]
        : ["candidate", "incumbent"];
      for (const condition of conditions) {
        order += 1;
        process.stderr.write(`reflection-skill-transfer: ${order}/${replicates * REFLECTION_SKILL_TRANSFER_SCENARIOS.length * 2} ${scenario.id} ${condition}\n`);
        const run = await runSkillTransferScenario(models, {
          scenario,
          condition,
          replicate,
          order,
          harnessId: condition === "candidate" ? candidate.value.id : incumbent.id,
          installedSkills: condition === "candidate" ? installedSkills.value : [],
        });
        if (!run.ok) {
          failure = { scenarioId: scenario.id, replicate, condition, error: run.error };
          break outer;
        }
        runs.push(run.value);
      }
    }
  }

  const pairs: SkillTransferPair[] = [];
  for (let replicate = 1; replicate <= replicates; replicate += 1) {
    for (const scenario of REFLECTION_SKILL_TRANSFER_SCENARIOS) {
      const incumbentRun = runs.find((run) => run.replicate === replicate && run.scenarioId === scenario.id && run.condition === "incumbent");
      const candidateRun = runs.find((run) => run.replicate === replicate && run.scenarioId === scenario.id && run.condition === "candidate");
      if (incumbentRun !== undefined && candidateRun !== undefined) pairs.push(compareSkillTransferPair(incumbentRun, candidateRun));
    }
  }
  const summary = summarize(pairs);
  const record = {
    kind: "reflection-skill-transfer-benchmark",
    version: 1,
    status: failure === null ? "completed" : "partial",
    methodology: {
      selectionPolicy: "none",
      evaluationFeedbackToReflection: false,
      automaticActivation: false,
      taskSurface: "structured implementation plan with typed skill.read",
      modelRoutePolicy: "same configured main-coder route; actual route mismatch invalidates pair",
    },
    sourceScenarioId: sourceScenario.id,
    reflection: reflected.value,
    incumbentHarnessId: incumbent.id,
    candidateHarnessId: candidate.value.id,
    candidateParents: candidate.value.parents,
    candidateComponentIds: candidate.value.components.map((component) => component.id),
    candidateComponentObjectHashes: candidate.value.components.map((component) => component.objectHash),
    sourceArtifacts: candidate.value.sourceArtifacts,
    installedSkillCatalog: installedSkills.value.map((skill) => skill.catalog),
    replicates,
    scenarioCount: REFLECTION_SKILL_TRANSFER_SCENARIOS.length,
    failure,
    summary,
    pairs,
    createdAt: new Date().toISOString(),
  } as const;
  const recordPath = await persistRecord(root, `${reflected.value.evidenceSha}-${candidate.value.id}`, record);
  process.stdout.write(`${JSON.stringify({ ...record, recordPath }, null, 2)}\n`);
  return failure === null ? 0 : 6;
}

function summarize(pairs: readonly SkillTransferPair[]) {
  const comparable = pairs.filter((pair) => pair.comparable);
  const relevant = comparable.filter((pair) => scenario(pair.scenarioId)?.skillRelevant === true);
  const irrelevant = comparable.filter((pair) => scenario(pair.scenarioId)?.skillRelevant === false);
  const incumbentRelevantPasses = relevant.filter((pair) => pair.incumbent.score.taskPassed).length;
  const candidateRelevantPasses = relevant.filter((pair) => pair.candidate.score.taskPassed).length;
  const candidateRelevantRetrievals = relevant.filter((pair) => pair.candidate.score.retrievalCorrect).length;
  const candidateRelevantClosedLoopPasses = relevant.filter((pair) => pair.candidate.score.closedLoopPassed).length;
  const candidateIrrelevantPasses = irrelevant.filter((pair) => pair.candidate.score.taskPassed).length;
  const incumbentIrrelevantPasses = irrelevant.filter((pair) => pair.incumbent.score.taskPassed).length;
  const candidateIrrelevantNonRetrievals = irrelevant.filter((pair) => pair.candidate.score.retrievalCorrect).length;
  const conceptLabels = scenario("auth-timeout-followup")?.rubric.requiredConcepts.map((concept) => concept.label) ?? [];
  const relevantConceptPasses = conceptLabels.map((label, index) => ({
    label,
    incumbent: relevant.filter((pair) => pair.incumbent.score.requiredConcepts[index] === true).length,
    candidate: relevant.filter((pair) => pair.candidate.score.requiredConcepts[index] === true).length,
    possible: relevant.length,
  }));
  const positiveTransfer = pairs.length > 0
    && comparable.length === pairs.length
    && candidateRelevantPasses > incumbentRelevantPasses
    && candidateRelevantRetrievals === relevant.length
    && candidateIrrelevantNonRetrievals === irrelevant.length
    && candidateIrrelevantPasses >= incumbentIrrelevantPasses;
  return {
    pairCount: pairs.length,
    comparablePairCount: comparable.length,
    invalidPairCount: pairs.length - comparable.length,
    relevantPairCount: relevant.length,
    irrelevantPairCount: irrelevant.length,
    incumbentRelevantPasses,
    candidateRelevantPasses,
    candidateRelevantRetrievals,
    candidateRelevantClosedLoopPasses,
    incumbentIrrelevantPasses,
    candidateIrrelevantPasses,
    candidateIrrelevantNonRetrievals,
    relevantConceptPasses,
    providerRetries: {
      incumbent: comparable.reduce((sum, pair) => sum + pair.incumbent.providerRetries, 0),
      candidate: comparable.reduce((sum, pair) => sum + pair.candidate.providerRetries, 0),
    },
    positiveTransfer,
    usage: {
      incumbentCostUsdMicros: comparable.reduce((sum, pair) => sum + Number(pair.incumbent.usage.costUsdMicros), 0),
      candidateCostUsdMicros: comparable.reduce((sum, pair) => sum + Number(pair.candidate.usage.costUsdMicros), 0),
      incumbentInputTokens: comparable.reduce((sum, pair) => sum + Number(pair.incumbent.usage.inputTokens), 0),
      candidateInputTokens: comparable.reduce((sum, pair) => sum + Number(pair.candidate.usage.inputTokens), 0),
      incumbentOutputTokens: comparable.reduce((sum, pair) => sum + Number(pair.incumbent.usage.outputTokens), 0),
      candidateOutputTokens: comparable.reduce((sum, pair) => sum + Number(pair.candidate.usage.outputTokens), 0),
    },
  };
}

async function loadInstalledSkills(
  objects: ObjectStore,
  harness: HarnessManifest,
): Promise<Result<readonly InstalledTransferSkill[], import("./contracts/index.js").StoreError>> {
  const skills: InstalledTransferSkill[] = [];
  for (const component of harness.components.filter((item) => item.kind === "skill")) {
    const markdown = await objectText(objects, component.objectHash);
    if (!markdown.ok) return markdown;
    const name = frontmatter(markdown.value, "name") ?? String(component.id);
    const description = frontmatter(markdown.value, "description") ?? name;
    skills.push({
      catalog: {
        componentId: component.id,
        name,
        description,
        tags: frontmatterArray(markdown.value, "tags"),
        relevantPaths: frontmatterArray(markdown.value, "relevantPaths") as import("./contracts/index.js").RelativePath[],
        appliesWhen: frontmatterArray(markdown.value, "appliesWhen"),
        doesNotApplyWhen: frontmatterArray(markdown.value, "doesNotApplyWhen"),
      },
      markdown: markdown.value,
    });
  }
  return { ok: true, value: skills };
}

async function objectText(objects: ObjectStore, hash: ComponentManifest["objectHash"]) {
  const found = await objects.get(hash);
  if (!found.ok) return found;
  const chunks: Uint8Array[] = [];
  for await (const chunk of found.value) chunks.push(chunk);
  return { ok: true as const, value: Buffer.concat(chunks).toString("utf8") };
}

function frontmatter(markdown: string, field: string): string | null {
  const match = new RegExp(`^${field}:\\s*(.+?)\\s*$`, "mu").exec(markdown);
  if (match?.[1] === undefined) return null;
  const value = match[1].trim();
  return value.startsWith("\"") && value.endsWith("\"") ? value.slice(1, -1) : value;
}

function frontmatterArray(markdown: string, field: string): string[] {
  const raw = frontmatter(markdown, field);
  if (raw === null || !raw.startsWith("[") || !raw.endsWith("]")) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  } catch {
    // Simple YAML flow arrays may omit quotes.
  }
  const body = raw.slice(1, -1).trim();
  return body.length === 0 ? [] : body.split(",").map((item) => item.trim()).filter(Boolean);
}

function scenario(id: string) {
  return REFLECTION_SKILL_TRANSFER_SCENARIOS.find((candidate) => candidate.id === id);
}

function modelId(role: "crystallizer" | "main-coder"): string {
  return DEFAULT_CONFIG.models.routes.find((route) => route.role === role)?.modelId ?? "unconfigured";
}

async function persistRecord(root: AbsolutePath, signature: string, record: object): Promise<string> {
  const path = join(root, "benchmarks", "reflection-skill-transfer", `${safeStorageKey(signature)}.json`);
  await atomicWriteFile(path, `${JSON.stringify(record)}\n`);
  return path;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main().then((code) => { process.exitCode = code; });
}

export { main as runReflectionSkillTransferBenchmark };
