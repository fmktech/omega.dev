import type {
  EvolutionError,
  HarnessError,
  HarnessManifest,
  Result,
} from "../contracts/index.js";
import {
  compileProjectExperience,
  CRYSTALLIZATION_TRAJECTORY_CYCLES,
  crystallizationTrajectoriesThroughCycle,
  type CrystallizationRun,
  type WorkTrajectory,
} from "./crystallization-benchmark.js";

export type ContinualCrystallizationStep = {
  readonly cycle: number;
  readonly crystallizationAttempts: number;
  readonly parentHarnessId: HarnessManifest["id"];
  readonly candidateHarnessId: HarnessManifest["id"];
  readonly evidenceSha: CrystallizationRun["evidenceSha"];
  readonly sourceTrajectoryIds: readonly string[];
  readonly proposal: CrystallizationRun["proposal"];
  readonly route: CrystallizationRun["route"];
  readonly usage: CrystallizationRun["usage"];
};

const MAX_CRYSTALLIZATION_ATTEMPTS = 3;

function retryableModelOutput(error: EvolutionError): boolean {
  return error.kind === "validation" && typeof error.field === "string" && error.field.startsWith("modelOutput");
}

export type ContinualCrystallizationRun = {
  readonly initialHarnessId: HarnessManifest["id"];
  readonly finalHarness: HarnessManifest;
  readonly steps: readonly ContinualCrystallizationStep[];
};

export type ContinualCrystallizationDependencies = {
  readonly crystallize: (
    parentHarnessId: HarnessManifest["id"],
    trajectories: readonly WorkTrajectory[],
  ) => Promise<Result<CrystallizationRun, EvolutionError>>;
  readonly install: (
    parent: HarnessManifest,
    guidance: string,
  ) => Promise<Result<HarnessManifest, HarnessError>>;
};

/**
 * Models ordinary project work: every structurally valid reflection becomes the
 * harness used by the next workday. There is deliberately no benchmark,
 * scorecard, evaluator, promotion decision, or rollback dependency here.
 */
export async function evolveContinualWorkstream(
  initial: HarnessManifest,
  dependencies: ContinualCrystallizationDependencies,
): Promise<Result<ContinualCrystallizationRun, EvolutionError | HarnessError>> {
  let parent = initial;
  const steps: ContinualCrystallizationStep[] = [];

  for (let cycle = 1; cycle <= CRYSTALLIZATION_TRAJECTORY_CYCLES.length; cycle += 1) {
    const trajectories = crystallizationTrajectoriesThroughCycle(cycle);
    if (!trajectories.ok) return trajectories;
    let crystallized: CrystallizationRun | null = null;
    let crystallizationAttempts = 0;
    for (let attempt = 1; attempt <= MAX_CRYSTALLIZATION_ATTEMPTS; attempt += 1) {
      crystallizationAttempts = attempt;
      const result = await dependencies.crystallize(parent.id, trajectories.value);
      if (result.ok) {
        crystallized = result.value;
        break;
      }
      if (!retryableModelOutput(result.error) || attempt === MAX_CRYSTALLIZATION_ATTEMPTS) return result;
    }
    if (crystallized === null) throw new Error("Crystallization retry loop ended without a result.");
    const candidate = await dependencies.install(parent, compileProjectExperience(crystallized.proposal));
    if (!candidate.ok) return candidate;
    steps.push({
      cycle,
      crystallizationAttempts,
      parentHarnessId: parent.id,
      candidateHarnessId: candidate.value.id,
      evidenceSha: crystallized.evidenceSha,
      sourceTrajectoryIds: trajectories.value.map((trajectory) => trajectory.id).sort(),
      proposal: crystallized.proposal,
      route: crystallized.route,
      usage: crystallized.usage,
    });
    parent = candidate.value;
  }

  return {
    ok: true,
    value: {
      initialHarnessId: initial.id,
      finalHarness: parent,
      steps,
    },
  };
}
