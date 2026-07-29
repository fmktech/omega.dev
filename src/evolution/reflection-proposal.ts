import type { EvolutionError, Result } from "../contracts/index.js";
import type { CrystallizedLesson, LearningTarget, ObservableContract } from "./learning-types.js";

export type ReflectionProposal = {
  readonly reflection: string;
  readonly decision: "evolve" | "no-change";
  readonly lessons: readonly CrystallizedLesson[];
};

const TARGETS: ReadonlySet<string> = new Set(["knowledge", "skill", "runner", "tool", "policy"]);
const MAX_LESSONS = 4;
const MAX_GUIDANCE_CHARS = 4_096;
const MAX_SCOPE_ITEMS = 24;
const MAX_SCOPE_ITEM_CHARS = 240;
const MAX_OBSERVABLE_CONTRACTS = 24;
const MAX_OPERATION_CHARS = 160;
const IDENTITY_ONLY_EXCLUSION = /\b(?:different|other|another|renamed|separate)\s+(?:project|repository|repo|service|application|app|codebase)\b/iu;
const APPLICABILITY_STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "app", "application", "applies", "behavior", "change", "changes", "codebase",
  "extending", "fixing", "for", "implement", "implementing", "in", "is", "modifying", "of", "on", "or",
  "project", "repository", "repo", "service", "task", "the", "to", "when", "workflow", "working",
]);

export function parseReflectionProposal(
  text: string,
  allowedSourceIds: readonly string[],
  defaultSourceId: string | null = null,
): Result<ReflectionProposal, EvolutionError> {
  let parsed: unknown;
  for (const candidate of [text.trim(), ...jsonObjects(text)]) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      // Providers occasionally prefix a requested JSON object with a sentence.
    }
  }
  if (!isRecord(parsed) || typeof parsed["reflection"] !== "string" || !Array.isArray(parsed["lessons"])
    || (parsed["decision"] !== "evolve" && parsed["decision"] !== "no-change")) {
    return validation("Reflection output must contain reflection, decision, and lessons.", "modelOutput");
  }
  const reflection = parsed["reflection"].trim();
  if (reflection.length === 0) return validation("Reflection synthesis cannot be empty.", "modelOutput.reflection");
  if ((parsed["decision"] === "no-change" && parsed["lessons"].length !== 0)
    || (parsed["decision"] === "evolve" && (parsed["lessons"].length === 0 || parsed["lessons"].length > MAX_LESSONS))) {
    return validation("Decision and lesson count are inconsistent.", "modelOutput.lessons");
  }
  const allowed = new Set(allowedSourceIds);
  const lessons: CrystallizedLesson[] = [];
  for (const [index, value] of parsed["lessons"].entries()) {
    if (!isRecord(value) || !Array.isArray(value["sourceIds"]) || typeof value["target"] !== "string"
      || typeof value["title"] !== "string" || typeof value["guidance"] !== "string" || !TARGETS.has(value["target"])) {
      return validation("Reflection lesson has an invalid shape or target.", `modelOutput.lessons.${index}`);
    }
    const suppliedSourceIds = value["sourceIds"];
    const sourceIds = suppliedSourceIds.length === 0 && defaultSourceId !== null
      ? [defaultSourceId]
      : suppliedSourceIds;
    if (sourceIds.length === 0 || sourceIds.some((id) => typeof id !== "string" || !allowed.has(id))) {
      return validation("Reflection lesson cites unknown or missing evidence references.", `modelOutput.lessons.${index}.sourceIds`);
    }
    const title = value["title"].trim();
    const guidance = value["guidance"].trim();
    if (title.length === 0 || title.length > 120 || guidance.length === 0 || guidance.length > MAX_GUIDANCE_CHARS) {
      return validation("Reflection lesson title or guidance is empty or over limit.", `modelOutput.lessons.${index}`);
    }
    const relevantPaths = stringList(value["relevantPaths"], `modelOutput.lessons.${index}.relevantPaths`);
    if (!relevantPaths.ok) return relevantPaths;
    if (relevantPaths.value.some((path) => !isRelativePath(path))) {
      return validation("Reflection lesson relevantPaths must be repository-relative POSIX paths.", `modelOutput.lessons.${index}.relevantPaths`);
    }
    const appliesWhen = stringList(value["appliesWhen"], `modelOutput.lessons.${index}.appliesWhen`);
    if (!appliesWhen.ok) return appliesWhen;
    const doesNotApplyWhen = stringList(value["doesNotApplyWhen"], `modelOutput.lessons.${index}.doesNotApplyWhen`);
    if (!doesNotApplyWhen.ok) return doesNotApplyWhen;
    const observableContracts = parseObservableContracts(
      value["observableContracts"],
      `modelOutput.lessons.${index}.observableContracts`,
    );
    if (!observableContracts.ok) return observableContracts;
    if (value["target"] === "skill" && (
      relevantPaths.value.length === 0
      || appliesWhen.value.length === 0
      || doesNotApplyWhen.value.length === 0
      || observableContracts.value.length === 0
    )) {
      return validation(
        "Skill lessons require relevantPaths, appliesWhen, doesNotApplyWhen, and observableContracts.",
        `modelOutput.lessons.${index}`,
      );
    }
    if (value["target"] === "skill" && !hasBehaviorLinkedApplicability(appliesWhen.value, observableContracts.value)) {
      return validation(
        "Skill applicability requires at least one behavior-linked trigger that survives renamed projects and domain nouns.",
        `modelOutput.lessons.${index}.appliesWhen`,
      );
    }
    if (value["target"] === "skill" && doesNotApplyWhen.value.some((condition) => IDENTITY_ONLY_EXCLUSION.test(condition))) {
      return validation(
        "Skill negative applicability must describe a behavioral boundary, not exclude renamed projects or services.",
        `modelOutput.lessons.${index}.doesNotApplyWhen`,
      );
    }
    lessons.push({
      sourceIds: [...new Set(sourceIds as string[])].sort(),
      target: value["target"] as LearningTarget,
      title,
      guidance,
      relevantPaths: relevantPaths.value,
      appliesWhen: appliesWhen.value,
      doesNotApplyWhen: doesNotApplyWhen.value,
      observableContracts: observableContracts.value,
    });
  }
  return { ok: true, value: { reflection, decision: parsed["decision"], lessons } };
}

function hasBehaviorLinkedApplicability(
  conditions: readonly string[],
  contracts: readonly ObservableContract[],
): boolean {
  return contracts.every((contract) => conditions.some((condition) => conditionMatchesContract(condition, contract)));
}

function conditionMatchesContract(condition: string, contract: ObservableContract): boolean {
  const contractText = [
    contract.operation,
    ...contract.inputs,
    ...contract.outputs,
    ...contract.errors,
    ...contract.sideEffects,
    ...contract.exactValues,
  ].join(" ");
  const contractTokens = new Set(meaningfulTokens(contractText));
  const exactValues = contract.exactValues
    .map((value) => normalizedPhrase(value))
    .filter((value) => value.length >= 3 && value !== "none");
  const normalized = normalizedPhrase(condition);
  if (exactValues.some((exactValue) => normalized.includes(exactValue))) return true;
  const conditionTokens = meaningfulTokens(condition);
  const overlap = new Set(conditionTokens.filter((token) => contractTokens.has(token)));
  const operationTokens = new Set(meaningfulTokens(contract.operation));
  return overlap.size >= 2 && conditionTokens.some((token) => operationTokens.has(token));
}

function meaningfulTokens(value: string): readonly string[] {
  return normalizedPhrase(value)
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 1 && !APPLICABILITY_STOP_WORDS.has(token));
}

function normalizedPhrase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function parseObservableContracts(
  value: unknown,
  field: string,
): Result<readonly ObservableContract[], EvolutionError> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > MAX_OBSERVABLE_CONTRACTS) {
    return validation("Observable contracts must be a bounded array.", field);
  }
  const contracts: ObservableContract[] = [];
  for (const [index, candidate] of value.entries()) {
    const contractField = `${field}.${index}`;
    if (!isRecord(candidate) || typeof candidate["operation"] !== "string") {
      return validation("Observable contract requires an operation.", contractField);
    }
    const operation = candidate["operation"].trim();
    if (operation.length === 0 || operation.length > MAX_OPERATION_CHARS) {
      return validation("Observable contract operation is empty or over limit.", `${contractField}.operation`);
    }
    const inputs = requiredStringList(candidate["inputs"], `${contractField}.inputs`);
    if (!inputs.ok) return inputs;
    const outputs = requiredStringList(candidate["outputs"], `${contractField}.outputs`);
    if (!outputs.ok) return outputs;
    const errors = requiredStringList(candidate["errors"], `${contractField}.errors`);
    if (!errors.ok) return errors;
    const sideEffects = requiredStringList(candidate["sideEffects"], `${contractField}.sideEffects`);
    if (!sideEffects.ok) return sideEffects;
    const exactValues = requiredStringList(candidate["exactValues"], `${contractField}.exactValues`);
    if (!exactValues.ok) return exactValues;
    contracts.push({
      operation,
      inputs: inputs.value,
      outputs: outputs.value,
      errors: errors.value,
      sideEffects: sideEffects.value,
      exactValues: exactValues.value,
    });
  }
  return { ok: true, value: contracts };
}

function requiredStringList(value: unknown, field: string): Result<readonly string[], EvolutionError> {
  const parsed = stringList(typeof value === "string" ? [value] : value, field);
  if (!parsed.ok) return parsed;
  return parsed.value.length === 0
    ? validation("Observable contract fields must be explicit; use the literal 'none' when absent.", field)
    : parsed;
}

function stringList(value: unknown, field: string): Result<readonly string[], EvolutionError> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > MAX_SCOPE_ITEMS || value.some((item) => typeof item !== "string")) {
    return validation("Reflection lesson scope metadata must be a bounded string array.", field);
  }
  const normalized = [...new Set((value as string[]).map((item) => item.trim()))];
  if (normalized.some((item) => item.length === 0 || item.length > MAX_SCOPE_ITEM_CHARS)) {
    return validation("Reflection lesson scope metadata contains an empty or over-limit item.", field);
  }
  return { ok: true, value: normalized };
}

function isRelativePath(path: string): boolean {
  return path === "." || (!path.startsWith("/") && !path.includes("\\")
    && path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."));
}

function jsonObjects(source: string): readonly string[] {
  const objects: string[] = [];
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") quoted = false;
        continue;
      }
      if (character === "\"") quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          objects.push(source.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return objects;
}

function validation(message: string, field: string): Result<never, EvolutionError> {
  return { ok: false, error: { kind: "validation", message, field, recoverable: true, callerAction: "fix-request" } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
