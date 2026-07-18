import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_CONFIG } from "./config/defaults.js";
import type { AbsolutePath, HarnessId, ModelRoleRoute, ProjectId } from "./contracts/index.js";
import {
  compileProjectExperience,
  CRYSTALLIZATION_TRAJECTORIES,
  crystallizeWorkTrajectories,
} from "./evolution/crystallization-benchmark.js";
import { createHarnessRepository } from "./harness/harness-repository.js";
import { createExperienceFedMiniSweCandidate } from "./harness/mini-swe-baseline.js";
import { createModelRouter } from "./models/model-router.js";
import { atomicWriteFile, safeStorageKey } from "./persistence/artifact-store.js";
import { createFileObjectStore } from "./persistence/object-store.js";
import { createFileProjectRepository } from "./persistence/project-repository.js";

function crystallizerRoute(): ModelRoleRoute {
  const evaluator = DEFAULT_CONFIG.models.routes.find((route) => route.role === "promotion-evaluator");
  if (evaluator === undefined) throw new Error("The promotion-evaluator route is not configured.");
  return { ...evaluator, role: "crystallizer" };
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const projectId = argv[0] as ProjectId | undefined;
  const parentHarnessId = argv[1] as HarnessId | undefined;
  if (projectId === undefined || parentHarnessId === undefined) {
    process.stderr.write("Usage: pnpm benchmark:crystallize-install <project-id> <parent-harness-id>\n");
    return 1;
  }
  const root = resolve(process.env["OMEGA_HOME"] ?? join(homedir(), ".omega")) as AbsolutePath;
  const objects = createFileObjectStore(root);
  const projects = createFileProjectRepository(root, objects);
  const harnesses = createHarnessRepository(root, objects, projects);
  const parent = await harnesses.getHarness(parentHarnessId);
  if (!parent.ok) {
    process.stderr.write(`${JSON.stringify(parent.error)}\n`);
    return 2;
  }
  if (parent.value.projectId !== projectId) {
    process.stderr.write("Parent harness does not belong to the requested project.\n");
    return 2;
  }
  const models = createModelRouter(
    { ...DEFAULT_CONFIG.models, routes: DEFAULT_CONFIG.models.routes.map((route) => route.role === "crystallizer" ? crystallizerRoute() : route) },
    process.env,
  );
  const crystallized = await crystallizeWorkTrajectories(models, parentHarnessId, CRYSTALLIZATION_TRAJECTORIES);
  if (!crystallized.ok) {
    process.stderr.write(`${JSON.stringify(crystallized.error)}\n`);
    return 3;
  }
  const guidance = compileProjectExperience(crystallized.value.proposal);
  const candidate = await createExperienceFedMiniSweCandidate(parent.value, objects, harnesses, guidance);
  if (!candidate.ok) {
    process.stderr.write(`${JSON.stringify(candidate.error)}\n`);
    return 4;
  }
  const active = await harnesses.getActiveHarness(projectId);
  if (!active.ok) {
    process.stderr.write(`${JSON.stringify(active.error)}\n`);
    return 4;
  }
  const record = {
    kind: "crystallization-benchmark-input",
    version: 1,
    projectId,
    parentHarnessId,
    candidateHarnessId: candidate.value.id,
    activeHarnessId: active.value.id,
    evidenceSha: crystallized.value.evidenceSha,
    sourceTrajectoryIds: CRYSTALLIZATION_TRAJECTORIES.map((trajectory) => trajectory.id).sort(),
    proposal: crystallized.value.proposal,
    route: crystallized.value.route,
    usage: crystallized.value.usage,
    createdAt: new Date().toISOString(),
  };
  const recordPath = join(root, "benchmarks", "crystallizations", `${safeStorageKey(`${crystallized.value.evidenceSha}-${candidate.value.id}`)}.json`);
  await atomicWriteFile(recordPath, `${JSON.stringify(record)}\n`);
  process.stdout.write(`${JSON.stringify({ ...record, recordPath }, null, 2)}\n`);
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main().then((code) => { process.exitCode = code; });
}

export { main as installCrystallizedBenchmarkCandidate };
