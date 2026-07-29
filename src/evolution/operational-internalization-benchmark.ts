import type { ReflectionRun } from "./reflection-benchmark.js";
import type { InstalledTransferSkill } from "./reflection-skill-transfer-benchmark.js";
import type { WorkspaceSkillPair, WorkspaceSkillRun } from "./workspace-skill-transfer-benchmark.js";

export const OPERATIONAL_DIMENSION_IDS = [
  "capture", "crystallization", "retrieval", "application", "internalization", "transfer", "inhibition",
  "correctness", "intervention", "tool-validity", "tool-economy", "model-economy", "latency", "durability", "scope",
] as const;

export type OperationalDimensionId = typeof OPERATIONAL_DIMENSION_IDS[number];
export type OperationalDimension = {
  readonly id: OperationalDimensionId;
  readonly met: boolean | null;
  readonly comparison: "improved" | "tied" | "regressed" | "not-applicable";
  readonly incumbent: number | string | null;
  readonly candidate: number | string | null;
  readonly evidence: string;
};

export type OperationalInternalizationAssessment = {
  readonly verdict: "worked" | "mixed" | "failed";
  readonly dimensions: readonly OperationalDimension[];
};

const REQUIRED: readonly OperationalDimensionId[] = [
  "capture", "crystallization", "retrieval", "application", "internalization", "transfer", "inhibition",
  "correctness", "durability", "scope",
];

export function assessOperationalInternalization(input: {
  readonly reflection: ReflectionRun;
  readonly installedSkills: readonly InstalledTransferSkill[];
  readonly pairs: readonly WorkspaceSkillPair[];
}): OperationalInternalizationAssessment {
  const relevant = input.pairs.filter((pair) => pair.candidate.score !== undefined && operationalScenario(pair.scenarioId) === "darwin");
  const negative = input.pairs.filter((pair) => operationalScenario(pair.scenarioId) === "linux");
  const captureMet = input.reflection.score.dimensions.grounded && input.reflection.score.dimensions.concepts.every(Boolean);
  const crystallizationMet = input.installedSkills.length === 1
    && input.installedSkills[0]!.catalog.appliesWhen.length > 0
    && input.installedSkills[0]!.catalog.doesNotApplyWhen.length > 0;
  const retrievalMet = relevant.length === 2 && relevant.every((pair) => pair.candidate.score.retrievalCorrect);
  const applicationRuns = relevant.map((pair) => commandApplication(pair.candidate));
  const applicationMet = applicationRuns.length === 2 && applicationRuns.every(Boolean);
  const generalized = relevant.find((pair) => pair.scenarioId === "operational-macos-lockout");
  const transferMet = generalized !== undefined && generalized.candidate.score.workspacePassed && commandApplication(generalized.candidate);
  const inhibitionMet = negative.length === 1 && negative.every((pair) => pair.candidate.score.retrievalCorrect && linuxCommandApplied(pair.candidate));
  const candidateCorrect = input.pairs.filter((pair) => pair.candidate.score.workspacePassed).length;
  const incumbentCorrect = input.pairs.filter((pair) => pair.incumbent.score.workspacePassed).length;
  const correctnessMet = input.pairs.length === 3 && input.pairs.every((pair) => pair.comparable)
    && candidateCorrect === input.pairs.length && candidateCorrect >= incumbentCorrect;
  const durabilityMet = relevant.length === 2 && new Set(relevant.map((pair) => pair.candidate.sessionId)).size === 2 && applicationMet;
  const scopeMet = retrievalMet && inhibitionMet;
  const incumbentErrors = sum(input.pairs, (pair) => pair.incumbent.toolErrors.length);
  const candidateErrors = sum(input.pairs, (pair) => pair.candidate.toolErrors.length);
  const incumbentTools = sum(input.pairs, (pair) => pair.incumbent.toolCalls);
  const candidateTools = sum(input.pairs, (pair) => pair.candidate.toolCalls);
  const incumbentCost = sum(input.pairs, (pair) => Number(pair.incumbent.usage.costUsdMicros));
  const candidateCost = sum(input.pairs, (pair) => Number(pair.candidate.usage.costUsdMicros));
  const incumbentLatency = sum(input.pairs, (pair) => pair.incumbent.elapsedMs);
  const candidateLatency = sum(input.pairs, (pair) => pair.candidate.elapsedMs);

  const dimensions: OperationalDimension[] = [
    fact("capture", captureMet, `reflection grounded=${input.reflection.score.dimensions.grounded}; concepts=${input.reflection.score.dimensions.concepts.join(",")}`),
    fact("crystallization", crystallizationMet, `${input.installedSkills.length} installed skill(s); positive and negative applicability required`),
    ratio("retrieval", retrievalMet, 0, relevant.filter((pair) => pair.candidate.score.retrievalCorrect).length, "relevant skill reads; incumbent has no installed skill"),
    ratio("application", applicationMet, relevant.filter((pair) => commandApplication(pair.incumbent)).length, applicationRuns.filter(Boolean).length, "first deadline command was environment-correct"),
    fact("internalization", applicationMet, `${applicationRuns.filter(Boolean).length}/${relevant.length} fresh macOS sessions applied the correction without a preceding learned-command failure`),
    ratio("transfer", transferMet, generalized !== undefined && commandApplication(generalized.incumbent) ? 1 : 0, transferMet ? 1 : 0, "generalized lockout task"),
    ratio("inhibition", inhibitionMet, negative.filter((pair) => pair.incumbent.score.retrievalCorrect && linuxCommandApplied(pair.incumbent)).length, negative.filter((pair) => pair.candidate.score.retrievalCorrect && linuxCommandApplied(pair.candidate)).length, "Linux negative control"),
    ratio("correctness", correctnessMet, incumbentCorrect, candidateCorrect, "workspace holdouts passed"),
    { id: "intervention", met: null, comparison: "not-applicable", incumbent: null, candidate: null, evidence: "not measured: sealed holdouts prohibited evaluator correction" },
    quantity("tool-validity", incumbentErrors, candidateErrors, true, "failed or invalid tool calls"),
    quantity("tool-economy", incumbentTools, candidateTools, true, "tool calls"),
    quantity("model-economy", incumbentCost, candidateCost, true, "equivalent cost in USD micros"),
    quantity("latency", incumbentLatency, candidateLatency, true, "aggregate wall time in milliseconds"),
    fact("durability", durabilityMet, `${new Set(relevant.map((pair) => pair.candidate.sessionId)).size} distinct candidate sessions`),
    fact("scope", scopeMet, "macOS relevant retrievals and Linux non-retrieval both required"),
  ];
  const requiredMet = REQUIRED.every((id) => dimensions.find((dimension) => dimension.id === id)?.met === true);
  const regression = dimensions.some((dimension) => dimension.comparison === "regressed");
  const behavioralApplication = applicationMet && transferMet;
  const verdict = requiredMet && !regression ? "worked" : !crystallizationMet || !behavioralApplication ? "failed" : "mixed";
  return { verdict, dimensions };
}

function operationalScenario(id: string): "darwin" | "linux" | null {
  if (id === "operational-macos-timeout" || id === "operational-macos-lockout") return "darwin";
  if (id === "operational-linux-negative-control") return "linux";
  return null;
}

function commandApplication(run: WorkspaceSkillRun): boolean {
  const deadline = run.processCalls.find((call) => /(^|\s)g?timeout\s+10\s+(?:sh\s+)?(?:\.\/)?verify-auth(?=$|\s)/u.test(call));
  return deadline !== undefined && /(^|\s)gtimeout\s+10\s+(?:sh\s+)?(?:\.\/)?verify-auth(?=$|\s)/u.test(deadline)
    && !run.toolErrors.some((error) => error.includes("command not found: timeout"));
}

function linuxCommandApplied(run: WorkspaceSkillRun): boolean {
  return run.processCalls.some((call) => /(^|\s)timeout\s+10\s+(?:sh\s+)?(?:\.\/)?verify-auth(?=$|\s)/u.test(call))
    && !run.processCalls.some((call) => /(^|\s)gtimeout\s/u.test(call));
}

function fact(id: OperationalDimensionId, met: boolean, evidence: string): OperationalDimension {
  return { id, met, comparison: "not-applicable", incumbent: null, candidate: met ? "met" : "not-met", evidence };
}

function ratio(id: OperationalDimensionId, met: boolean, incumbent: number, candidate: number, evidence: string): OperationalDimension {
  return { id, met, comparison: candidate > incumbent ? "improved" : candidate < incumbent ? "regressed" : "tied", incumbent, candidate, evidence };
}

function quantity(id: OperationalDimensionId, incumbent: number, candidate: number, lowerIsBetter: boolean, evidence: string): OperationalDimension {
  const comparison = candidate === incumbent ? "tied" : (candidate < incumbent) === lowerIsBetter ? "improved" : "regressed";
  return { id, met: candidate <= incumbent, comparison, incumbent, candidate, evidence };
}

function sum(pairs: readonly WorkspaceSkillPair[], value: (pair: WorkspaceSkillPair) => number): number {
  return pairs.reduce((total, pair) => total + value(pair), 0);
}
