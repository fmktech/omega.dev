import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_CONFIG } from "./config/defaults.js";
import type {
  AbsolutePath,
  ComponentId,
  HarnessId,
  ModelRoleRoute,
  ModelRouteSignature,
  OmegaConfig,
  RelativePath,
  SessionId,
  TokenCount,
  UsdMicros,
} from "./contracts/index.js";
import type { InstalledTransferSkill } from "./evolution/reflection-skill-transfer-benchmark.js";
import {
  TEST_QUALITY_MUTATIONS,
  calibrateTypeScriptTestQualityFixture,
  compareTypeScriptTestQualityRuns,
  judgeTypeScriptTestQualityRun,
  runTypeScriptTestQualityScenario,
  scoreTypeScriptTestArtifact,
  typescriptTestFixtureFiles,
  type TypeScriptTestJudgeEvidence,
  type TypeScriptTestQualityRun,
  type TypeScriptTestVerification,
} from "./evolution/typescript-test-quality-benchmark.js";
import { createModelRouter } from "./models/model-router.js";
import { atomicWriteFile, safeStorageKey } from "./persistence/artifact-store.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const GRADER_SKILL_PATH = join(PROJECT_ROOT, "skills", "grade-tests-typescript", "SKILL.md");
const GRADER_RUBRIC_PATH = join(PROJECT_ROOT, "skills", "grade-tests-typescript", "references", "rubric.md");
const WRITER_SKILL_PATH = join(PROJECT_ROOT, "skills", "write-tests-typescript", "SKILL.md");
const WRITER_CASE_GATE_PATH = join(PROJECT_ROOT, "skills", "write-tests-typescript", "references", "case-gate.md");
const TYPESCRIPT_BIN = join(PROJECT_ROOT, "node_modules", ".bin", "tsc");
const NODE_TYPE_ROOTS = join(PROJECT_ROOT, "node_modules", "@types");
const INCUMBENT_ID = "harness_ts_test_quality_incumbent_v1" as HarnessId;
const CANDIDATE_ID = "harness_ts_test_quality_candidate_v1" as HarnessId;
const SEED_ID = "harness_ts_test_quality_seed_v1" as HarnessId;

const GEMINI_3_FLASH_PRICE = {
  inputUsdMicrosPerMillionTokens: 500_000 as UsdMicros,
  cachedInputUsdMicrosPerMillionTokens: 500_000 as UsdMicros,
  outputUsdMicrosPerMillionTokens: 3_000_000 as UsdMicros,
} as const;

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const replicates = Number(argv[0] ?? "1");
  if (!Number.isSafeInteger(replicates) || replicates < 1 || replicates > 3) {
    process.stderr.write("Usage: pnpm benchmark:typescript-test-quality [replicates:1-3]\n");
    return 1;
  }
  const [writerSkill, writerCaseGate, graderSkill, graderRubric] = await Promise.all([
    readFile(WRITER_SKILL_PATH, "utf8"), readFile(WRITER_CASE_GATE_PATH, "utf8"),
    readFile(GRADER_SKILL_PATH, "utf8"), readFile(GRADER_RUBRIC_PATH, "utf8"),
  ]);
  const installedSkill = createInstalledSkill(`${writerSkill}\n\n## Bundled case gate\n\n${writerCaseGate}`);
  const authorModels = createModelRouter(DEFAULT_CONFIG.models, process.env);
  const judgeModels = createModelRouter(judgeModelConfig(), process.env);
  const root = resolve(process.env["OMEGA_HOME"] ?? join(homedir(), ".omega")) as AbsolutePath;

  const calibrationKey = digest(JSON.stringify({ fixture: typescriptTestFixtureFiles(), mutations: TEST_QUALITY_MUTATIONS.map((mutation) => mutation.id), verifier: 2 }));
  const calibrationPath = join(root, "benchmarks", "typescript-test-quality", "calibration", `${safeStorageKey(calibrationKey)}.json`);
  const cachedCalibration = await loadCalibration(calibrationPath);
  process.stderr.write(cachedCalibration === null
    ? "typescript-test-quality: calibrating seed and reference suites against nine hidden mutants\n"
    : "typescript-test-quality: using content-addressed fixture calibration\n");
  const calibration = cachedCalibration ?? await calibrateTypeScriptTestQualityFixture("omega-runner:local", TYPESCRIPT_BIN, NODE_TYPE_ROOTS);
  if (!calibration.seed.nativePass || !calibration.seed.typecheckPass || calibration.seed.killedMutationIds.length > 2
    || calibration.seed.inconclusiveMutationIds.length > 0
    || !calibration.reference.nativePass || !calibration.reference.typecheckPass
    || calibration.reference.inconclusiveMutationIds.length > 0
    || calibration.reference.killedMutationIds.length !== TEST_QUALITY_MUTATIONS.length) {
    process.stderr.write(`${JSON.stringify({ error: "fixture-calibration-failed", calibration }, null, 2)}\n`);
    return 2;
  }
  if (cachedCalibration === null) await atomicWriteFile(calibrationPath, `${JSON.stringify(calibration)}\n`);

  process.stderr.write("typescript-test-quality: grading the sparse seed suite with Gemini 3 Flash\n");
  const seedBase = seedRun(calibration.seed);
  const seedJudge = await judgeWithRetries(judgeModels, seedBase, graderSkill, graderRubric);
  if (seedJudge === null) return 3;
  const seed = { ...seedBase, judge: seedJudge };

  const runs: TypeScriptTestQualityRun[] = [];
  let order = 0;
  for (let replicate = 1; replicate <= replicates; replicate += 1) {
    const conditions: readonly TypeScriptTestQualityRun["condition"][] = replicate % 2 === 1
      ? ["incumbent", "candidate"]
      : ["candidate", "incumbent"];
    for (const condition of conditions) {
      order += 1;
      process.stderr.write(`typescript-test-quality: author ${order}/${replicates * 2} replicate ${replicate} ${condition}\n`);
      const authored = await runTypeScriptTestQualityScenario(authorModels, {
        condition,
        replicate,
        harnessId: condition === "candidate" ? CANDIDATE_ID : INCUMBENT_ID,
        installedSkills: condition === "candidate" ? [installedSkill] : [],
        typeScriptBin: TYPESCRIPT_BIN,
        nodeTypeRoots: NODE_TYPE_ROOTS,
      });
      if (!authored.ok) {
        process.stderr.write(`${JSON.stringify(authored.error)}\n`);
        return 4;
      }
      process.stderr.write(`typescript-test-quality: judge replicate ${replicate} ${condition} with Gemini 3 Flash\n`);
      const judged = await judgeWithRetries(judgeModels, authored.value, graderSkill, graderRubric);
      if (judged === null) return 5;
      runs.push({ ...authored.value, judge: judged });
    }
  }

  const pairs = [];
  for (let replicate = 1; replicate <= replicates; replicate += 1) {
    const incumbent = runs.find((run) => run.replicate === replicate && run.condition === "incumbent");
    const candidate = runs.find((run) => run.replicate === replicate && run.condition === "candidate");
    if (incumbent !== undefined && candidate !== undefined) pairs.push(compareTypeScriptTestQualityRuns(incumbent, candidate));
  }
  const summary = {
    pairCount: pairs.length,
    comparablePairs: pairs.filter((pair) => pair.comparable).length,
    incumbentMutationKills: pairs.reduce((sum, pair) => sum + pair.incumbent.score.killedMutations, 0),
    candidateMutationKills: pairs.reduce((sum, pair) => sum + pair.candidate.score.killedMutations, 0),
    mutationKillDelta: pairs.reduce((sum, pair) => sum + pair.mutationKillDelta, 0),
    seedJudgeScore: seedJudge.report.total,
    incumbentJudgeScore: average(pairs.map((pair) => pair.incumbent.judge?.report.total ?? 0)),
    candidateJudgeScore: average(pairs.map((pair) => pair.candidate.judge?.report.total ?? 0)),
    candidateRetrievalCorrect: runs.filter((run) => run.condition === "candidate" && run.retrievalCorrect).length,
    candidateRetrievalExpected: replicates,
    capabilityImproved: pairs.length === replicates && pairs.every((pair) => pair.capabilityImproved),
  };
  const record = {
    kind: "typescript-test-quality-benchmark",
    version: 1,
    methodology: {
      primaryOracle: "native tests + strict typecheck + two-run stability + source invariant + nine hidden mutation tests",
      secondaryOracle: "independent mechanical 100-point judge",
      authorModel: DEFAULT_CONFIG.models.routes.find((route) => route.role === "main-coder")?.modelId ?? "unconfigured",
      judgeModel: "google/gemini-3-flash-preview",
      evaluationFeedbackToAuthors: false,
      selectionPolicy: "none",
      fixtureSource: "synthetic sparse TypeScript repository calibrated against weak and reference controls",
    },
    skills: {
      writerComponentId: installedSkill.catalog.componentId,
      writerSha256: digest(installedSkill.markdown),
      graderSha256: digest(`${graderSkill}\n${graderRubric}`),
    },
    calibration,
    seed,
    replicates,
    summary,
    pairs,
    createdAt: new Date().toISOString(),
  } as const;
  const signature = digest(JSON.stringify({ version: record.version, createdAt: record.createdAt, pairs: pairs.map((pair) => [pair.incumbent.sessionId, pair.candidate.sessionId]) }));
  const path = join(root, "benchmarks", "typescript-test-quality", `${safeStorageKey(signature)}.json`);
  await atomicWriteFile(path, `${JSON.stringify(record)}\n`);
  process.stdout.write(`${JSON.stringify({ ...record, recordPath: path }, null, 2)}\n`);
  return 0;
}

async function judgeWithRetries(
  models: ReturnType<typeof createModelRouter>,
  run: TypeScriptTestQualityRun,
  skill: string,
  rubric: string,
): Promise<TypeScriptTestJudgeEvidence | null> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await judgeTypeScriptTestQualityRun(models, run, skill, rubric);
    if (result.ok) return result.value;
    process.stderr.write(`typescript-test-quality: judge attempt ${attempt}/3 failed ${JSON.stringify(result.error)}\n`);
    if (result.error.kind !== "validation" || attempt === 3) return null;
  }
  return null;
}

function createInstalledSkill(markdown: string): InstalledTransferSkill {
  const componentId = `component_${digest(markdown)}` as ComponentId;
  return {
    catalog: {
      componentId,
      name: "write-tests-typescript",
      description: "Design mutation-resistant TypeScript tests from behavioral contracts and systematic edge cases.",
      tags: ["typescript", "testing", "test-authoring", "mutation-testing"],
      relevantPaths: ["src" as RelativePath, "tests" as RelativePath, "package.json" as RelativePath],
      appliesWhen: ["The task asks to add, improve, extend, or repair TypeScript tests."],
      doesNotApplyWhen: ["The task only runs existing tests or changes production behavior without test-authoring work."],
    },
    markdown,
  };
}

function seedRun(verification: TypeScriptTestVerification): TypeScriptTestQualityRun {
  return {
    condition: "incumbent",
    replicate: 0,
    harnessId: SEED_ID,
    sessionId: "session_ts_test_quality_seed" as SessionId,
    route: configuredRouteSignature(DEFAULT_CONFIG.models.routes.find((route) => route.role === "main-coder")!),
    providerGenerationIds: [],
    usage: zeroUsage(),
    modelTurns: 0,
    providerRetries: 0,
    toolCalls: 0,
    skillReadComponentIds: [],
    retrievalCorrect: true,
    fileReads: [],
    fileWrites: [],
    processCalls: [],
    toolErrors: [],
    response: "seed fixture",
    finalFiles: typescriptTestFixtureFiles(),
    verification,
    score: scoreTypeScriptTestArtifact({ ...verification, totalMutations: TEST_QUALITY_MUTATIONS.length }),
    judge: null,
  };
}

function judgeModelConfig(): OmegaConfig["models"] {
  const routes = DEFAULT_CONFIG.models.routes.map((route): ModelRoleRoute => route.role !== "promotion-evaluator" ? route : {
    ...route,
    modelId: "google/gemini-3-flash-preview",
    reasoning: { mode: "effort", effort: "medium" },
    selection: {
      kind: "openrouter",
      mode: "balanced",
      providerOrder: [],
      allowFallbacks: true,
      requireParameters: true,
      dataCollection: "allow",
      zeroDataRetention: null,
    },
    temperature: 0,
    topP: null,
    seed: null,
    contextLimit: 1_000_000 as TokenCount,
    maxOutputTokens: 16_384 as TokenCount,
    equivalentListPrice: GEMINI_3_FLASH_PRICE,
  });
  return { providers: DEFAULT_CONFIG.models.providers, routes };
}

function configuredRouteSignature(route: ModelRoleRoute): ModelRouteSignature {
  return {
    role: route.role,
    providerId: route.providerId,
    modelId: route.modelId,
    variant: null,
    servingProvider: null,
    quantization: null,
    reasoning: route.reasoning,
    temperature: route.temperature,
    topP: route.topP,
    seed: route.seed,
    contextLimit: route.contextLimit,
    outputLimit: route.maxOutputTokens,
    equivalentListPrice: route.equivalentListPrice,
  };
}

function zeroUsage() {
  return { inputTokens: 0 as TokenCount, cachedInputTokens: 0 as TokenCount, reasoningTokens: 0 as TokenCount, outputTokens: 0 as TokenCount, costUsdMicros: 0 as UsdMicros };
}

async function loadCalibration(path: string): Promise<{ readonly seed: TypeScriptTestVerification; readonly reference: TypeScriptTestVerification } | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed) || !verification(parsed["seed"]) || !verification(parsed["reference"])) return null;
    return { seed: parsed["seed"], reference: parsed["reference"] };
  } catch { return null; }
}

function verification(value: unknown): value is TypeScriptTestVerification {
  return isRecord(value) && ["sourcePreserved", "nativePass", "repeatedPass", "typecheckPass"].every((key) => typeof value[key] === "boolean")
    && ["killedMutationIds", "survivingMutationIds", "inconclusiveMutationIds"].every((key) => stringArray(value[key]))
    && Array.isArray(value["runs"]);
}

function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function average(values: readonly number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main().then((code) => { process.exitCode = code; });
}

export { main as runTypeScriptTestQualityBenchmark };
