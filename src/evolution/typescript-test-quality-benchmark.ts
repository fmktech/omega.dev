import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import type {
  CapabilityEnvelope,
  ComponentId,
  DurationMs,
  EvolutionError,
  HarnessId,
  JsonValue,
  ModelCompletion,
  ModelMessage,
  ModelRouteSignature,
  ModelRouter,
  ModelStreamEvent,
  ModelUsage,
  Result,
  SessionId,
  Sha256,
  SkillCatalogEntry,
  Timestamp,
  TokenCount,
  UsdMicros,
} from "../contracts/index.js";
import type { InstalledTransferSkill } from "./reflection-skill-transfer-benchmark.js";

export type TypeScriptTestJudgeDimension = {
  readonly id: "D1" | "D2" | "D3" | "D4" | "D5" | "D6";
  readonly max: number;
  readonly earned: number;
  readonly findingIds: readonly string[];
};

export type TypeScriptTestJudgeReport = {
  readonly total: number;
  readonly verdict: "Exemplary" | "Compliant" | "Needs work" | "Non-compliant";
  readonly dimensions: readonly TypeScriptTestJudgeDimension[];
  readonly tests: readonly { readonly id: string; readonly assessment: string }[];
  readonly behaviors: readonly { readonly behavior: string; readonly coverage: string; readonly mutation: string }[];
  readonly findings: readonly {
    readonly id: string;
    readonly classification: "VIOLATION" | "GAP";
    readonly rubricId: string;
    readonly deduction: number;
    readonly location: string;
    readonly evidence: string;
    readonly fix: string;
  }[];
  readonly nits: readonly string[];
  readonly caveats: readonly string[];
};

export type TypeScriptTestVerification = {
  readonly sourcePreserved: boolean;
  readonly nativePass: boolean;
  readonly repeatedPass: boolean;
  readonly typecheckPass: boolean;
  readonly killedMutationIds: readonly string[];
  readonly survivingMutationIds: readonly string[];
  readonly inconclusiveMutationIds: readonly string[];
  readonly runs: readonly { readonly label: string; readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }[];
};

export type TypeScriptTestArtifactScore = {
  readonly executablePassed: boolean;
  readonly mutationScore: number;
  readonly killedMutations: number;
  readonly totalMutations: number;
  readonly mutationInfrastructurePassed: boolean;
  readonly qualityPassed: boolean;
};

export type TypeScriptTestJudgeEvidence = {
  readonly report: TypeScriptTestJudgeReport;
  readonly route: ModelRouteSignature;
  readonly providerGenerationId: string | null;
  readonly usage: ModelUsage;
  readonly rawResponse: string;
};

export type TypeScriptTestQualityRun = {
  readonly condition: "incumbent" | "candidate";
  readonly replicate: number;
  readonly harnessId: HarnessId;
  readonly sessionId: SessionId;
  readonly route: ModelRouteSignature;
  readonly providerGenerationIds: readonly (string | null)[];
  readonly usage: ModelUsage;
  readonly modelTurns: number;
  readonly providerRetries: number;
  readonly toolCalls: number;
  readonly skillReadComponentIds: readonly ComponentId[];
  readonly retrievalCorrect: boolean;
  readonly fileReads: readonly string[];
  readonly fileWrites: readonly string[];
  readonly processCalls: readonly string[];
  readonly toolErrors: readonly string[];
  readonly response: string;
  readonly finalFiles: Readonly<Record<string, string>>;
  readonly verification: TypeScriptTestVerification;
  readonly score: TypeScriptTestArtifactScore;
  readonly judge: TypeScriptTestJudgeEvidence | null;
};

export type TypeScriptTestQualityComparison = {
  readonly incumbent: TypeScriptTestQualityRun;
  readonly candidate: TypeScriptTestQualityRun;
  readonly comparable: boolean;
  readonly invalidReason: string | null;
  readonly mutationKillDelta: number;
  readonly judgeScoreDelta: number | null;
  readonly capabilityImproved: boolean;
};

export type TypeScriptTestMutation = {
  readonly id: string;
  readonly description: string;
  readonly apply: (source: string) => string;
};

export type TypeScriptTestFixture = {
  readonly id: string;
  readonly files: Readonly<Record<string, string>>;
  readonly sourcePath: string;
  readonly mutations: readonly TypeScriptTestMutation[];
};

const SOURCE = `export type Shipment = Readonly<{ route: string; units: number }>;
export type DispatchRequest = Readonly<{ shipments: readonly Shipment[]; rush: boolean }>;
export type DispatchPlan = Readonly<{ routes: readonly Readonly<{ route: string; units: number }>[]; totalUnits: number; surchargeCents: number; plannedAt: string }>;

export interface CapacityGateway {
  remaining(route: string): Promise<number>;
  reserve(route: string, units: number): Promise<void>;
}

export interface Clock { now(): Date }

export class DispatchError extends Error {
  readonly code: "EMPTY" | "INVALID_UNITS" | "RUSH_CLOSED" | "INSUFFICIENT_CAPACITY";
  constructor(code: "EMPTY" | "INVALID_UNITS" | "RUSH_CLOSED" | "INSUFFICIENT_CAPACITY", message: string) {
    super(message);
    this.code = code;
  }
}

export async function planDispatch(request: DispatchRequest, capacity: CapacityGateway, clock: Clock): Promise<DispatchPlan> {
  if (request.shipments.length === 0) throw new DispatchError("EMPTY", "At least one shipment is required.");

  const totals = new Map<string, number>();
  for (const shipment of request.shipments) {
    if (!Number.isInteger(shipment.units) || shipment.units <= 0) {
      throw new DispatchError("INVALID_UNITS", "Units must be a positive integer.");
    }
    if (shipment.units > 50) throw new DispatchError("INVALID_UNITS", "One line cannot exceed 50 units.");
    totals.set(shipment.route, (totals.get(shipment.route) ?? 0) + shipment.units);
  }

  const now = clock.now();
  const hour = now.getUTCHours();
  if (request.rush && (hour < 6 || hour >= 22)) {
    throw new DispatchError("RUSH_CLOSED", "Rush dispatch is available from 06:00 through 21:59 UTC.");
  }

  const routes = [...totals.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [route, units] of routes) {
    const remaining = await capacity.remaining(route);
    if (remaining < units) throw new DispatchError("INSUFFICIENT_CAPACITY", \`Route \${route} lacks capacity.\`);
  }
  for (const [route, units] of routes) await capacity.reserve(route, units);

  const totalUnits = routes.reduce((sum, [, units]) => sum + units, 0);
  return {
    routes: routes.map(([route, units]) => ({ route, units })),
    totalUnits,
    surchargeCents: request.rush ? totalUnits * 25 : 0,
    plannedAt: now.toISOString(),
  };
}
`;

const SEED_TEST = `import assert from "node:assert/strict";
import test from "node:test";

import { planDispatch, type CapacityGateway } from "../src/plan-dispatch.ts";

test("planDispatch returns the total units", async () => {
  const capacity: CapacityGateway = {
    async remaining() { return 100; },
    async reserve() {},
  };
  const plan = await planDispatch(
    { shipments: [{ route: "south", units: 2 }], rush: false },
    capacity,
    { now: () => new Date("2026-07-20T12:00:00.000Z") },
  );
  assert.equal(plan.totalUnits, 2);
});
`;

const REFERENCE_TEST = `import assert from "node:assert/strict";
import test from "node:test";

import { DispatchError, planDispatch, type CapacityGateway } from "../src/plan-dispatch.ts";

class FakeCapacity implements CapacityGateway {
  readonly reservations: { route: string; units: number }[] = [];
  private readonly capacities: Readonly<Record<string, number>>;
  constructor(capacities: Readonly<Record<string, number>>) { this.capacities = capacities; }
  async remaining(route: string): Promise<number> { return this.capacities[route] ?? 0; }
  async reserve(route: string, units: number): Promise<void> { this.reservations.push({ route, units }); }
}

const clock = (iso: string) => ({ now: () => new Date(iso) });

test("rejects an empty shipment list", async () => {
  await assert.rejects(
    () => planDispatch({ shipments: [], rush: false }, new FakeCapacity({}), clock("2026-07-20T12:00:00.000Z")),
    (error: unknown) => error instanceof DispatchError && error.code === "EMPTY",
  );
});

for (const units of [0, -1, 1.5, 51]) {
  test(\`rejects invalid line quantity \${units}\`, async () => {
    await assert.rejects(
      () => planDispatch({ shipments: [{ route: "a", units }], rush: false }, new FakeCapacity({ a: 100 }), clock("2026-07-20T12:00:00.000Z")),
      (error: unknown) => error instanceof DispatchError && error.code === "INVALID_UNITS",
    );
  });
}

test("accepts the 50-unit line and exact remaining capacity", async () => {
  const capacity = new FakeCapacity({ a: 50 });
  const plan = await planDispatch({ shipments: [{ route: "a", units: 50 }], rush: false }, capacity, clock("2026-07-20T12:00:00.000Z"));
  assert.equal(plan.totalUnits, 50);
  assert.deepEqual(capacity.reservations, [{ route: "a", units: 50 }]);
});

test("rejects rush dispatch before the UTC opening boundary", async () => {
  await assert.rejects(
    () => planDispatch({ shipments: [{ route: "a", units: 1 }], rush: true }, new FakeCapacity({ a: 1 }), clock("2026-07-20T05:00:00.000Z")),
    (error: unknown) => error instanceof DispatchError && error.code === "RUSH_CLOSED",
  );
});

test("aggregates routes and returns surcharge, ordering, state, and injected time", async () => {
  const capacity = new FakeCapacity({ north: 3, south: 3 });
  const plan = await planDispatch({ shipments: [
    { route: "south", units: 1 }, { route: "north", units: 3 }, { route: "south", units: 2 },
  ], rush: true }, capacity, clock("2026-07-20T06:00:00.000Z"));
  assert.deepEqual(plan, {
    routes: [{ route: "north", units: 3 }, { route: "south", units: 3 }],
    totalUnits: 6,
    surchargeCents: 150,
    plannedAt: "2026-07-20T06:00:00.000Z",
  });
  assert.deepEqual(capacity.reservations, [{ route: "north", units: 3 }, { route: "south", units: 3 }]);
});

test("does not reserve any route when later capacity preflight fails", async () => {
  const capacity = new FakeCapacity({ a: 1, b: 0 });
  await assert.rejects(
    () => planDispatch({ shipments: [{ route: "a", units: 1 }, { route: "b", units: 1 }], rush: false }, capacity, clock("2026-07-20T12:00:00.000Z")),
    (error: unknown) => error instanceof DispatchError && error.code === "INSUFFICIENT_CAPACITY",
  );
  assert.deepEqual(capacity.reservations, []);
});
`;

const README = `# Dispatch planner

Improve the tests for \`src/plan-dispatch.ts\`. Do not modify production source.

## Public contract

- At least one shipment is required.
- Units are positive integers; each input line permits at most 50 units.
- Lines sharing a route are aggregated before checking and reserving capacity.
- Rush dispatch is available from 06:00 through 21:59 UTC, using the injected clock.
- Every route must pass capacity preflight before any route is reserved. Exact capacity is valid.
- Successful reservations are performed once per aggregated route.
- Rush surcharge is 25 cents per unit; ordinary dispatch has no surcharge.
- The plan contains sorted aggregated routes, total units, and the injected timestamp in ISO format.

Use the existing Node test runner. Run \`npm test\`. Keep tests deterministic and offline.
`;

export function typescriptTestFixtureFiles(): Readonly<Record<string, string>> {
  return {
    "package.json": `${JSON.stringify({ name: "dispatch-planner-fixture", private: true, type: "module", scripts: { test: "node --test tests/*.test.ts" } }, null, 2)}\n`,
    "tsconfig.json": `${JSON.stringify({ compilerOptions: { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true, types: ["node"] }, include: ["src/**/*.ts", "tests/**/*.ts"] }, null, 2)}\n`,
    "README.md": README,
    "src/plan-dispatch.ts": SOURCE,
    "tests/plan-dispatch.test.ts": SEED_TEST,
  };
}

export function typescriptTestReferenceFiles(): Readonly<Record<string, string>> {
  return { ...typescriptTestFixtureFiles(), "tests/plan-dispatch.test.ts": REFERENCE_TEST };
}

function replaceOnce(source: string, before: string, after: string): string {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0) return source;
  return `${source.slice(0, at)}${after}${source.slice(at + before.length)}`;
}

export const TEST_QUALITY_MUTATIONS: readonly TypeScriptTestMutation[] = [
  { id: "empty-list", description: "accept empty input", apply: (source) => replaceOnce(source, "if (request.shipments.length === 0)", "if (request.shipments.length < 0)") },
  { id: "zero-units", description: "accept zero units", apply: (source) => replaceOnce(source, "shipment.units <= 0", "shipment.units < 0") },
  { id: "maximum-units", description: "reject the valid maximum", apply: (source) => replaceOnce(source, "shipment.units > 50", "shipment.units >= 50") },
  { id: "rush-window", description: "open rush one hour early", apply: (source) => replaceOnce(source, "hour < 6 || hour >= 22", "hour < 5 || hour >= 22") },
  { id: "exact-capacity", description: "reject exact capacity", apply: (source) => replaceOnce(source, "remaining < units", "remaining <= units") },
  { id: "duplicate-routes", description: "stop aggregating duplicate routes", apply: (source) => replaceOnce(source, "totals.set(shipment.route, (totals.get(shipment.route) ?? 0) + shipment.units);", "totals.set(shipment.route, shipment.units);") },
  { id: "rush-surcharge", description: "use the wrong rush surcharge", apply: (source) => replaceOnce(source, "totalUnits * 25", "totalUnits * 20") },
  {
    id: "capacity-atomicity",
    description: "reserve before all capacity checks pass",
    apply: (source) => replaceOnce(source,
      `  for (const [route, units] of routes) {
    const remaining = await capacity.remaining(route);
    if (remaining < units) throw new DispatchError("INSUFFICIENT_CAPACITY", \`Route \${route} lacks capacity.\`);
  }
  for (const [route, units] of routes) await capacity.reserve(route, units);`,
      `  for (const [route, units] of routes) {
    const remaining = await capacity.remaining(route);
    if (remaining < units) throw new DispatchError("INSUFFICIENT_CAPACITY", \`Route \${route} lacks capacity.\`);
    await capacity.reserve(route, units);
  }`),
  },
  { id: "injected-clock", description: "return ambient time", apply: (source) => replaceOnce(source, "plannedAt: now.toISOString()", "plannedAt: new Date().toISOString()") },
] as const;

export function defaultTypeScriptTestFixture(): TypeScriptTestFixture {
  return { id: "dispatch-planner", files: typescriptTestFixtureFiles(), sourcePath: "src/plan-dispatch.ts", mutations: TEST_QUALITY_MUTATIONS };
}

const TOOLS = [
  { name: "skill.read", description: "Read one installed skill by component ID. Read an immutable skill at most once.", inputSchema: { type: "object", properties: { componentId: { type: "string" } }, required: ["componentId"], additionalProperties: false } },
  { name: "file.read", description: "Read one UTF-8 repository file and receive its SHA-256 write interlock.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
  { name: "file.write", description: "Write one UTF-8 repository file. Existing files require the SHA from file.read; new files require null.", inputSchema: { type: "object", properties: { path: { type: "string" }, expectedSha: { type: ["string", "null"] }, content: { type: "string" } }, required: ["path", "expectedSha", "content"], additionalProperties: false } },
  { name: "process.start", description: "Run a network-disabled command in a fresh container at repository root. For shell syntax use sh -c.", inputSchema: { type: "object", properties: { executable: { type: "string" }, args: { type: "array", items: { type: "string" } } }, required: ["executable", "args"], additionalProperties: false } },
] as const;

export function renderTypeScriptTestAuthorPrompt(
  catalog: readonly SkillCatalogEntry[],
  objective = "Improve the tests for src/plan-dispatch.ts so they provide strong confidence in the documented behavior. Do not change production source.",
  inventory: readonly string[] = ["README.md", "package.json", "tsconfig.json", "src/plan-dispatch.ts", "tests/plan-dispatch.test.ts"],
): readonly ModelMessage[] {
  return [
    {
      role: "system",
      content: [{ kind: "text", text: [
        "You are completing a real software task in an isolated TypeScript repository. Act with tools and finish the implementation; do not merely return a plan.",
        "Read files before replacing them and pass the exact SHA to file.write. Production files are read-only by task contract; change tests and test-local helpers only.",
        "Inspect the compact installed-skill catalog. If a skill applies, call skill.read exactly once before using it. If none applies, do not read one.",
        "Run the repository's documented verification before finishing.",
        "Installed skill catalog:",
        JSON.stringify(catalog),
      ].join("\n\n") }],
    },
    { role: "user", content: [{ kind: "text", text: `${objective} Repository inventory: ${inventory.join(", ")}.` }] },
  ];
}

export function scoreTypeScriptTestArtifact(input: {
  readonly sourcePreserved: boolean;
  readonly nativePass: boolean;
  readonly repeatedPass: boolean;
  readonly typecheckPass: boolean;
  readonly killedMutationIds: readonly string[];
  readonly totalMutations: number;
  readonly inconclusiveMutationIds?: readonly string[];
}): TypeScriptTestArtifactScore {
  const mutationInfrastructurePassed = (input.inconclusiveMutationIds?.length ?? 0) === 0;
  const executablePassed = input.sourcePreserved && input.nativePass && input.repeatedPass && input.typecheckPass && mutationInfrastructurePassed;
  const killedMutations = new Set(input.killedMutationIds).size;
  const mutationScore = input.totalMutations === 0 ? 0 : killedMutations / input.totalMutations;
  return { executablePassed, mutationScore, killedMutations, totalMutations: input.totalMutations, mutationInfrastructurePassed, qualityPassed: executablePassed && mutationScore >= 0.75 };
}

export function compareTypeScriptTestQualityRuns(
  incumbent: TypeScriptTestQualityRun,
  candidate: TypeScriptTestQualityRun,
): TypeScriptTestQualityComparison {
  const mismatch = incumbent.replicate !== candidate.replicate ? "different-replicate" : routeMismatch(incumbent.route, candidate.route);
  const mutationKillDelta = candidate.score.killedMutations - incumbent.score.killedMutations;
  const judgeScoreDelta = incumbent.judge === null || candidate.judge === null ? null : candidate.judge.report.total - incumbent.judge.report.total;
  const comparable = mismatch === null;
  return {
    incumbent,
    candidate,
    comparable,
    invalidReason: mismatch,
    mutationKillDelta,
    judgeScoreDelta,
    capabilityImproved: comparable && incumbent.retrievalCorrect && candidate.retrievalCorrect
      && incumbent.score.executablePassed && candidate.score.executablePassed && mutationKillDelta >= 2,
  };
}

export async function calibrateTypeScriptTestQualityFixture(
  image = "omega-runner:local",
  typeScriptBin?: string,
  nodeTypeRoots?: string,
): Promise<{
  readonly seed: TypeScriptTestVerification;
  readonly reference: TypeScriptTestVerification;
}> {
  const seedRoot = await mkdtemp(join(tmpdir(), "omega-ts-seed-"));
  const referenceRoot = await mkdtemp(join(tmpdir(), "omega-ts-reference-"));
  try {
    await materialize(seedRoot, typescriptTestFixtureFiles());
    await materialize(referenceRoot, typescriptTestReferenceFiles());
    const fixture = defaultTypeScriptTestFixture();
    const seed = await verifyTestArtifact(seedRoot, image, typeScriptBin, nodeTypeRoots, fixture);
    const reference = await verifyTestArtifact(referenceRoot, image, typeScriptBin, nodeTypeRoots, { ...fixture, files: typescriptTestReferenceFiles() });
    return { seed, reference };
  } finally {
    await Promise.all([rm(seedRoot, { recursive: true, force: true }), rm(referenceRoot, { recursive: true, force: true })]);
  }
}

export async function calibrateCustomTypeScriptTestFixture(
  fixture: TypeScriptTestFixture,
  referenceFiles: Readonly<Record<string, string>>,
  image = "omega-runner:local",
  typeScriptBin?: string,
  nodeTypeRoots?: string,
): Promise<{ readonly seed: TypeScriptTestVerification; readonly reference: TypeScriptTestVerification }> {
  const seedRoot = await mkdtemp(join(tmpdir(), "omega-ts-custom-seed-"));
  const referenceRoot = await mkdtemp(join(tmpdir(), "omega-ts-custom-reference-"));
  try {
    await materialize(seedRoot, fixture.files);
    await materialize(referenceRoot, referenceFiles);
    const seed = await verifyTestArtifact(seedRoot, image, typeScriptBin, nodeTypeRoots, fixture);
    const reference = await verifyTestArtifact(referenceRoot, image, typeScriptBin, nodeTypeRoots, { ...fixture, files: referenceFiles });
    return { seed, reference };
  } finally {
    await Promise.all([rm(seedRoot, { recursive: true, force: true }), rm(referenceRoot, { recursive: true, force: true })]);
  }
}

const DIMENSION_MAXIMA = new Map<string, number>([["D1", 10], ["D2", 20], ["D3", 20], ["D4", 30], ["D5", 10], ["D6", 10]]);
const RUBRIC_COSTS = new Map<string, number>([
  ["1.1", 4], ["1.2", 2], ["1.3", 6], ["1.4", 3],
  ["2.1", 4], ["2.2", 3], ["2.3", 3], ["2.4", 2], ["2.5", 3], ["2.6", 3], ["2.7", 4], ["2.8", 2],
  ["3.1", 4], ["3.2", 3], ["3.3", 4], ["3.4", 3], ["3.5", 3], ["3.6", 2],
  ["4.1", 4], ["4.2", 4], ["4.3", 3], ["4.4", 3], ["4.5", 3], ["4.6", 3],
  ["5.1", 2], ["5.2", 1], ["5.3", 1], ["5.4", 2], ["5.5", 1], ["5.6", 1],
  ["6.1", 3], ["6.2", 2], ["6.3", 3], ["6.4", 2], ["6.5", 2], ["6.6", 4], ["6.7", 2],
]);
const RUBRIC_RULE_CAPS = new Map<string, number>([["5.2", 4], ["5.3", 2], ["5.6", 3]]);

export function parseTypeScriptTestJudgeReport(text: string): Result<TypeScriptTestJudgeReport, EvolutionError> {
  let parsed: unknown;
  for (const candidate of [text.trim(), ...embeddedJsonObjects(text)]) {
    try { parsed = JSON.parse(candidate); break; } catch { /* Continue to embedded objects. */ }
  }
  if (!isRecord(parsed)) return invalid("Judge output does not contain one complete JSON object.", "judgeOutput");
  if (!Number.isInteger(parsed["total"]) || typeof parsed["verdict"] !== "string") return invalid("Judge total or verdict is invalid.", "judgeOutput.total");
  if (!Array.isArray(parsed["dimensions"]) || !Array.isArray(parsed["tests"]) || !Array.isArray(parsed["behaviors"])
    || !Array.isArray(parsed["findings"])) return invalid("Judge dimensions or inventory is not an array.", "judgeOutput.inventory");
  if (!stringArray(parsed["nits"]) || !stringArray(parsed["caveats"])) return invalid("Judge nits and caveats must be arrays of strings.", "judgeOutput.caveats");
  const dimensions: TypeScriptTestJudgeDimension[] = [];
  for (const raw of parsed["dimensions"]) {
    if (!isRecord(raw) || typeof raw["id"] !== "string" || !DIMENSION_MAXIMA.has(raw["id"])) {
      return invalid("Judge dimension is invalid.", "judgeOutput.dimensions");
    }
    const maximum = DIMENSION_MAXIMA.get(raw["id"]);
    if (maximum === undefined || raw["max"] !== maximum || typeof raw["earned"] !== "number"
      || raw["earned"] < 0 || raw["earned"] > maximum || !stringArray(raw["findingIds"])) {
      return invalid("Judge dimension is invalid.", "judgeOutput.dimensions");
    }
    dimensions.push({ id: raw["id"] as TypeScriptTestJudgeDimension["id"], max: maximum, earned: raw["earned"], findingIds: raw["findingIds"] });
  }
  if (dimensions.length !== 6 || new Set(dimensions.map((item) => item.id)).size !== 6) {
    return invalid("Judge output requires each dimension exactly once.", "judgeOutput.dimensions");
  }
  const tests = parsePairs(parsed["tests"], "id", "assessment");
  const behaviors = parseTriples(parsed["behaviors"], "behavior", "coverage", "mutation");
  if (tests === null || behaviors === null || tests.length === 0 || behaviors.length === 0) return invalid("Judge inventory rows are invalid or empty.", "judgeOutput.inventory");
  const findings: TypeScriptTestJudgeReport["findings"][number][] = [];
  for (const raw of parsed["findings"]) {
    if (!isRecord(raw) || !["VIOLATION", "GAP"].includes(String(raw["classification"]))
      || !["id", "rubricId", "location", "evidence", "fix"].every((key) => typeof raw[key] === "string")
      || typeof raw["deduction"] !== "number" || !RUBRIC_COSTS.has(raw["rubricId"] as string)) {
      return invalid("Judge finding is invalid.", "judgeOutput.findings");
    }
    findings.push({
      id: raw["id"] as string,
      classification: raw["classification"] as "VIOLATION" | "GAP",
      rubricId: raw["rubricId"] as string,
      deduction: RUBRIC_COSTS.get(raw["rubricId"] as string)!,
      location: raw["location"] as string,
      evidence: raw["evidence"] as string,
      fix: raw["fix"] as string,
    });
  }
  if (new Set(findings.map((finding) => finding.id)).size !== findings.length) return invalid("Judge finding IDs must be unique.", "judgeOutput.findings");
  const canonicalDimensions: TypeScriptTestJudgeDimension[] = [];
  for (const dimension of dimensions) {
    const dimensionFindings = findings.filter((finding) => finding.rubricId.startsWith(dimension.id.slice(1) + "."));
    const byRule = new Map<string, number>();
    for (const finding of dimensionFindings) byRule.set(finding.rubricId, (byRule.get(finding.rubricId) ?? 0) + finding.deduction);
    const deducted = [...byRule].reduce((sum, [rubricId, amount]) => sum + Math.min(amount, RUBRIC_RULE_CAPS.get(rubricId) ?? amount), 0);
    canonicalDimensions.push({ id: dimension.id, max: dimension.max, earned: Math.max(0, dimension.max - deducted), findingIds: dimensionFindings.map((finding) => finding.id) });
  }
  const total = canonicalDimensions.reduce((sum, dimension) => sum + dimension.earned, 0);
  const expectedVerdict = verdict(total);
  const caveats = [...parsed["caveats"]];
  if (parsed["total"] !== total || parsed["verdict"] !== expectedVerdict || JSON.stringify(dimensions) !== JSON.stringify(canonicalDimensions)) {
    caveats.push("Omega normalized the model-proposed arithmetic using normative fixed deductions, caps, and dimension floors.");
  }
  return { ok: true, value: { total, verdict: expectedVerdict, dimensions: canonicalDimensions, tests, behaviors, findings, nits: parsed["nits"], caveats } };
}

export async function runTypeScriptTestQualityScenario(
  models: ModelRouter,
  input: {
    readonly condition: TypeScriptTestQualityRun["condition"];
    readonly replicate: number;
    readonly harnessId: HarnessId;
    readonly installedSkills: readonly InstalledTransferSkill[];
    readonly image?: string;
    readonly typeScriptBin?: string;
    readonly nodeTypeRoots?: string;
    readonly fixture?: TypeScriptTestFixture;
    readonly objective?: string;
    readonly maxModelTurns?: number;
    readonly maxOutputTokens?: number;
    readonly modelCallTimeoutMs?: number;
    readonly onProgress?: (event: { readonly kind: "model-turn" | "verification"; readonly turn: number; readonly toolCalls: number }) => void;
  },
): Promise<Result<TypeScriptTestQualityRun, EvolutionError>> {
  const root = await mkdtemp(join(tmpdir(), "omega-ts-tests-"));
  try {
    const fixture = input.fixture ?? defaultTypeScriptTestFixture();
    await materialize(root, fixture.files);
    const messages: ModelMessage[] = [...renderTypeScriptTestAuthorPrompt(
      input.installedSkills.map((skill) => skill.catalog),
      input.objective,
      Object.keys(fixture.files).sort(),
    )];
    const byId = new Map(input.installedSkills.map((skill) => [skill.catalog.componentId, skill] as const));
    const trace = { skillReads: [] as ComponentId[], fileReads: [] as string[], fileWrites: [] as string[], processCalls: [] as string[], toolErrors: [] as string[] };
    const completions: ModelCompletion[] = [];
    let response = "";
    let providerRetries = 0;
    let toolCalls = 0;
    const sessionId = `session_ts_test_quality_${input.replicate}_${input.condition}_${randomUUID()}` as SessionId;
    const capabilities = authorCapabilities();
    const maxModelTurns = input.maxModelTurns ?? 14;
    for (let turn = 0; turn < maxModelTurns; turn += 1) {
      const completed = await completeWithRetries(models, {
        sessionId,
        harnessId: input.harnessId,
        role: "main-coder",
        messages,
        tools: TOOLS,
        maxOutputTokens: (input.maxOutputTokens ?? 6_000) as TokenCount,
        abortAfterMs: (input.modelCallTimeoutMs ?? 300_000) as DurationMs,
      }, capabilities, () => { providerRetries += 1; });
      if (!completed.ok) return completed;
      if (completions[0] !== undefined && routeMismatch(completions[0].route, completed.value.route) !== null) {
        return invalid("Model route changed during authoring.", "route");
      }
      completions.push(completed.value);
      const calls = completed.value.content.filter((part) => part.kind === "tool-call");
      input.onProgress?.({ kind: "model-turn", turn: turn + 1, toolCalls: calls.length });
      if (calls.length === 0) {
        response = completed.value.content.filter((part) => part.kind === "text").map((part) => part.text).join("");
        break;
      }
      messages.push({ role: "assistant", content: calls });
      const results = [];
      for (const call of calls) {
        toolCalls += 1;
        results.push(await executeTool(call, root, byId, trace, input.image ?? "omega-runner:local"));
      }
      messages.push({ role: "tool", content: results });
    }
    const latest = completions.at(-1);
    if (latest === undefined) return invalid("Authoring produced no model completion.", "modelOutput");
    const finalFiles = await collectFiles(root);
    input.onProgress?.({ kind: "verification", turn: completions.length, toolCalls });
    const verification = await verifyTestArtifact(root, input.image ?? "omega-runner:local", input.typeScriptBin, input.nodeTypeRoots, fixture);
    const installedIds = new Set(input.installedSkills.map((skill) => skill.catalog.componentId));
    const relevantReads = trace.skillReads.filter((id) => installedIds.has(id));
    const retrievalCorrect = input.condition === "incumbent"
      ? trace.skillReads.length === 0
      : relevantReads.length === 1 && trace.skillReads.length === 1;
    return {
      ok: true,
      value: {
        condition: input.condition,
        replicate: input.replicate,
        harnessId: input.harnessId,
        sessionId,
        route: latest.route,
        providerGenerationIds: completions.map((completion) => completion.providerGenerationId),
        usage: sumUsage(completions),
        modelTurns: completions.length,
        providerRetries,
        toolCalls,
        skillReadComponentIds: trace.skillReads,
        retrievalCorrect,
        fileReads: trace.fileReads,
        fileWrites: trace.fileWrites,
        processCalls: trace.processCalls,
        toolErrors: trace.toolErrors,
        response,
        finalFiles,
        verification,
        score: scoreTypeScriptTestArtifact({ ...verification, totalMutations: fixture.mutations.length }),
        judge: null,
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function judgeTypeScriptTestQualityRun(
  models: ModelRouter,
  run: TypeScriptTestQualityRun,
  graderSkill: string,
  rubric: string,
): Promise<Result<TypeScriptTestJudgeEvidence, EvolutionError>> {
  const completion = await completeWithRetries(models, {
    sessionId: `session_ts_test_judge_${run.replicate}_${run.condition}_${randomUUID()}` as SessionId,
    harnessId: run.harnessId,
    role: "promotion-evaluator",
    messages: renderJudgePrompt(run, graderSkill, rubric),
    tools: [],
    maxOutputTokens: 16_000 as TokenCount,
    abortAfterMs: 300_000 as DurationMs,
  }, judgeCapabilities(), () => {});
  if (!completion.ok) return completion;
  const rawResponse = completion.value.content.filter((part) => part.kind === "text").map((part) => part.text).join("");
  const report = parseTypeScriptTestJudgeReport(rawResponse);
  if (!report.ok) {
    const reason = report.error.kind === "validation" ? report.error.message : report.error.kind;
    const field = report.error.kind === "validation" ? report.error.field ?? "judgeOutput" : "judgeOutput";
    return invalid(`${reason} Response length: ${rawResponse.length}. Head: ${rawResponse.slice(0, 1_200)} Tail: ${rawResponse.slice(-800)}`, field);
  }
  return { ok: true, value: { report: report.value, route: completion.value.route, providerGenerationId: completion.value.providerGenerationId, usage: completion.value.usage, rawResponse } };
}

function renderJudgePrompt(run: TypeScriptTestQualityRun, skill: string, rubric: string): readonly ModelMessage[] {
  const testFiles = Object.entries(run.finalFiles).filter(([path]) => path.startsWith("tests/")).sort(([left], [right]) => left.localeCompare(right));
  return [
    { role: "system", content: [{ kind: "text", text: [
      "You are an independent TypeScript test-quality judge. Grade one artifact, never compare it to another artifact and never propose code changes beyond one-line finding fixes.",
      "Apply the supplied skill and normative rubric mechanically. Return exactly one JSON object in the machine-readable shape required by the skill, with all six dimensions and complete test and behavior inventories. Omega recomputes fixed deductions, caps, scores, total, and verdict from your finding rubric IDs.",
      "The executable evidence is trusted observation. Use it to ground defect sensitivity, but still inspect the tests and source. Do not invent deductions outside the rubric and do not double-charge.",
      "Keep every assessment, behavior, coverage, mutation, evidence, and fix string under 180 characters. nits and caveats must be arrays of strings, never objects. Do not use a Markdown fence.",
      "Required JSON shape (replace examples; use positive deduction magnitudes):",
      JSON.stringify({
        total: 100,
        verdict: "Exemplary",
        dimensions: [
          { id: "D1", max: 10, earned: 10, findingIds: [] }, { id: "D2", max: 20, earned: 20, findingIds: [] },
          { id: "D3", max: 20, earned: 20, findingIds: [] }, { id: "D4", max: 30, earned: 30, findingIds: [] },
          { id: "D5", max: 10, earned: 10, findingIds: [] }, { id: "D6", max: 10, earned: 10, findingIds: [] },
        ],
        tests: [{ id: "test name", assessment: "all table dimensions summarized" }],
        behaviors: [{ behavior: "source behavior with file:line", coverage: "test name or GAP", mutation: "flip mutation and failing assertion, or dash" }],
        findings: [{ id: "F1", classification: "GAP", rubricId: "4.1", deduction: 4, location: "file:line", evidence: "specific evidence", fix: "one-line fix" }],
        nits: [], caveats: [],
      }),
      "GRADING SKILL:", skill, "NORMATIVE RUBRIC:", rubric,
    ].join("\n\n") }] },
    { role: "user", content: [{ kind: "text", text: [
      `Condition label: ${run.condition}`,
      "package.json:\n" + (run.finalFiles["package.json"] ?? "<missing>"),
      "tsconfig.json:\n" + (run.finalFiles["tsconfig.json"] ?? "<missing>"),
      "README.md:\n" + (run.finalFiles["README.md"] ?? "<missing>"),
      "src/plan-dispatch.ts:\n" + (run.finalFiles["src/plan-dispatch.ts"] ?? "<missing>"),
      ...testFiles.map(([path, content]) => `${path}:\n${content}`),
      "Executable evidence:\n" + JSON.stringify({
        sourcePreserved: run.verification.sourcePreserved,
        nativePass: run.verification.nativePass,
        repeatedPass: run.verification.repeatedPass,
        typecheckPass: run.verification.typecheckPass,
        killedMutationIds: run.verification.killedMutationIds,
        survivingMutationIds: run.verification.survivingMutationIds,
        inconclusiveMutationIds: run.verification.inconclusiveMutationIds,
      }),
    ].join("\n\n") }] },
  ];
}

export async function verifyTypeScriptTestFixture(
  root: string,
  fixture: TypeScriptTestFixture,
  image = "omega-runner:local",
  typeScriptBin?: string,
  nodeTypeRoots?: string,
): Promise<TypeScriptTestVerification> {
  return verifyTestArtifact(root, image, typeScriptBin, nodeTypeRoots, fixture);
}

async function verifyTestArtifact(
  root: string,
  image: string,
  typeScriptBin: string | undefined,
  nodeTypeRoots: string | undefined,
  fixture: TypeScriptTestFixture,
): Promise<TypeScriptTestVerification> {
  const runs: TypeScriptTestVerification["runs"][number][] = [];
  const expectedSource = fixture.files[fixture.sourcePath];
  if (expectedSource === undefined) return { sourcePreserved: false, nativePass: false, repeatedPass: false, typecheckPass: false, killedMutationIds: [], survivingMutationIds: [], inconclusiveMutationIds: fixture.mutations.map((mutation) => mutation.id), runs };
  const source = await readFile(join(root, fixture.sourcePath), "utf8");
  const sourcePreserved = source === expectedSource;
  const first = await dockerProcess(root, image, "npm", ["test"]);
  runs.push({ label: "native-1", ...first });
  const second = await dockerProcess(root, image, "npm", ["test"]);
  runs.push({ label: "native-2", ...second });
  let typecheckPass = false;
  if (typeScriptBin !== undefined && nodeTypeRoots !== undefined) {
    const checked = await hostProcess(typeScriptBin, ["--noEmit", "--project", "tsconfig.json", "--typeRoots", nodeTypeRoots], root);
    runs.push({ label: "typecheck", ...checked });
    typecheckPass = checked.exitCode === 0;
  }
  const killed: string[] = [];
  const surviving: string[] = [];
  const inconclusive: string[] = [];
  if (sourcePreserved && first.exitCode === 0) {
    for (const mutation of fixture.mutations) {
      await writeFile(join(root, fixture.sourcePath), mutation.apply(expectedSource), "utf8");
      const result = await dockerProcess(root, image, "npm", ["test"]);
      runs.push({ label: `mutant:${mutation.id}`, ...result });
      if (result.exitCode === 0) surviving.push(mutation.id);
      else if (result.exitCode === null) inconclusive.push(mutation.id);
      else killed.push(mutation.id);
    }
    await writeFile(join(root, fixture.sourcePath), expectedSource, "utf8");
  }
  return {
    sourcePreserved,
    nativePass: first.exitCode === 0,
    repeatedPass: first.exitCode === 0 && second.exitCode === 0,
    typecheckPass,
    killedMutationIds: killed,
    survivingMutationIds: surviving,
    inconclusiveMutationIds: inconclusive,
    runs,
  };
}

async function materialize(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

async function executeTool(
  call: Extract<ModelCompletion["content"][number], { readonly kind: "tool-call" }>,
  root: string,
  skills: ReadonlyMap<ComponentId, InstalledTransferSkill>,
  trace: { skillReads: ComponentId[]; fileReads: string[]; fileWrites: string[]; processCalls: string[]; toolErrors: string[] },
  image: string,
) {
  const result = (value: JsonValue, isError = false) => ({ kind: "tool-result" as const, callId: call.callId, toolName: call.toolName, result: value, isError });
  const fail = (message: string) => { trace.toolErrors.push(`${call.toolName}: ${message}`); return result({ error: message }, true); };
  if (call.toolName === "skill.read") {
    const id = typeof call.input["componentId"] === "string" ? call.input["componentId"] as ComponentId : null;
    if (id === null || !skills.has(id)) return fail("Skill is not installed.");
    if (trace.skillReads.includes(id)) return fail("Immutable skill was already read in this session.");
    trace.skillReads.push(id);
    return result({ componentId: id, markdown: skills.get(id)!.markdown });
  }
  if (call.toolName === "file.read") {
    const path = typeof call.input["path"] === "string" ? call.input["path"] : "";
    const target = safeTarget(root, path);
    if (target === null) return fail("Path must be repository-relative.");
    try {
      const content = await readFile(target, "utf8");
      trace.fileReads.push(path);
      return result({ path, content, sha: sha(content) });
    } catch { return fail("File does not exist or is not UTF-8."); }
  }
  if (call.toolName === "file.write") {
    const path = typeof call.input["path"] === "string" ? call.input["path"] : "";
    if (path.startsWith("src/")) return fail("Production source is read-only for this task.");
    const content = typeof call.input["content"] === "string" ? call.input["content"] : null;
    const expectedSha = typeof call.input["expectedSha"] === "string" ? call.input["expectedSha"] : null;
    const target = safeTarget(root, path);
    if (target === null || content === null) return fail("Write requires a safe path and UTF-8 content.");
    let current: string | null = null;
    try { current = await readFile(target, "utf8"); } catch { current = null; }
    if ((current === null && expectedSha !== null) || (current !== null && expectedSha !== sha(current))) return fail("stale-read: read again and retry with current SHA.");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    trace.fileWrites.push(path);
    return result({ path, sha: sha(content) });
  }
  if (call.toolName === "process.start") {
    const executable = typeof call.input["executable"] === "string" ? call.input["executable"] : "";
    const args = Array.isArray(call.input["args"]) && call.input["args"].every((value) => typeof value === "string") ? call.input["args"] as string[] : [];
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(executable)) return fail("Executable must be a simple command name.");
    const executed = await dockerProcess(root, image, executable, args);
    trace.processCalls.push([executable, ...args].join(" "));
    return executed.exitCode === 0 ? result(executed) : fail(JSON.stringify(executed));
  }
  return fail("Unsupported tool.");
}

async function collectFiles(root: string): Promise<Readonly<Record<string, string>>> {
  const files: Record<string, string> = {};
  for (const path of await recursivePaths(root)) {
    try { files[path] = await readFile(join(root, path), "utf8"); } catch { /* Ignore non-UTF-8 output. */ }
  }
  return files;
}

async function recursivePaths(root: string, current = ""): Promise<string[]> {
  const entries = await readdir(join(root, current), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = current.length === 0 ? entry.name : `${current}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...await recursivePaths(root, path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

async function dockerProcess(workspace: string, image: string, executable: string, args: readonly string[]) {
  return childProcess("docker", [
    "run", "--rm", "--network", "none", "--memory", "512m", "--cpus", "1", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--mount", `type=bind,src=${workspace},dst=/workspace`, "--workdir", "/workspace", image, executable, ...args,
  ], process.cwd(), 60_000);
}

async function hostProcess(executable: string, args: readonly string[], cwd: string) {
  return childProcess(executable, args, cwd, 60_000);
}

async function childProcess(executable: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (stdout.length < 128 * 1024) stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 128 * 1024) stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => { clearTimeout(timeout); done({ exitCode: null, stdout, stderr: `${stderr}${String(error)}` }); });
    child.on("close", (code) => { clearTimeout(timeout); done({ exitCode: code, stdout, stderr }); });
  });
}

function safeTarget(root: string, path: string): string | null {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\")) return null;
  const target = resolve(root, path);
  const scoped = relative(root, target);
  return scoped.length > 0 && !scoped.startsWith("..") && !scoped.startsWith("/") ? target : null;
}

function sha(content: string): Sha256 { return createHash("sha256").update(content, "utf8").digest("hex") as Sha256; }

function authorCapabilities(): CapabilityEnvelope {
  return { grants: [], modelRoles: ["main-coder"], maxCostUsdMicros: 0 as UsdMicros, maxModelCalls: 14, maxProcessStarts: 8, maxInputTokens: 220_000 as TokenCount, maxOutputTokens: 40_000 as TokenCount, wallTimeMs: 600_000 as DurationMs, createdAt: "2026-07-20T00:00:00.000Z" as Timestamp };
}

function judgeCapabilities(): CapabilityEnvelope {
  return { grants: [], modelRoles: ["promotion-evaluator"], maxCostUsdMicros: 0 as UsdMicros, maxModelCalls: 1, maxProcessStarts: 0, maxInputTokens: 120_000 as TokenCount, maxOutputTokens: 24_000 as TokenCount, wallTimeMs: 300_000 as DurationMs, createdAt: "2026-07-20T00:00:00.000Z" as Timestamp };
}

async function completeWithRetries(models: ModelRouter, request: Parameters<ModelRouter["stream"]>[0], capabilities: CapabilityEnvelope, retried: () => void): Promise<Result<ModelCompletion, EvolutionError>> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const started = await models.stream(request, capabilities);
    const completed = started.ok ? await terminalCompletion(started.value.events) : started;
    if (completed.ok && !transportSentinel(completed.value)) return completed;
    if (completed.ok) {
      if (attempt === 3) return invalid("Provider returned a transport-error sentinel as model text three times.", "modelOutput");
      retried();
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, attempt * 250));
      continue;
    }
    if (!((completed.error.kind === "provider-unavailable" || completed.error.kind === "provider-rate-limited") && completed.error.recoverable) || attempt === 3) return completed;
    retried();
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, attempt * 250));
  }
  return invalid("Provider retry loop ended without a result.", "modelOutput");
}

function transportSentinel(completion: ModelCompletion): boolean {
  const calls = completion.content.some((part) => part.kind === "tool-call");
  const text = completion.content.filter((part) => part.kind === "text").map((part) => part.text).join("").trim();
  return !calls && /^(connect timeout|connection timed out|upstream request timeout),?\s*(please try again later\.?|try again\.?)?$/iu.test(text);
}

async function terminalCompletion(events: AsyncIterable<ModelStreamEvent>): Promise<Result<ModelCompletion, EvolutionError>> {
  let completion: ModelCompletion | null = null;
  for await (const event of events) {
    if (event.kind === "completed") completion = event.completion;
    if (event.kind === "failed") return { ok: false, error: event.error };
  }
  return completion === null ? invalid("Model stream ended without completion.", "modelOutput") : { ok: true, value: completion };
}

function routeMismatch(left: ModelRouteSignature, right: ModelRouteSignature): string | null {
  if (left.providerId !== right.providerId || left.modelId !== right.modelId || left.variant !== right.variant) return "different-model";
  if (JSON.stringify(left.reasoning) !== JSON.stringify(right.reasoning)) return "different-reasoning";
  if (left.servingProvider === null || right.servingProvider === null) return "provider-metadata-missing";
  if (left.servingProvider !== right.servingProvider) return "different-serving-provider";
  if (left.quantization !== right.quantization) return "different-quantization";
  if (left.temperature !== right.temperature || left.topP !== right.topP || left.seed !== right.seed || left.contextLimit !== right.contextLimit || left.outputLimit !== right.outputLimit) return "different-parameters";
  return null;
}

function sumUsage(completions: readonly ModelCompletion[]): ModelUsage {
  return {
    inputTokens: completions.reduce((sum, item) => sum + Number(item.usage.inputTokens), 0) as TokenCount,
    cachedInputTokens: completions.reduce((sum, item) => sum + Number(item.usage.cachedInputTokens), 0) as TokenCount,
    reasoningTokens: completions.reduce((sum, item) => sum + Number(item.usage.reasoningTokens), 0) as TokenCount,
    outputTokens: completions.reduce((sum, item) => sum + Number(item.usage.outputTokens), 0) as TokenCount,
    costUsdMicros: completions.reduce((sum, item) => sum + Number(item.usage.costUsdMicros), 0) as UsdMicros,
  };
}

function parsePairs(value: readonly unknown[], first: string, second: string): { readonly id: string; readonly assessment: string }[] | null {
  const rows: { id: string; assessment: string }[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw[first] !== "string" || typeof raw[second] !== "string") return null;
    rows.push({ id: raw[first], assessment: raw[second] });
  }
  return rows;
}

function parseTriples(value: readonly unknown[], first: string, second: string, third: string): { readonly behavior: string; readonly coverage: string; readonly mutation: string }[] | null {
  const rows: { behavior: string; coverage: string; mutation: string }[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw[first] !== "string" || typeof raw[second] !== "string" || typeof raw[third] !== "string") return null;
    rows.push({ behavior: raw[first], coverage: raw[second], mutation: raw[third] });
  }
  return rows;
}

function verdict(total: number): TypeScriptTestJudgeReport["verdict"] {
  return total >= 90 ? "Exemplary" : total >= 75 ? "Compliant" : total >= 50 ? "Needs work" : "Non-compliant";
}

function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function embeddedJsonObjects(source: string): readonly string[] {
  const values: string[] = [];
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
      } else if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) { values.push(source.slice(start, index + 1)); break; }
    }
  }
  return values;
}

function invalid(message: string, field: string): Result<never, EvolutionError> {
  return { ok: false, error: { kind: "validation", message, field, recoverable: true, callerAction: "fix-request" } };
}
