import { createHash } from "node:crypto";

import type {
  BenchmarkRun,
  BenchmarkTaskId,
  HarnessId,
  PairInvalidReason,
  PairedTaskResult,
  ProjectId,
  PromotionDecision,
  PromotionEvalPolicy,
  PromotionScorecard,
  ScorecardId,
  Timestamp,
} from "../contracts/index.js";

function sameReasoning(left: BenchmarkRun["route"]["reasoning"], right: BenchmarkRun["route"]["reasoning"]): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === "off" && right.mode === "off") return true;
  if (left.mode === "effort" && right.mode === "effort") return left.effort === right.effort;
  if (left.mode === "token-budget" && right.mode === "token-budget") return left.maxTokens === right.maxTokens;
  return false;
}

function sameBudget(left: BenchmarkRun["effectiveBudget"], right: BenchmarkRun["effectiveBudget"]): boolean {
  return left.wallTimeMs === right.wallTimeMs
    && left.maxModelCalls === right.maxModelCalls
    && left.maxInputTokens === right.maxInputTokens
    && left.maxOutputTokens === right.maxOutputTokens
    && left.maxCostUsdMicros === right.maxCostUsdMicros
    && left.maxProcessStarts === right.maxProcessStarts;
}

export function findPairInvalidReason(incumbent: BenchmarkRun, candidate: BenchmarkRun): PairInvalidReason | null {
  if (
    incumbent.route.providerId !== candidate.route.providerId
    || incumbent.route.modelId !== candidate.route.modelId
    || incumbent.route.variant !== candidate.route.variant
  ) return "different-model";

  if (
    !sameReasoning(incumbent.route.reasoning, candidate.route.reasoning)
    || incumbent.route.temperature !== candidate.route.temperature
    || incumbent.route.topP !== candidate.route.topP
    || incumbent.route.seed !== candidate.route.seed
    || incumbent.route.contextLimit !== candidate.route.contextLimit
    || incumbent.route.outputLimit !== candidate.route.outputLimit
  ) return "different-reasoning";

  if (incumbent.route.servingProvider === null || candidate.route.servingProvider === null) {
    return "provider-metadata-missing";
  }
  if (incumbent.route.servingProvider !== candidate.route.servingProvider) return "different-serving-provider";

  if ((incumbent.route.quantization === null) !== (candidate.route.quantization === null)) {
    return "provider-metadata-missing";
  }
  if (incumbent.route.quantization !== candidate.route.quantization) return "different-quantization";

  if (!sameBudget(incumbent.effectiveBudget, candidate.effectiveBudget)) return "different-budget";
  if (incumbent.fixtureObjectHash !== candidate.fixtureObjectHash) return "different-fixture";
  if (incumbent.environmentObjectHash !== candidate.environmentObjectHash) return "different-environment";
  if (
    incumbent.promotionPolicyId !== candidate.promotionPolicyId
    || incumbent.executionPolicyComponentId !== candidate.executionPolicyComponentId
  ) return "different-policy";
  // The harness component delta is the experimental variable. Each run records
  // its pinned component hashes for audit; requiring equality here would make
  // every genuine harness mutation incomparable by construction.
  return null;
}

export function pairReplicateRuns(
  incumbentRuns: readonly BenchmarkRun[],
  candidateRuns: readonly BenchmarkRun[],
): readonly PairedTaskResult[] {
  const unequal = incumbentRuns.length !== candidateRuns.length;
  const pairCount = Math.min(incumbentRuns.length, candidateRuns.length);
  const results: PairedTaskResult[] = [];
  for (let index = 0; index < pairCount; index += 1) {
    const incumbent = incumbentRuns[index];
    const candidate = candidateRuns[index];
    if (incumbent === undefined || candidate === undefined) continue;
    const taskId = incumbent.taskId;
    const invalidReason = unequal ? "unequal-replicates" : findPairInvalidReason(incumbent, candidate);
    results.push(invalidReason === null
      ? { taskId, incumbent, candidate, comparable: true, invalidReason: null }
      : { taskId, incumbent, candidate, comparable: false, invalidReason });
  }
  return results;
}

function passed(run: BenchmarkRun): boolean {
  return run.outcome === "passed"
    && run.metrics.verifierPassed
    && run.metrics.negativeInvariantsPassed;
}

function unavailable(run: BenchmarkRun): boolean {
  return run.outcome === "provider-unavailable" || run.outcome === "invalid-run";
}

function sumCost(pairs: readonly PairedTaskResult[], side: "incumbent" | "candidate"): number {
  return pairs.reduce((total, pair) => total + pair[side].metrics.equivalentListPriceUsdMicros, 0);
}

function sumLatency(pairs: readonly PairedTaskResult[], side: "incumbent" | "candidate"): number {
  return pairs.reduce((total, pair) => total + pair[side].metrics.wallTimeMs, 0);
}

export type PromotionAssessment = {
  readonly observedSuccessRateDelta: number;
  readonly decision: PromotionDecision;
};

export function assessPromotion(
  pairedResults: readonly PairedTaskResult[],
  policy: PromotionEvalPolicy,
  expectedPairCount: number,
): PromotionAssessment {
  if (pairedResults.length !== expectedPairCount) {
    return {
      observedSuccessRateDelta: 0,
      decision: { outcome: "insufficient-evidence", reason: "The paired run did not produce the manifest-required replicate count." },
    };
  }

  const usable = pairedResults.filter((pair) => pair.comparable && !unavailable(pair.incumbent) && !unavailable(pair.candidate));
  if (usable.length < policy.thresholds.minimumComparablePairs) {
    const availabilityFailures = pairedResults.filter(
      (pair) => unavailable(pair.incumbent) || unavailable(pair.candidate),
    ).length;
    return {
      observedSuccessRateDelta: 0,
      decision: {
        outcome: "insufficient-evidence",
        reason: availabilityFailures > 0
          ? `Only ${usable.length} comparable pairs remained after ${availabilityFailures} provider-availability or invalid-run failures.`
          : `Only ${usable.length} comparable pairs met the minimum of ${policy.thresholds.minimumComparablePairs}.`,
      },
    };
  }

  const incumbentSuccesses = usable.filter((pair) => passed(pair.incumbent)).length;
  const candidateSuccesses = usable.filter((pair) => passed(pair.candidate)).length;
  const observedSuccessRateDelta = (candidateSuccesses - incumbentSuccesses) / usable.length;

  if (usable.some((pair) => !pair.candidate.metrics.negativeInvariantsPassed)) {
    return {
      observedSuccessRateDelta,
      decision: { outcome: "reject", reason: "The candidate violated a non-tradeable security, isolation, or policy invariant." },
    };
  }

  const protectedIds = new Set<BenchmarkTaskId>(policy.protectedTaskIds);
  const protectedRegressions = usable.filter(
    (pair) => protectedIds.has(pair.taskId) && passed(pair.incumbent) && !passed(pair.candidate),
  ).length;
  if (protectedRegressions > policy.thresholds.maximumProtectedRegressions) {
    return {
      observedSuccessRateDelta,
      decision: { outcome: "reject", reason: `The candidate regressed on ${protectedRegressions} protected task pair(s).` },
    };
  }

  if (observedSuccessRateDelta < policy.thresholds.minimumSuccessRateDelta) {
    return {
      observedSuccessRateDelta,
      decision: {
        outcome: "reject",
        reason: `The success-rate delta ${observedSuccessRateDelta.toFixed(4)} did not meet ${policy.thresholds.minimumSuccessRateDelta.toFixed(4)}.`,
      },
    };
  }

  if (observedSuccessRateDelta > 0) {
    return {
      observedSuccessRateDelta,
      decision: { outcome: "promote", reason: "The candidate passed all gates and met the required capability effect threshold." },
    };
  }

  const incumbentCost = sumCost(usable, "incumbent");
  const candidateCost = sumCost(usable, "candidate");
  if (candidateCost < incumbentCost) {
    return {
      observedSuccessRateDelta,
      decision: { outcome: "promote", reason: "Capability was equivalent and the candidate used less equivalent-list-price budget." },
    };
  }
  if (candidateCost > incumbentCost) {
    return {
      observedSuccessRateDelta,
      decision: { outcome: "reject", reason: "Capability was equivalent but the candidate used more equivalent-list-price budget." },
    };
  }

  const incumbentLatency = sumLatency(usable, "incumbent");
  const candidateLatency = sumLatency(usable, "candidate");
  if (candidateLatency < incumbentLatency) {
    return {
      observedSuccessRateDelta,
      decision: { outcome: "promote", reason: "Capability and cost were equivalent and the candidate completed with lower latency." },
    };
  }
  return {
    observedSuccessRateDelta,
    decision: { outcome: "reject", reason: "The candidate showed no capability, cost, or latency improvement." },
  };
}

function scorecardId(parts: readonly string[]): ScorecardId {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex") as ScorecardId;
}

export function buildPromotionScorecard(input: {
  readonly projectId: ProjectId;
  readonly incumbentHarnessId: HarnessId;
  readonly candidateHarnessId: HarnessId;
  readonly policy: PromotionEvalPolicy;
  readonly pairedResults: readonly PairedTaskResult[];
  readonly expectedPairCount: number;
  readonly createdAt: Timestamp;
}): PromotionScorecard {
  const assessment = assessPromotion(input.pairedResults, input.policy, input.expectedPairCount);
  return {
    id: scorecardId([
      input.projectId,
      input.incumbentHarnessId,
      input.candidateHarnessId,
      input.policy.id,
      ...input.pairedResults.flatMap((pair) => [pair.incumbent.id, pair.candidate.id]),
    ]),
    projectId: input.projectId,
    suiteId: input.pairedResults[0]?.incumbent.suiteId ?? ("omegabench-10@1" as PromotionScorecard["suiteId"]),
    incumbentHarnessId: input.incumbentHarnessId,
    candidateHarnessId: input.candidateHarnessId,
    evaluatorHarnessId: input.incumbentHarnessId,
    promotionPolicyId: input.policy.id,
    pairedResults: input.pairedResults,
    thresholds: input.policy.thresholds,
    observedSuccessRateDelta: assessment.observedSuccessRateDelta,
    decision: assessment.decision,
    createdAt: input.createdAt,
  };
}
