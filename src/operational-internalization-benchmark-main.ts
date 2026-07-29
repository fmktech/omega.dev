import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_CONFIG } from "./config/defaults.js";
import type {
  AbsolutePath, ArtifactId, ComponentManifest, HarnessId, HarnessManifest, HarnessRepository, ObjectStore,
  ProjectId, Result, SessionId, SkillCatalogEntry, StoreError, Timestamp,
} from "./contracts/index.js";
import { assessOperationalInternalization } from "./evolution/operational-internalization-benchmark.js";
import { REFLECTION_SCENARIOS, runReflectionScenario, type ReflectionRun } from "./evolution/reflection-benchmark.js";
import type { InstalledTransferSkill } from "./evolution/reflection-skill-transfer-benchmark.js";
import { createReflectionSkillCandidate } from "./evolution/reflection-skills.js";
import {
  OPERATIONAL_INTERNALIZATION_SCENARIOS, compareWorkspaceSkillPair, runWorkspaceSkillScenario, scoreWorkspaceSkillRun,
  type WorkspaceSkillPair, type WorkspaceSkillRun,
} from "./evolution/workspace-skill-transfer-benchmark.js";
import { createModelRouter } from "./models/model-router.js";
import { atomicWriteFile, safeStorageKey } from "./persistence/artifact-store.js";
import { createFileObjectStore } from "./persistence/object-store.js";

const PROJECT_ID = "project_operational_internalization_v1" as ProjectId;
const INCUMBENT_ID = "harness_operational_internalization_incumbent_v1" as HarnessId;
const SOURCE_SESSION_ID = "session_macos_timeout_correction_v1" as SessionId;

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv[0] === "--rescore") return rescore(argv[1]);
  const source = REFLECTION_SCENARIOS.find((scenario) => scenario.id === "macos-timeout-command-correction");
  if (source === undefined) return fail(1, "The macOS timeout correction scenario is missing.");
  const root = resolve(process.env["OMEGA_HOME"] ?? join(homedir(), ".omega")) as AbsolutePath;
  const objects = createFileObjectStore(root);
  const models = createModelRouter(DEFAULT_CONFIG.models, process.env);
  process.stderr.write("operational-internalization: reflecting over one user command correction\n");
  const reflected = await runReflectionScenario(models, source);
  if (!reflected.ok) return fail(2, reflected.error);

  const incumbent: HarnessManifest = {
    id: INCUMBENT_ID, projectId: PROJECT_ID, alias: "operational-internalization-incumbent", parents: [], components: [], sourceArtifacts: [],
    createdAt: "2026-07-21T00:00:00.000Z" as Timestamp,
  };
  const harnesses: Pick<HarnessRepository, "putComponent" | "putHarness"> = {
    async putComponent(component) { return { ok: true, value: component }; },
    async putHarness(harness) { return { ok: true, value: harness }; },
  };
  const candidate = await createReflectionSkillCandidate({
    incumbent,
    proposal: reflected.value.proposal,
    sourceSessionId: SOURCE_SESSION_ID,
    evidenceArtifactIds: [`artifact_operational_trace_${reflected.value.evidenceSha}` as ArtifactId],
    proposalArtifactId: `artifact_operational_reflection_${reflected.value.evidenceSha}` as ArtifactId,
    alias: "operational-internalization-candidate",
    createdAt: new Date().toISOString() as Timestamp,
  }, objects, harnesses);
  if (!candidate.ok) return fail(3, candidate.error);
  const installed = await loadInstalledSkills(objects, candidate.value);
  if (!installed.ok) return fail(4, installed.error);

  const runs: WorkspaceSkillRun[] = [];
  let order = 0;
  for (const [scenarioIndex, scenario] of OPERATIONAL_INTERNALIZATION_SCENARIOS.entries()) {
    const conditions: readonly WorkspaceSkillRun["condition"][] = scenarioIndex % 2 === 0
      ? ["incumbent", "candidate"] : ["candidate", "incumbent"];
    for (const condition of conditions) {
      order += 1;
      process.stderr.write(`operational-internalization: ${order}/6 ${scenario.id} ${condition}\n`);
      const run = await runWorkspaceSkillScenario(models, {
        scenario,
        condition,
        replicate: 1,
        order,
        harnessId: condition === "candidate" ? candidate.value.id : incumbent.id,
        installedSkills: condition === "candidate" ? installed.value : [],
      });
      if (!run.ok) return fail(5, { scenarioId: scenario.id, condition, error: run.error });
      runs.push(run.value);
    }
  }
  const pairs = OPERATIONAL_INTERNALIZATION_SCENARIOS.map((scenario) => compareWorkspaceSkillPair(
    runs.find((run) => run.scenarioId === scenario.id && run.condition === "incumbent")!,
    runs.find((run) => run.scenarioId === scenario.id && run.condition === "candidate")!,
  ));
  const assessment = assessOperationalInternalization({ reflection: reflected.value, installedSkills: installed.value, pairs });
  const record = {
    kind: "operational-internalization-benchmark",
    version: 1,
    status: "completed",
    methodology: {
      sourceFeedback: "frozen user correction; no evaluation result is exposed to reflection",
      holdoutFeedback: "none",
      dimensionsAreIndependent: true,
      aggregateScore: null,
      verdictRule: "worked requires every required behavioral dimension and no measured regression; mixed exposes any tradeoff",
      environmentSimulation: "network-disabled OCI workspace; Darwin timeout/gtimeout availability is deterministically emulated at the process boundary",
    },
    reflection: reflected.value,
    installedSkillCatalog: installed.value.map((skill) => skill.catalog),
    candidateHarnessId: candidate.value.id,
    assessment,
    pairs,
    createdAt: new Date().toISOString(),
  } as const;
  const recordPath = await persist(root, record);
  process.stdout.write(`${JSON.stringify({ kind: record.kind, status: record.status, verdict: assessment.verdict, dimensions: assessment.dimensions, recordPath }, null, 2)}\n`);
  return 0;
}

type RescoreRecord = {
  readonly kind: "operational-internalization-benchmark";
  readonly reflection: ReflectionRun;
  readonly installedSkillCatalog: readonly SkillCatalogEntry[];
  readonly pairs: readonly WorkspaceSkillPair[];
};

async function rescore(path: string | undefined): Promise<number> {
  if (path === undefined) return fail(1, "Usage: benchmark:operational-internalization --rescore <record.json>");
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); } catch (error) { return fail(1, error); }
  if (!isRecord(parsed) || parsed["kind"] !== "operational-internalization-benchmark"
    || !Array.isArray(parsed["pairs"]) || !Array.isArray(parsed["installedSkillCatalog"]) || !isRecord(parsed["reflection"])) {
    return fail(1, "Input is not an operational internalization record.");
  }
  const source = parsed as RescoreRecord;
  const installedIds = source.installedSkillCatalog.map((catalog) => catalog.componentId);
  const pairs: WorkspaceSkillPair[] = [];
  for (const prior of source.pairs) {
    const scenario = OPERATIONAL_INTERNALIZATION_SCENARIOS.find((item) => item.id === prior.scenarioId);
    if (scenario === undefined) return fail(1, `Unknown operational scenario: ${prior.scenarioId}`);
    const rescored = (run: WorkspaceSkillRun): WorkspaceSkillRun => ({
      ...run,
      score: scoreWorkspaceSkillRun(scenario, {
        condition: run.condition,
        installedComponentIds: run.condition === "candidate" ? installedIds : [],
        skillReadComponentIds: run.skillReadComponentIds,
        fileWrites: run.fileWrites,
        processCalls: run.processCalls,
        finalFiles: run.finalFiles,
      }),
    });
    pairs.push(compareWorkspaceSkillPair(rescored(prior.incumbent), rescored(prior.candidate)));
  }
  const installedSkills: InstalledTransferSkill[] = source.installedSkillCatalog.map((catalog) => ({ catalog, markdown: "<not-required-for-rescoring>" }));
  const assessment = assessOperationalInternalization({ reflection: source.reflection, installedSkills, pairs });
  const root = resolve(process.env["OMEGA_HOME"] ?? join(homedir(), ".omega")) as AbsolutePath;
  const record = {
    ...source,
    version: 2,
    status: "rescored",
    derivedFrom: resolve(path),
    methodology: {
      dimensionsAreIndependent: true,
      aggregateScore: null,
      rescoreReason: "accept behaviorally equivalent direct and shell-invoked verifier command forms",
    },
    assessment,
    pairs,
    createdAt: new Date().toISOString(),
  } as const;
  const recordPath = await persist(root, record);
  process.stdout.write(`${JSON.stringify({ kind: record.kind, status: record.status, verdict: assessment.verdict, dimensions: assessment.dimensions, derivedFrom: record.derivedFrom, recordPath }, null, 2)}\n`);
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadInstalledSkills(objects: ObjectStore, harness: HarnessManifest): Promise<Result<readonly InstalledTransferSkill[], StoreError>> {
  const skills: InstalledTransferSkill[] = [];
  for (const component of harness.components.filter((item) => item.kind === "skill")) {
    const markdown = await objectText(objects, component);
    if (!markdown.ok) return markdown;
    skills.push({
      catalog: {
        componentId: component.id,
        name: frontmatter(markdown.value, "name") ?? String(component.id),
        description: frontmatter(markdown.value, "description") ?? String(component.id),
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

async function objectText(objects: ObjectStore, component: ComponentManifest): Promise<Result<string, StoreError>> {
  const found = await objects.get(component.objectHash);
  if (!found.ok) return found;
  const chunks: Uint8Array[] = [];
  for await (const chunk of found.value) chunks.push(chunk);
  return { ok: true, value: Buffer.concat(chunks).toString("utf8") };
}

function frontmatter(markdown: string, field: string): string | null {
  const raw = new RegExp(`^${field}:\\s*(.+?)\\s*$`, "mu").exec(markdown)?.[1]?.trim();
  return raw === undefined ? null : raw.replace(/^['"]|['"]$/gu, "");
}

function frontmatterArray(markdown: string, field: string): string[] {
  const raw = frontmatter(markdown, field);
  if (raw === null || !raw.startsWith("[") || !raw.endsWith("]")) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  } catch { /* YAML flow fallback below. */ }
  const body = raw.slice(1, -1).trim();
  return body.length === 0 ? [] : body.split(",").map((item) => item.trim().replace(/^['"]|['"]$/gu, "")).filter(Boolean);
}

async function persist(root: AbsolutePath, record: object): Promise<string> {
  const body = `${JSON.stringify(record)}\n`;
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  const path = join(root, "benchmarks", "operational-internalization", `${safeStorageKey(digest)}.json`);
  await atomicWriteFile(path, body);
  return path;
}

function fail(code: number, error: unknown): number {
  process.stderr.write(`${typeof error === "string" ? error : JSON.stringify(error)}\n`);
  return code;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) void main().then((code) => { process.exitCode = code; });

export { main as runOperationalInternalizationBenchmark };
