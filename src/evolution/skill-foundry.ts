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

type Check = {
  readonly path: string;
  readonly equals?: string;
  readonly contains?: string;
  readonly absent?: boolean;
};

type Fixture = {
  readonly variation: SkillEvalVariation;
  readonly title: string;
  readonly objective: string;
  readonly files: Readonly<Record<string, string>>;
  readonly checks: readonly Check[];
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
    const verifierHash = await putJson(objects, { checks: fixture.checks });
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
      replicatesPerHarness: 1,
      thresholds: {
        minimumComparablePairs: 3,
        minimumSuccessRateDelta: 1 / 3,
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
    const invariants = parseChecks(raw["invariants"], `${field}.invariants`);
    if (!invariants.ok) return invariants;
    fixtures.push({
      variation: raw["variation"] as SkillEvalVariation,
      title,
      objective,
      files,
      checks: checks.value,
      invariants: invariants.value,
    });
  }
  return { ok: true, value: fixtures };
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
    const absent = typeof raw["absent"] === "boolean" ? raw["absent"] : undefined;
    if (equals === undefined && contains === undefined && absent === undefined) {
      return invalid("Fixture check must define equals, contains, or absent.", field);
    }
    checks.push({ path: raw["path"], ...(equals === undefined ? {} : { equals }), ...(contains === undefined ? {} : { contains }), ...(absent === undefined ? {} : { absent }) });
  }
  return { ok: true, value: checks };
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
