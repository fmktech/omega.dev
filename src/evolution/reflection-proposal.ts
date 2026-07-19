import type { EvolutionError, Result } from "../contracts/index.js";
import type { CrystallizedLesson, LearningTarget } from "./learning-types.js";

export type ReflectionProposal = {
  readonly reflection: string;
  readonly decision: "evolve" | "no-change";
  readonly lessons: readonly CrystallizedLesson[];
};

const TARGETS: ReadonlySet<string> = new Set(["knowledge", "skill", "runner", "tool", "policy"]);
const MAX_LESSONS = 4;
const MAX_GUIDANCE_CHARS = 1_600;
const MAX_SCOPE_ITEMS = 24;
const MAX_SCOPE_ITEM_CHARS = 240;

export function parseReflectionProposal(text: string, allowedSourceIds: readonly string[]): Result<ReflectionProposal, EvolutionError> {
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
    const sourceIds = value["sourceIds"];
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
    lessons.push({
      sourceIds: [...new Set(sourceIds as string[])].sort(),
      target: value["target"] as LearningTarget,
      title,
      guidance,
      relevantPaths: relevantPaths.value,
      appliesWhen: appliesWhen.value,
      doesNotApplyWhen: doesNotApplyWhen.value,
    });
  }
  return { ok: true, value: { reflection, decision: parsed["decision"], lessons } };
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
