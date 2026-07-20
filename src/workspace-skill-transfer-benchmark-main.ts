import { createHash } from "node:crypto";
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
import { REFLECTION_SCENARIOS, runReflectionScenario } from "./evolution/reflection-benchmark.js";
import type { InstalledTransferSkill } from "./evolution/reflection-skill-transfer-benchmark.js";
import { createReflectionSkillCandidate } from "./evolution/reflection-skills.js";
import {
  WORKSPACE_SKILL_SCENARIOS,
  WORKSPACE_EFFICIENCY_THRESHOLDS,
  assessWorkspaceEfficiency,
  compareWorkspaceSkillPair,
  runWorkspaceSkillScenario,
  type WorkspaceSkillPair,
  type WorkspaceSkillRun,
} from "./evolution/workspace-skill-transfer-benchmark.js";
import { createModelRouter } from "./models/model-router.js";
import { atomicWriteFile, safeStorageKey } from "./persistence/artifact-store.js";
import { createFileObjectStore } from "./persistence/object-store.js";

const PROJECT_ID = "project_workspace_skill_transfer_v1" as ProjectId;
const INCUMBENT_ID = "harness_workspace_skill_transfer_incumbent_v1" as HarnessId;
const SOURCE_SESSION_ID = "session_workspace_generated_config_correction" as SessionId;

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const replicates = Number(argv[0] ?? "3");
  if (!Number.isSafeInteger(replicates) || replicates < 1 || replicates > 5) {
    process.stderr.write("Usage: pnpm benchmark:workspace-skill-transfer [replicates:1-5]\n");
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
  process.stderr.write(`workspace-skill-transfer: reflecting with ${modelId("crystallizer")}\n`);
  let reflectionAttempts = 1;
  let reflected = await runReflectionScenario(models, sourceScenario);
  while (!reflected.ok && reflected.error.kind === "validation"
    && reflected.error.field?.startsWith("modelOutput") === true && reflectionAttempts < 3) {
    reflectionAttempts += 1;
    process.stderr.write(`workspace-skill-transfer: retrying structurally invalid reflection (${reflectionAttempts}/3)\n`);
    reflected = await runReflectionScenario(models, sourceScenario);
  }
  if (!reflected.ok) {
    process.stderr.write(`${JSON.stringify(reflected.error)}\n`);
    return 3;
  }
  const incumbent: HarnessManifest = {
    id: INCUMBENT_ID,
    projectId: PROJECT_ID,
    alias: "workspace-skill-transfer-incumbent",
    parents: [],
    components: [],
    sourceArtifacts: [],
    createdAt: "2026-07-19T00:00:00.000Z" as Timestamp,
  };
  const harnesses: Pick<HarnessRepository, "putComponent" | "putHarness"> = {
    async putComponent(component) { return { ok: true, value: component }; },
    async putHarness(harness) { return { ok: true, value: harness }; },
  };
  const candidate = await createReflectionSkillCandidate({
    incumbent,
    proposal: reflected.value.proposal,
    sourceSessionId: SOURCE_SESSION_ID,
    evidenceArtifactIds: [`artifact_workspace_conversation_${reflected.value.evidenceSha}` as ArtifactId],
    proposalArtifactId: `artifact_workspace_reflection_${reflected.value.evidenceSha}` as ArtifactId,
    alias: "workspace-skill-transfer-candidate",
    createdAt: new Date().toISOString() as Timestamp,
  }, objects, harnesses);
  if (!candidate.ok) {
    process.stderr.write(`${JSON.stringify(candidate.error)}\n`);
    return 4;
  }
  const installedSkills = await loadInstalledSkills(objects, candidate.value);
  if (!installedSkills.ok) {
    process.stderr.write(`${JSON.stringify(installedSkills.error)}\n`);
    return 5;
  }
  if (installedSkills.value.length === 0) {
    process.stderr.write("Reflection candidate contains no installed skill.\n");
    return 6;
  }

  const total = replicates * WORKSPACE_SKILL_SCENARIOS.length * 2;
  process.stderr.write(`workspace-skill-transfer: compiled ${installedSkills.value.length} skill(s); running ${total} isolated workspaces\n`);
  const runs: WorkspaceSkillRun[] = [];
  const executionRetries: { readonly scenarioId: string; readonly replicate: number; readonly condition: WorkspaceSkillRun["condition"]; readonly attempt: number; readonly error: unknown }[] = [];
  let failure: unknown = null;
  let order = 0;
  outer: for (let replicate = 1; replicate <= replicates; replicate += 1) {
    for (const scenario of WORKSPACE_SKILL_SCENARIOS) {
      const conditions: readonly WorkspaceSkillRun["condition"][] = replicate % 2 === 1
        ? ["incumbent", "candidate"]
        : ["candidate", "incumbent"];
      for (const condition of conditions) {
        order += 1;
        process.stderr.write(`workspace-skill-transfer: ${order}/${total} ${scenario.id} ${condition}\n`);
        const runInput = {
          scenario,
          condition,
          replicate,
          order,
          harnessId: condition === "candidate" ? candidate.value.id : incumbent.id,
          installedSkills: condition === "candidate" ? installedSkills.value : [],
        } as const;
        let run = await runWorkspaceSkillScenario(models, runInput);
        for (let attempt = 2; !run.ok && providerFailure(run.error) && attempt <= 3; attempt += 1) {
          executionRetries.push({ scenarioId: scenario.id, replicate, condition, attempt: attempt - 1, error: run.error });
          process.stderr.write(`workspace-skill-transfer: retrying provider-failed workspace ${scenario.id} ${condition} (${attempt}/3)\n`);
          run = await runWorkspaceSkillScenario(models, runInput);
        }
        if (!run.ok) {
          failure = { scenarioId: scenario.id, replicate, condition, error: run.error };
          break outer;
        }
        runs.push(run.value);
      }
    }
  }

  const pairs: WorkspaceSkillPair[] = [];
  for (let replicate = 1; replicate <= replicates; replicate += 1) {
    for (const scenario of WORKSPACE_SKILL_SCENARIOS) {
      const incumbentRun = runs.find((run) => run.replicate === replicate && run.scenarioId === scenario.id && run.condition === "incumbent");
      const candidateRun = runs.find((run) => run.replicate === replicate && run.scenarioId === scenario.id && run.condition === "candidate");
      if (incumbentRun !== undefined && candidateRun !== undefined) pairs.push(compareWorkspaceSkillPair(incumbentRun, candidateRun));
    }
  }
  const summary = summarizeWorkspaceSkillPairs(pairs, replicates * WORKSPACE_SKILL_SCENARIOS.length);
  const record = {
    kind: "workspace-skill-transfer-benchmark",
    version: 4,
    status: failure === null ? "completed" : "partial",
    methodology: {
      selectionPolicy: "none",
      evaluationFeedbackToReflection: false,
      automaticActivation: false,
      taskSurface: "real UTF-8 files, SHA-interlocked writes, and one network-disabled OCI process per command",
      isolation: "docker --network none; workspace-only bind mount; 512 MiB; 1 CPU",
      verifierVisibility: "hidden deterministic post-run checks",
      modelRoutePolicy: "same configured main-coder route; actual route mismatch invalidates pair",
      efficiencyEffectThresholds: WORKSPACE_EFFICIENCY_THRESHOLDS,
    },
    sourceScenarioId: sourceScenario.id,
    reflectionAttempts,
    reflection: reflected.value,
    incumbentHarnessId: incumbent.id,
    candidateHarnessId: candidate.value.id,
    candidateParents: candidate.value.parents,
    candidateComponentIds: candidate.value.components.map((component) => component.id),
    candidateComponentObjectHashes: candidate.value.components.map((component) => component.objectHash),
    sourceArtifacts: candidate.value.sourceArtifacts,
    installedSkillCatalog: installedSkills.value.map((skill) => skill.catalog),
    replicates,
    scenarioCount: WORKSPACE_SKILL_SCENARIOS.length,
    failure,
    executionRetries,
    summary,
    pairs,
    createdAt: new Date().toISOString(),
  } as const;
  const recordPath = await persistRecord(root, `${reflected.value.evidenceSha}-${candidate.value.id}`, record);
  process.stdout.write(`${JSON.stringify({ ...record, recordPath }, null, 2)}\n`);
  return failure === null ? 0 : 7;
}

function providerFailure(error: import("./contracts/index.js").EvolutionError): boolean {
  return (error.kind === "provider-unavailable" || error.kind === "provider-rate-limited") && error.recoverable;
}

export function summarizeWorkspaceSkillPairs(pairs: readonly WorkspaceSkillPair[], expectedPairCount: number) {
  const comparable = pairs.filter((pair) => pair.comparable);
  const relevant = comparable.filter((pair) => scenario(pair.scenarioId)?.skillRelevant === true);
  const irrelevant = comparable.filter((pair) => scenario(pair.scenarioId)?.skillRelevant === false);
  const incumbentRelevantPasses = relevant.filter((pair) => pair.incumbent.score.workspacePassed).length;
  const candidateRelevantPasses = relevant.filter((pair) => pair.candidate.score.closedLoopPassed).length;
  const incumbentIrrelevantPasses = irrelevant.filter((pair) => pair.incumbent.score.workspacePassed).length;
  const candidateIrrelevantPasses = irrelevant.filter((pair) => pair.candidate.score.closedLoopPassed).length;
  const relevantRetrievals = relevant.filter((pair) => pair.candidate.score.retrievalCorrect).length;
  const irrelevantNonRetrievals = irrelevant.filter((pair) => pair.candidate.score.retrievalCorrect).length;
  const incumbentCostUsdMicros = comparable.reduce((sum, pair) => sum + Number(pair.incumbent.usage.costUsdMicros), 0);
  const candidateCostUsdMicros = comparable.reduce((sum, pair) => sum + Number(pair.candidate.usage.costUsdMicros), 0);
  const incumbentToolCalls = comparable.reduce((sum, pair) => sum + pair.incumbent.toolCalls, 0);
  const candidateToolCalls = comparable.reduce((sum, pair) => sum + pair.candidate.toolCalls, 0);
  const efficiency = assessWorkspaceEfficiency({ incumbentCostUsdMicros, candidateCostUsdMicros, incumbentToolCalls, candidateToolCalls });
  const validTransferSurface = pairs.length === expectedPairCount
    && comparable.length === pairs.length
    && relevantRetrievals === relevant.length
    && irrelevantNonRetrievals === irrelevant.length
    && candidateIrrelevantPasses >= incumbentIrrelevantPasses
    && comparable.every((pair) => pair.closedLoopDelta >= 0);
  const capabilityImproved = validTransferSurface && candidateRelevantPasses > incumbentRelevantPasses;
  const efficiencyImproved = validTransferSurface
    && candidateRelevantPasses === incumbentRelevantPasses
    && candidateIrrelevantPasses === incumbentIrrelevantPasses
    && efficiency.effectMet;
  const positiveTransfer = capabilityImproved || efficiencyImproved;
  return {
    pairCount: pairs.length,
    comparablePairCount: comparable.length,
    invalidPairCount: pairs.length - comparable.length,
    relevantPairCount: relevant.length,
    irrelevantPairCount: irrelevant.length,
    incumbentRelevantPasses,
    candidateRelevantPasses,
    incumbentIrrelevantPasses,
    candidateIrrelevantPasses,
    candidateRelevantRetrievals: relevantRetrievals,
    candidateIrrelevantNonRetrievals: irrelevantNonRetrievals,
    gainedPairs: comparable.filter((pair) => pair.closedLoopDelta > 0).length,
    regressedPairs: comparable.filter((pair) => pair.closedLoopDelta < 0).length,
    capabilityImproved,
    efficiencyImproved,
    efficiencyEffect: efficiency,
    positiveTransfer,
    usage: {
      incumbentInputTokens: comparable.reduce((sum, pair) => sum + Number(pair.incumbent.usage.inputTokens), 0),
      candidateInputTokens: comparable.reduce((sum, pair) => sum + Number(pair.candidate.usage.inputTokens), 0),
      incumbentOutputTokens: comparable.reduce((sum, pair) => sum + Number(pair.incumbent.usage.outputTokens), 0),
      candidateOutputTokens: comparable.reduce((sum, pair) => sum + Number(pair.candidate.usage.outputTokens), 0),
      incumbentCostUsdMicros,
      candidateCostUsdMicros,
      incumbentToolCalls,
      candidateToolCalls,
    },
  };
}

function scenario(id: string) {
  return WORKSPACE_SKILL_SCENARIOS.find((candidate) => candidate.id === id);
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

function frontmatter(markdown: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "mu").exec(markdown);
  return match?.[1]?.trim().replace(/^"|"$/gu, "") ?? null;
}

function frontmatterArray(markdown: string, key: string): readonly string[] {
  const raw = frontmatter(markdown, key);
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
  } catch {
    if (!raw.startsWith("[") || !raw.endsWith("]")) return [];
    const body = raw.slice(1, -1).trim();
    return body.length === 0 ? [] : body.split(",").map((item) => item.trim().replace(/^['"]|['"]$/gu, "")).filter(Boolean);
  }
}

async function persistRecord(root: AbsolutePath, signature: string, record: object): Promise<string> {
  const body = `${JSON.stringify(record)}\n`;
  const digest = createHash("sha256").update(`${signature}\n${body}`, "utf8").digest("hex");
  const path = join(root, "benchmarks", "workspace-skill-transfer", `${safeStorageKey(digest)}.json`);
  await atomicWriteFile(path, body);
  return path;
}

function modelId(role: "crystallizer" | "main-coder"): string {
  const route = DEFAULT_CONFIG.models.routes.find((candidate) => candidate.role === role);
  return route === undefined ? "unconfigured" : `${route.providerId}:${route.modelId}`;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main().then((code) => { process.exitCode = code; });
}

export { main as runWorkspaceSkillTransferBenchmark };
