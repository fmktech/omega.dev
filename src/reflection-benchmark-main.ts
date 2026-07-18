import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_CONFIG } from "./config/defaults.js";
import type {
  AbsolutePath,
  DurationMs,
  ModelRoleRoute,
  TokenCount,
  UsdMicros,
} from "./contracts/index.js";
import { REFLECTION_SCENARIOS, runReflectionScenario } from "./evolution/reflection-benchmark.js";
import { createModelRouter } from "./models/model-router.js";
import { atomicWriteFile, safeStorageKey } from "./persistence/artifact-store.js";

const VARIANTS: readonly { readonly name: string; readonly route: ModelRoleRoute }[] = [
  {
    name: "deepseek-v4-flash",
    route: DEFAULT_CONFIG.models.routes.find((route) => route.role === "crystallizer") as ModelRoleRoute,
  },
  {
    name: "gpt-5.6-luna",
    route: {
      role: "crystallizer",
      providerId: "openrouter",
      modelId: "openai/gpt-5.6-luna",
      reasoning: { mode: "effort", effort: "high" },
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
      timeoutMs: 300_000 as DurationMs,
      equivalentListPrice: {
        inputUsdMicrosPerMillionTokens: 1_000_000 as UsdMicros,
        cachedInputUsdMicrosPerMillionTokens: 100_000 as UsdMicros,
        outputUsdMicrosPerMillionTokens: 6_000_000 as UsdMicros,
      },
    },
  },
];

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const root = resolve(process.env["OMEGA_HOME"] ?? join(homedir(), ".omega")) as AbsolutePath;
  const requestedVariant = argv[0];
  const selectedVariants = requestedVariant === undefined
    ? VARIANTS
    : VARIANTS.filter((variant) => variant.name === requestedVariant);
  if (selectedVariants.length === 0) {
    process.stderr.write(`Unknown reflection variant ${requestedVariant}. Expected one of: ${VARIANTS.map((variant) => variant.name).join(", ")}\n`);
    return 1;
  }
  const variants = [];
  for (const variant of selectedVariants) {
    const config = {
      ...DEFAULT_CONFIG.models,
      routes: DEFAULT_CONFIG.models.routes.map((route) => route.role === "crystallizer" ? variant.route : route),
    };
    const models = createModelRouter(config, process.env);
    const runs = [];
    let failure: { readonly scenarioId: string; readonly error: unknown } | null = null;
    for (const scenario of REFLECTION_SCENARIOS) {
      const run = await runReflectionScenario(models, scenario);
      if (!run.ok) {
        failure = { scenarioId: scenario.id, error: run.error };
        break;
      }
      runs.push(run.value);
    }
    variants.push({
      name: variant.name,
      modelId: variant.route.modelId,
      points: runs.reduce((total, run) => total + run.score.points, 0),
      possiblePoints: runs.reduce((total, run) => total + run.score.possiblePoints, 0),
      completedScenarioCount: runs.length,
      failure,
      usage: {
        inputTokens: runs.reduce((total, run) => total + Number(run.usage.inputTokens), 0),
        reasoningTokens: runs.reduce((total, run) => total + Number(run.usage.reasoningTokens), 0),
        outputTokens: runs.reduce((total, run) => total + Number(run.usage.outputTokens), 0),
        costUsdMicros: runs.reduce((total, run) => total + Number(run.usage.costUsdMicros), 0),
      },
      runs,
    });
  }
  const record = {
    kind: "reflection-component-benchmark",
    version: 1,
    scenarioCount: REFLECTION_SCENARIOS.length,
    downstreamAgentRuns: 0,
    variants,
    createdAt: new Date().toISOString(),
  } as const;
  const signature = variants.map((variant) => `${variant.modelId}-${variant.points}`).join("-");
  const recordPath = join(root, "benchmarks", "reflections", `${safeStorageKey(signature)}.json`);
  await atomicWriteFile(recordPath, `${JSON.stringify(record)}\n`);
  process.stdout.write(`${JSON.stringify({ ...record, recordPath }, null, 2)}\n`);
  return variants.some((variant) => variant.failure !== null) ? 2 : 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main().then((code) => { process.exitCode = code; });
}

export { main as runReflectionBenchmark };
