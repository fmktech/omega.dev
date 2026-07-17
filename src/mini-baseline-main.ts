import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { AbsolutePath, HarnessId, ProjectId } from "./contracts/index.js";
import { createHarnessRepository } from "./harness/harness-repository.js";
import { createMiniSweBaselineCandidate } from "./harness/mini-swe-baseline.js";
import { createFileObjectStore } from "./persistence/object-store.js";
import { createFileProjectRepository } from "./persistence/project-repository.js";

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const projectId = argv[0] as ProjectId | undefined;
  if (projectId === undefined) {
    process.stderr.write("Usage: pnpm benchmark:mini-install <project-id> [parent-harness-id]\n");
    return 1;
  }
  const root = resolve(process.env["OMEGA_HOME"] ?? join(homedir(), ".omega")) as AbsolutePath;
  const objects = createFileObjectStore(root);
  const projects = createFileProjectRepository(root, objects);
  const harnesses = createHarnessRepository(root, objects, projects);
  const parent = argv[1] === undefined
    ? await harnesses.getActiveHarness(projectId)
    : await harnesses.getHarness(argv[1] as HarnessId);
  if (!parent.ok) {
    process.stderr.write(`${JSON.stringify(parent.error)}\n`);
    return 2;
  }
  const candidate = await createMiniSweBaselineCandidate(parent.value, objects, harnesses);
  if (!candidate.ok) {
    process.stderr.write(`${JSON.stringify(candidate.error)}\n`);
    return 2;
  }
  process.stdout.write(`${JSON.stringify({ candidateHarnessId: candidate.value.id, parentHarnessId: parent.value.id, alias: candidate.value.alias }, null, 2)}\n`);
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main().then((code) => { process.exitCode = code; });
}

export { main as installMiniSweBaseline };
