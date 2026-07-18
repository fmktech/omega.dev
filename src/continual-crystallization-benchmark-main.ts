import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_CONFIG } from "./config/defaults.js";
import type { AbsolutePath, HarnessId, ProjectId } from "./contracts/index.js";
import { crystallizeWorkTrajectories } from "./evolution/crystallization-benchmark.js";
import { evolveContinualWorkstream } from "./evolution/continual-crystallization.js";
import { createHarnessRepository } from "./harness/harness-repository.js";
import { createExperienceFedMiniSweCandidate } from "./harness/mini-swe-baseline.js";
import { createModelRouter } from "./models/model-router.js";
import { atomicWriteFile, safeStorageKey } from "./persistence/artifact-store.js";
import { createFileObjectStore } from "./persistence/object-store.js";
import { createFileProjectRepository } from "./persistence/project-repository.js";

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const projectId = argv[0] as ProjectId | undefined;
  const initialHarnessId = argv[1] as HarnessId | undefined;
  if (projectId === undefined || initialHarnessId === undefined) {
    process.stderr.write("Usage: pnpm benchmark:continual-crystallize <project-id> <initial-harness-id>\n");
    return 1;
  }

  const root = resolve(process.env["OMEGA_HOME"] ?? join(homedir(), ".omega")) as AbsolutePath;
  const objects = createFileObjectStore(root);
  const projects = createFileProjectRepository(root, objects);
  const harnesses = createHarnessRepository(root, objects, projects);
  const initial = await harnesses.getHarness(initialHarnessId);
  if (!initial.ok) {
    process.stderr.write(`${JSON.stringify(initial.error)}\n`);
    return 2;
  }
  if (initial.value.projectId !== projectId) {
    process.stderr.write("Initial harness does not belong to the requested project.\n");
    return 2;
  }
  const activeBefore = await harnesses.getActiveHarness(projectId);
  if (!activeBefore.ok) {
    process.stderr.write(`${JSON.stringify(activeBefore.error)}\n`);
    return 2;
  }

  const models = createModelRouter(DEFAULT_CONFIG.models, process.env);
  const evolved = await evolveContinualWorkstream(initial.value, {
    crystallize: async (parentHarnessId, trajectories) => crystallizeWorkTrajectories(models, parentHarnessId, trajectories),
    install: async (parent, guidance) => createExperienceFedMiniSweCandidate(parent, objects, harnesses, guidance),
  });
  if (!evolved.ok) {
    process.stderr.write(`${JSON.stringify(evolved.error)}\n`);
    return 3;
  }

  const activeAfter = await harnesses.getActiveHarness(projectId);
  if (!activeAfter.ok) {
    process.stderr.write(`${JSON.stringify(activeAfter.error)}\n`);
    return 4;
  }
  if (activeAfter.value.id !== activeBefore.value.id) {
    process.stderr.write("Continual crystallization unexpectedly changed the active project harness.\n");
    return 4;
  }

  const record = {
    kind: "continual-crystallization-workstream",
    version: 1,
    selectionPolicy: "none",
    intermediateEvaluationCount: 0,
    projectId,
    initialHarnessId,
    finalHarnessId: evolved.value.finalHarness.id,
    activeHarnessId: activeAfter.value.id,
    steps: evolved.value.steps,
    createdAt: new Date().toISOString(),
  } as const;
  const recordPath = join(
    root,
    "benchmarks",
    "continual-crystallizations",
    `${safeStorageKey(`${initialHarnessId}-${evolved.value.finalHarness.id}`)}.json`,
  );
  await atomicWriteFile(recordPath, `${JSON.stringify(record)}\n`);
  process.stdout.write(`${JSON.stringify({ ...record, recordPath }, null, 2)}\n`);
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main().then((code) => { process.exitCode = code; });
}

export { main as runContinualCrystallizationBenchmark };
