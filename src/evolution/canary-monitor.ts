import type {
  BenchmarkRun,
  BenchmarkRunId,
  CanaryResult,
  CanarySource,
  EvolutionError,
  HarnessActivationService,
  HarnessId,
  HarnessRepository,
  Result,
} from "../contracts/index.js";

function notFound(resource: string, id: string): EvolutionError {
  return {
    kind: "not-found",
    resource,
    id,
    recoverable: false,
    callerAction: "propagate",
  };
}

function validation(message: string, field: string): EvolutionError {
  return {
    kind: "validation",
    message,
    field,
    recoverable: true,
    callerAction: "fix-request",
  };
}

export async function recordCanaryEvidence(input: {
  readonly harnessId: HarnessId;
  readonly source: CanarySource;
  readonly benchmarkRuns: ReadonlyMap<BenchmarkRunId, BenchmarkRun>;
  readonly harnesses: HarnessRepository;
  readonly activation: HarnessActivationService;
}): Promise<Result<CanaryResult, EvolutionError>> {
  let regressed = false;
  if (input.source.kind === "benchmark") {
    const run = input.benchmarkRuns.get(input.source.benchmarkRunId);
    if (run === undefined) return { ok: false, error: notFound("benchmark-run", input.source.benchmarkRunId) };
    if (run.harnessId !== input.harnessId) {
      return { ok: false, error: validation("Canary evidence must name the evaluated harness.", "harnessId") };
    }
    regressed = run.outcome !== "passed"
      || !run.metrics.verifierPassed
      || !run.metrics.negativeInvariantsPassed;
  }

  if (!regressed) {
    return {
      ok: true,
      value: { harnessId: input.harnessId, source: input.source, outcome: "healthy", action: "retain" },
    };
  }

  const harnessResult = await input.harnesses.getHarness(input.harnessId);
  if (!harnessResult.ok) return harnessResult;
  const rollbackTarget = harnessResult.value.parents[0];
  if (rollbackTarget === undefined) {
    return { ok: false, error: validation("A regressed canary has no parent harness to restore.", "harnessId") };
  }
  const rollback = await input.activation.rollback(
    harnessResult.value.projectId,
    rollbackTarget,
    `Canary regression detected for ${input.harnessId}`,
  );
  if (!rollback.ok) return rollback;

  return {
    ok: true,
    value: {
      harnessId: input.harnessId,
      source: input.source,
      outcome: "regressed",
      action: "rollback-and-quarantine",
    },
  };
}
