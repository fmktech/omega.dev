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
  StoreError,
  Timestamp,
} from "./contracts/index.js";
import {
  FEEDBACK_TRANSFER_FIXTURES,
  compareFeedbackTransferEpisodes,
  feedbackTrainingFixture,
  runFeedbackEpisode,
  type FeedbackEpisode,
} from "./evolution/feedback-skill-transfer-benchmark.js";
import { runReflectionScenario } from "./evolution/reflection-benchmark.js";
import type { InstalledTransferSkill } from "./evolution/reflection-skill-transfer-benchmark.js";
import { createReflectionSkillCandidate } from "./evolution/reflection-skills.js";
import { calibrateCustomTypeScriptTestFixture, compareTypeScriptTestQualityRuns } from "./evolution/typescript-test-quality-benchmark.js";
import { createModelRouter } from "./models/model-router.js";
import { atomicWriteFile, safeStorageKey } from "./persistence/artifact-store.js";
import { createFileObjectStore } from "./persistence/object-store.js";

const PROJECT_ID = "project_feedback_skill_transfer_v1" as ProjectId;
const INCUMBENT_ID = "harness_feedback_skill_transfer_incumbent_v1" as HarnessId;
const SOURCE_SESSION_ID = "session_feedback_skill_learning_v1" as SessionId;
const TYPESCRIPT_BIN = join(resolve(import.meta.dirname, ".."), "node_modules", ".bin", "tsc");
const NODE_TYPE_ROOTS = join(resolve(import.meta.dirname, ".."), "node_modules", "@types");

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const replicates = Number(argv[0] ?? "1");
  if (!Number.isSafeInteger(replicates) || replicates < 1 || replicates > 3) {
    process.stderr.write("Usage: pnpm benchmark:feedback-skill-transfer [replicates:1-3]\n");
    return 1;
  }
  const root = resolve(process.env["OMEGA_HOME"] ?? join(homedir(), ".omega")) as AbsolutePath;
  const models = createModelRouter(DEFAULT_CONFIG.models, process.env);
  const objects = createFileObjectStore(root);
  const training = feedbackTrainingFixture();
  const fixtures = [training, ...FEEDBACK_TRANSFER_FIXTURES];

  process.stderr.write(`feedback-skill-transfer: calibrating ${fixtures.length} mutation fixtures\n`);
  const calibrations = [];
  for (const item of fixtures) {
    const calibration = await calibrateCustomTypeScriptTestFixture(item.fixture, item.referenceFiles, "omega-runner:local", TYPESCRIPT_BIN, NODE_TYPE_ROOTS);
    const valid = calibration.seed.nativePass && calibration.seed.typecheckPass
      && calibration.seed.killedMutationIds.length < item.fixture.mutations.length
      && calibration.reference.nativePass && calibration.reference.typecheckPass
      && calibration.reference.killedMutationIds.length === item.fixture.mutations.length
      && calibration.reference.inconclusiveMutationIds.length === 0;
    if (!valid) {
      process.stderr.write(`${JSON.stringify({ error: "fixture-calibration-failed", fixtureId: item.fixture.id, calibration })}\n`);
      return 2;
    }
    calibrations.push({ fixtureId: item.fixture.id, calibration });
  }

  process.stderr.write("feedback-skill-transfer: starting vague learning episode\n");
  const learned = await runFeedbackEpisode(models, {
    fixture: training.fixture,
    objective: "Create good tests for src/plan-dispatch.ts. Do not modify production code.",
    condition: "incumbent",
    harnessId: INCUMBENT_ID,
    installedSkills: [],
    replicate: 0,
    maxFeedbackRounds: 3,
    typeScriptBin: TYPESCRIPT_BIN,
    nodeTypeRoots: NODE_TYPE_ROOTS,
    onProgress: progress("learning"),
  });
  if (!learned.ok) return fail(3, learned.error);
  if (!learned.value.reachedQuality || learned.value.feedbackCount === 0) {
    const status = learned.value.reachedQuality ? "no-learning-signal" : "learning-budget-exhausted";
    const record = { kind: "feedback-skill-transfer-benchmark", version: 1, status, learning: learned.value, calibrations, createdAt: new Date().toISOString() } as const;
    const recordPath = await persist(root, record);
    process.stdout.write(`${JSON.stringify({ ...record, recordPath }, null, 2)}\n`);
    return 4;
  }

  process.stderr.write(`feedback-skill-transfer: reflecting over ${learned.value.feedbackCount} user correction(s)\n`);
  const reflected = await runReflectionScenario(models, learned.value.reflectionScenario);
  if (!reflected.ok) return fail(5, reflected.error);
  const incumbent = incumbentHarness();
  const memoryHarnesses: Pick<HarnessRepository, "putComponent" | "putHarness"> = {
    async putComponent(component) { return { ok: true, value: component }; },
    async putHarness(harness) { return { ok: true, value: harness }; },
  };
  const candidate = await createReflectionSkillCandidate({
    incumbent,
    proposal: reflected.value.proposal,
    sourceSessionId: SOURCE_SESSION_ID,
    evidenceArtifactIds: [`artifact_feedback_trace_${reflected.value.evidenceSha}` as ArtifactId],
    proposalArtifactId: `artifact_feedback_reflection_${reflected.value.evidenceSha}` as ArtifactId,
    alias: "feedback-skill-transfer-candidate",
    createdAt: new Date().toISOString() as Timestamp,
  }, objects, memoryHarnesses);
  if (!candidate.ok) return fail(6, candidate.error);
  const installed = await loadInstalledSkills(objects, candidate.value);
  if (!installed.ok) return fail(7, installed.error);

  const episodes: FeedbackEpisode[] = [];
  let order = 0;
  for (let replicate = 1; replicate <= replicates; replicate += 1) {
    for (const item of FEEDBACK_TRANSFER_FIXTURES) {
      const conditions: readonly FeedbackEpisode["condition"][] = replicate % 2 === 1 ? ["incumbent", "candidate"] : ["candidate", "incumbent"];
      for (const condition of conditions) {
        order += 1;
        process.stderr.write(`feedback-skill-transfer: holdout ${order}/${replicates * FEEDBACK_TRANSFER_FIXTURES.length * 2} ${item.fixture.id} ${condition}\n`);
        const episode = await runFeedbackEpisode(models, {
          fixture: item.fixture,
          objective: item.objective,
          condition,
          harnessId: condition === "candidate" ? candidate.value.id : incumbent.id,
          installedSkills: condition === "candidate" ? installed.value : [],
          replicate,
          maxFeedbackRounds: 2,
          typeScriptBin: TYPESCRIPT_BIN,
          nodeTypeRoots: NODE_TYPE_ROOTS,
          onProgress: progress(`${item.fixture.id} ${condition}`),
        });
        if (!episode.ok) return fail(8, episode.error);
        episodes.push(episode.value);
      }
    }
  }

  const pairs = [];
  for (let replicate = 1; replicate <= replicates; replicate += 1) {
    for (const fixture of FEEDBACK_TRANSFER_FIXTURES) {
      const incumbentEpisode = episodes.find((episode) => episode.fixtureId === fixture.fixture.id && episode.condition === "incumbent"
        && episode.rounds[0]?.run.replicate === replicate * 10);
      const candidateEpisode = episodes.find((episode) => episode.fixtureId === fixture.fixture.id && episode.condition === "candidate"
        && episode.rounds[0]?.run.replicate === replicate * 10);
      if (incumbentEpisode === undefined || candidateEpisode === undefined) continue;
      const comparison = compareFeedbackTransferEpisodes(incumbentEpisode, candidateEpisode);
      const firstAttemptRoute = compareTypeScriptTestQualityRuns(incumbentEpisode.rounds[0]!.run, candidateEpisode.rounds[0]!.run);
      pairs.push({ replicate, ...comparison, comparable: comparison.comparable && firstAttemptRoute.comparable, routeInvalidReason: firstAttemptRoute.invalidReason });
    }
  }
  const comparable = pairs.filter((pair) => pair.comparable);
  const summary = {
    pairCount: pairs.length,
    comparablePairs: comparable.length,
    incumbentFirstAttemptKills: comparable.reduce((sum, pair) => sum + pair.incumbent.firstAttemptMutationKills, 0),
    candidateFirstAttemptKills: comparable.reduce((sum, pair) => sum + pair.candidate.firstAttemptMutationKills, 0),
    incumbentFeedbackCount: comparable.reduce((sum, pair) => sum + pair.incumbent.feedbackCount, 0),
    candidateFeedbackCount: comparable.reduce((sum, pair) => sum + pair.candidate.feedbackCount, 0),
    incumbentInvalidToolCalls: comparable.reduce((sum, pair) => sum + pair.incumbent.invalidToolCalls, 0),
    candidateInvalidToolCalls: comparable.reduce((sum, pair) => sum + pair.candidate.invalidToolCalls, 0),
    improvedPairs: comparable.filter((pair) => pair.transferImproved).length,
    capabilityImproved: comparable.length === pairs.length && comparable.length > 0
      && comparable.filter((pair) => pair.transferImproved).length > comparable.length / 2
      && comparable.every((pair) => pair.candidate.finalMutationKills >= pair.incumbent.finalMutationKills),
  };
  const record = {
    kind: "feedback-skill-transfer-benchmark",
    version: 1,
    status: "completed",
    methodology: {
      learningPrompt: "vague",
      evaluatorActsAsUserDuringLearning: true,
      reflectionSeesLearningFeedback: true,
      holdoutFeedbackAffectsCandidate: false,
      scoringOrder: ["correctness", "first-attempt-mutation-kills", "feedback-count", "invalid-tool-calls", "resource-use"],
    },
    calibrations,
    learning: learned.value,
    reflection: reflected.value,
    candidateHarnessId: candidate.value.id,
    installedSkillCatalog: installed.value.map((skill) => skill.catalog),
    replicates,
    summary,
    pairs,
    createdAt: new Date().toISOString(),
  } as const;
  const recordPath = await persist(root, record);
  process.stdout.write(`${JSON.stringify({ kind: record.kind, status: record.status, summary, recordPath }, null, 2)}\n`);
  return 0;
}

function incumbentHarness(): HarnessManifest {
  return { id: INCUMBENT_ID, projectId: PROJECT_ID, alias: "feedback-skill-transfer-incumbent", parents: [], components: [], sourceArtifacts: [], createdAt: "2026-07-20T00:00:00.000Z" as Timestamp };
}

async function loadInstalledSkills(objects: ObjectStore, harness: HarnessManifest): Promise<Result<readonly InstalledTransferSkill[], StoreError>> {
  const skills: InstalledTransferSkill[] = [];
  for (const component of harness.components.filter((item) => item.kind === "skill")) {
    const markdown = await objectText(objects, component.objectHash);
    if (!markdown.ok) return markdown;
    skills.push({ catalog: {
      componentId: component.id,
      name: frontmatter(markdown.value, "name") ?? String(component.id),
      description: frontmatter(markdown.value, "description") ?? String(component.id),
      tags: frontmatterArray(markdown.value, "tags"),
      relevantPaths: frontmatterArray(markdown.value, "relevantPaths") as import("./contracts/index.js").RelativePath[],
      appliesWhen: frontmatterArray(markdown.value, "appliesWhen"),
      doesNotApplyWhen: frontmatterArray(markdown.value, "doesNotApplyWhen"),
    }, markdown: markdown.value });
  }
  return { ok: true, value: skills };
}

async function objectText(objects: ObjectStore, hash: ComponentManifest["objectHash"]): Promise<Result<string, StoreError>> {
  const found = await objects.get(hash);
  if (!found.ok) return found;
  const chunks: Uint8Array[] = [];
  for await (const chunk of found.value) chunks.push(chunk);
  return { ok: true, value: Buffer.concat(chunks).toString("utf8") };
}

function frontmatter(markdown: string, field: string): string | null {
  const value = new RegExp(`^${field}:\\s*(.+?)\\s*$`, "mu").exec(markdown)?.[1]?.trim();
  return value === undefined ? null : value.startsWith("\"") && value.endsWith("\"") ? value.slice(1, -1) : value;
}

function frontmatterArray(markdown: string, field: string): string[] {
  const raw = frontmatter(markdown, field);
  if (raw === null || !raw.startsWith("[") || !raw.endsWith("]")) return [];
  try { const value: unknown = JSON.parse(raw); if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value; } catch { /* YAML flow fallback. */ }
  const body = raw.slice(1, -1).trim();
  return body.length === 0 ? [] : body.split(",").map((item) => item.trim()).filter(Boolean);
}

async function persist(root: AbsolutePath, record: object): Promise<string> {
  const signature = createHash("sha256").update(JSON.stringify(record), "utf8").digest("hex");
  const path = join(root, "benchmarks", "feedback-skill-transfer", `${safeStorageKey(signature)}.json`);
  await atomicWriteFile(path, `${JSON.stringify(record)}\n`);
  return path;
}

function fail(code: number, error: unknown): number { process.stderr.write(`${JSON.stringify(error)}\n`); return code; }

function progress(label: string) {
  return (event: { readonly round: number; readonly kind: "model-turn" | "verification"; readonly turn: number; readonly toolCalls: number }): void => {
    process.stderr.write(`feedback-skill-transfer: ${label} round ${event.round} ${event.kind} ${event.turn} (${event.toolCalls} tool calls)\n`);
  };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) void main().then((code) => { process.exitCode = code; });

export { main as runFeedbackSkillTransferBenchmark };
