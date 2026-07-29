import { createHash } from "node:crypto";

import type {
  ArtifactId,
  BenchmarkBudget,
  BenchmarkManifest,
  BenchmarkTaskId,
  EvolutionError,
  JsonObject,
  JsonValue,
  ObjectHash,
  ObjectStore,
  ProjectId,
  Result,
  SessionId,
  SkillEvalPrivateTask,
  SkillEvalSuite,
  SkillEvalVariation,
  Timestamp,
} from "../contracts/index.js";

const VARIATIONS: readonly SkillEvalVariation[] = ["near-transfer", "generalization", "negative-control"];
const MAX_FILES = 32;
const MAX_CHECKS = 16;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_FIXTURE_BYTES = 256 * 1024;
const MAX_VERIFIER_FILES = 4;
const MAX_VERIFIER_BYTES = 64 * 1024;
const MAX_VERIFIER_ARGS = 32;

type Check = {
  readonly path: string;
  readonly equals?: string;
  readonly contains?: string;
  readonly notContains?: string;
  readonly absent?: boolean;
};

type ExecutableVerifier = {
  readonly files: Readonly<Record<string, string>>;
  readonly command: {
    readonly executable: string;
    readonly args: readonly string[];
  };
};

type Fixture = {
  readonly variation: SkillEvalVariation;
  readonly title: string;
  readonly objective: string;
  readonly files: Readonly<Record<string, string>>;
  readonly checks: readonly Check[];
  readonly verifier: ExecutableVerifier;
  readonly invariants: readonly Check[];
};

export async function compileSkillEvalSuite(
  text: string,
  input: {
    readonly projectId: ProjectId;
    readonly sourceSessionId: SessionId;
    readonly evidenceArtifactIds: readonly ArtifactId[];
    readonly proposalArtifactId: ArtifactId;
    readonly budget: BenchmarkBudget;
    readonly createdAt: Timestamp;
  },
  objects: ObjectStore,
): Promise<Result<SkillEvalSuite, EvolutionError>> {
  const parsed = parseProposal(text);
  if (!parsed.ok) return parsed;
  const byVariation = new Map(parsed.value.map((fixture) => [fixture.variation, fixture] as const));
  if (byVariation.size !== VARIATIONS.length || VARIATIONS.some((variation) => !byVariation.has(variation))) {
    return invalid("A skill evaluation suite requires exactly one near-transfer, generalization, and negative-control fixture.", "fixtures.variation");
  }

  const signature = hash(canonical({
    projectId: input.projectId,
    sourceSessionId: input.sourceSessionId,
    evidenceArtifactIds: [...new Set(input.evidenceArtifactIds)].sort(),
    proposalArtifactId: input.proposalArtifactId,
    fixtures: parsed.value as unknown as JsonValue,
  })).slice(0, 24);
  const privateTasks: SkillEvalPrivateTask[] = [];
  const tasks: BenchmarkManifest["tasks"][number][] = [];
  for (const variation of VARIATIONS) {
    const fixture = byVariation.get(variation)!;
    const fixtureHash = await putJson(objects, { files: fixture.files });
    if (!fixtureHash.ok) return fixtureHash;
    const environmentHash = await putJson(objects, { os: "linux", isolation: "oci", network: "none", variation });
    if (!environmentHash.ok) return environmentHash;
    const verifierHash = await putJson(objects, { checks: fixture.checks, executable: fixture.verifier });
    if (!verifierHash.ok) return verifierHash;
    const invariantHash = await putJson(objects, { checks: fixture.invariants });
    if (!invariantHash.ok) return invariantHash;
    const taskId = `skill-${variation}-${signature}@1` as BenchmarkTaskId;
    tasks.push({
      id: taskId,
      title: fixture.title,
      objective: fixture.objective,
      fixtureObjectHash: fixtureHash.value,
      environmentObjectHash: environmentHash.value,
      budget: input.budget,
    });
    privateTasks.push({
      taskId,
      verifierObjectHash: verifierHash.value,
      negativeInvariantObjectHash: invariantHash.value,
      diagnosticTags: ["skill-foundry", variation],
      variation,
      skillUseExpectation: variation === "negative-control" ? "forbidden" : "required",
    });
  }
  const privateIndex = await putJson(objects, {
    sourceSessionId: input.sourceSessionId,
    evidenceArtifactIds: [...new Set(input.evidenceArtifactIds)].sort(),
    proposalArtifactId: input.proposalArtifactId,
    tasks: privateTasks,
  });
  if (!privateIndex.ok) return privateIndex;
  const protectedTaskIds = tasks.map((task) => task.id);
  const manifest: BenchmarkManifest = {
    id: `skill-foundry-${signature}@1` as BenchmarkManifest["id"],
    name: `Skill Foundry ${signature}`,
    version: "1",
    tasks,
    privateTaskMetadataObjectHash: privateIndex.value,
    promotionPolicy: {
      id: `skill-foundry-policy-${signature}@1`,
      version: "1",
      replicatesPerHarness: 3,
      thresholds: {
        minimumComparablePairs: 9,
        minimumSuccessRateDelta: 0,
        maximumProtectedRegressions: 0,
        confidenceLevel: 0.8,
      },
      protectedTaskIds,
      workspaceBaseline: "fixture-object-hash",
      comparisonOrder: ["invariants", "capability", "cost", "latency"],
    },
    createdAt: input.createdAt,
  };
  return {
    ok: true,
    value: {
      manifest,
      privateTasks,
      sourceSessionId: input.sourceSessionId,
      evidenceArtifactIds: [...new Set(input.evidenceArtifactIds)].sort() as readonly ArtifactId[],
      proposalArtifactId: input.proposalArtifactId,
    },
  };
}

function parseProposal(text: string): Result<readonly Fixture[], EvolutionError> {
  let value: unknown;
  for (const source of [text.trim(), ...embeddedJsonObjects(text)]) {
    try {
      value = JSON.parse(source);
      break;
    } catch {
      // Providers occasionally prefix the requested JSON object.
    }
  }
  if (!isRecord(value) || !Array.isArray(value["fixtures"]) || value["fixtures"].length !== 3) {
    return invalid("A skill evaluation proposal must contain exactly three fixtures.", "fixtures");
  }
  const fixtures: Fixture[] = [];
  for (const [index, raw] of value["fixtures"].entries()) {
    const field = `fixtures.${index}`;
    if (!isRecord(raw) || !VARIATIONS.includes(raw["variation"] as SkillEvalVariation)
      || typeof raw["title"] !== "string" || typeof raw["objective"] !== "string"
      || !isRecord(raw["files"]) || !Array.isArray(raw["checks"]) || !Array.isArray(raw["invariants"])) {
      return invalid("A skill evaluation fixture has an invalid shape.", field);
    }
    if (!isRecord(raw["verifier"])) {
      return invalid("A skill evaluation fixture requires an executable behavioral verifier.", `${field}.verifier`);
    }
    const title = raw["title"].trim();
    const objective = raw["objective"].trim();
    if (title.length === 0 || title.length > 160 || objective.length === 0 || objective.length > 2_000) {
      return invalid("A skill evaluation title or objective is empty or over its limit.", field);
    }
    const fileEntries = Object.entries(raw["files"]);
    if (fileEntries.length === 0 || fileEntries.length > MAX_FILES) return invalid("Fixture file count is outside its bound.", `${field}.files`);
    let fixtureBytes = 0;
    const files: Record<string, string> = {};
    for (const [path, content] of fileEntries) {
      if (!safePath(path) || typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE_BYTES) {
        return invalid("Fixture files require safe relative paths and bounded string contents.", `${field}.files`);
      }
      fixtureBytes += Buffer.byteLength(content);
      files[path] = content;
    }
    if (fixtureBytes > MAX_FIXTURE_BYTES) return invalid("Fixture contents exceed their total byte budget.", `${field}.files`);
    const checks = parseChecks(raw["checks"], `${field}.checks`);
    if (!checks.ok) return checks;
    const verifier = parseExecutableVerifier(raw["verifier"], `${field}.verifier`);
    if (!verifier.ok) return verifier;
    const invariants = parseChecks(raw["invariants"], `${field}.invariants`);
    if (!invariants.ok) return invariants;
    if (!checksPass(files, invariants.value)) {
      return invalid("Untouched fixture files must satisfy every negative invariant.", `${field}.invariants`);
    }
    fixtures.push({
      variation: raw["variation"] as SkillEvalVariation,
      title,
      objective,
      files,
      checks: checks.value,
      verifier: verifier.value,
      invariants: invariants.value,
    });
  }
  return { ok: true, value: fixtures };
}

function parseExecutableVerifier(value: Readonly<Record<string, unknown>>, field: string): Result<ExecutableVerifier, EvolutionError> {
  const rawFiles = value["files"];
  const rawCommand = value["command"];
  if (!isRecord(rawFiles) || !isRecord(rawCommand)) {
    return invalid("Executable verifier requires private files and a command.", field);
  }
  const entries = Object.entries(rawFiles);
  if (entries.length === 0 || entries.length > MAX_VERIFIER_FILES) {
    return invalid("Executable verifier file count is outside its bound.", `${field}.files`);
  }
  const files: Record<string, string> = {};
  let totalBytes = 0;
  for (const [path, content] of entries) {
    if (!safePath(path) || typeof content !== "string") {
      return invalid("Executable verifier files require safe relative paths and string contents.", `${field}.files`);
    }
    totalBytes += Buffer.byteLength(content);
    if (Buffer.byteLength(content) > MAX_FILE_BYTES || totalBytes > MAX_VERIFIER_BYTES) {
      return invalid("Executable verifier contents exceed their byte budget.", `${field}.files`);
    }
    if (hasHardcodedStatePreservationLength(content)) {
      return invalid(
        "A state-preservation assertion must compare the after-state with a snapshot captured immediately before the operation; it cannot assert a hardcoded collection length.",
        `${field}.files.${path}`,
      );
    }
    files[path] = content;
  }
  const executable = rawCommand["executable"];
  const args = rawCommand["args"];
  if (typeof executable !== "string" || executable.length === 0 || executable.length > 128
    || executable.includes("\0") || executable.includes("/") || !Array.isArray(args)
    || args.length > MAX_VERIFIER_ARGS || args.some((arg) => typeof arg !== "string" || arg.length > 1_024 || arg.includes("\0"))) {
    return invalid("Executable verifier command is invalid or outside its bound.", `${field}.command`);
  }
  return {
    ok: true,
    value: {
      files,
      command: { executable, args: args as readonly string[] },
    },
  };
}

function hasHardcodedStatePreservationLength(source: string): boolean {
  const assertionCalls = source.matchAll(/\bassert(?:\.[A-Za-z][A-Za-z0-9_]*)?\s*\(([\s\S]*?)\)\s*;?/gu);
  for (const match of assertionCalls) {
    const assertion = match[1] ?? "";
    if (/\.length\s*,\s*\d+\b/u.test(assertion)
      && /(?:\bunchang|\bpreserv|\bremain|\bnot\s+(?:have\s+)?(?:delet|remov|mutat))/iu.test(assertion)) {
      return true;
    }
  }
  return false;
}

function parseChecks(value: readonly unknown[], field: string): Result<readonly Check[], EvolutionError> {
  if (value.length === 0 || value.length > MAX_CHECKS) return invalid("Fixture checks are outside their count bound.", field);
  const checks: Check[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw["path"] !== "string" || !safePath(raw["path"])) {
      return invalid("Fixture check has an invalid path.", field);
    }
    const equals = typeof raw["equals"] === "string" ? raw["equals"] : undefined;
    const contains = typeof raw["contains"] === "string" ? raw["contains"] : undefined;
    const notContains = typeof raw["notContains"] === "string"
      ? raw["notContains"]
      : typeof raw["absent"] === "string" ? raw["absent"] : undefined;
    const absent = typeof raw["absent"] === "boolean" ? raw["absent"] : undefined;
    if (equals === undefined && contains === undefined && notContains === undefined && absent === undefined) {
      return invalid("Fixture check must define equals, contains, notContains, or absent.", field);
    }
    checks.push({
      path: raw["path"],
      ...(equals === undefined ? {} : { equals }),
      ...(contains === undefined ? {} : { contains }),
      ...(notContains === undefined ? {} : { notContains }),
      ...(absent === undefined ? {} : { absent }),
    });
  }
  return { ok: true, value: checks };
}

function checksPass(files: Readonly<Record<string, string>>, checks: readonly Check[]): boolean {
  for (const check of checks) {
    const content = files[check.path];
    if (check.absent === true) {
      if (content !== undefined) return false;
      continue;
    }
    if (content === undefined
      || (check.equals !== undefined && content !== check.equals)
      || (check.contains !== undefined && !content.includes(check.contains))
      || (check.notContains !== undefined && content.includes(check.notContains))) {
      return false;
    }
  }
  return true;
}

async function putJson(objects: ObjectStore, value: JsonValue): Promise<Result<ObjectHash, EvolutionError>> {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  const stored = await objects.put("application/json", (async function* (): AsyncIterable<Uint8Array> { yield bytes; })());
  return stored.ok ? { ok: true, value: stored.value.hash } : stored;
}

function safePath(path: string): boolean {
  return path.length > 0 && path.length <= 240 && !path.startsWith("/") && !path.includes("\\")
    && path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && part !== ".git");
}

function embeddedJsonObjects(source: string): readonly string[] {
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
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) { objects.push(source.slice(start, index + 1)); break; }
    }
  }
  return objects;
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as JsonObject;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key] ?? null)}`).join(",")}}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalid(message: string, field: string): Result<never, EvolutionError> {
  return { ok: false, error: { kind: "validation", message, field, recoverable: true, callerAction: "fix-request" } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
