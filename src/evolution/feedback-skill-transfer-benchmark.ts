import type {
  EvolutionError,
  HarnessId,
  ModelRouter,
  ModelUsage,
  Result,
  TokenCount,
  UsdMicros,
} from "../contracts/index.js";
import type { ReflectionScenario, ReflectionTurn } from "./reflection-benchmark.js";
import type { InstalledTransferSkill } from "./reflection-skill-transfer-benchmark.js";
import {
  TEST_QUALITY_MUTATIONS,
  runTypeScriptTestQualityScenario,
  typescriptTestFixtureFiles,
  typescriptTestReferenceFiles,
  type TypeScriptTestFixture,
  type TypeScriptTestMutation,
  type TypeScriptTestQualityRun,
} from "./typescript-test-quality-benchmark.js";

export type FeedbackEpisodeRound = {
  readonly round: number;
  readonly objective: string;
  readonly run: TypeScriptTestQualityRun;
  readonly evaluatorFeedback: string | null;
};

export type FeedbackEpisode = {
  readonly fixtureId: string;
  readonly condition: TypeScriptTestQualityRun["condition"];
  readonly rounds: readonly FeedbackEpisodeRound[];
  readonly feedbackCount: number;
  readonly reachedQuality: boolean;
  readonly firstAttemptMutationKills: number;
  readonly finalMutationKills: number;
  readonly totalMutations: number;
  readonly modelTurns: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly invalidToolCalls: number;
  readonly usage: ModelUsage;
  readonly reflectionScenario: ReflectionScenario;
};

export type FeedbackTransferPair = {
  readonly fixtureId: string;
  readonly incumbent: FeedbackEpisode;
  readonly candidate: FeedbackEpisode;
  readonly comparable: boolean;
  readonly firstAttemptKillDelta: number;
  readonly feedbackDelta: number;
  readonly toolErrorDelta: number;
  readonly transferImproved: boolean;
};

const TRAINING_EXTRA_MUTATION: TypeScriptTestMutation = {
  id: "reserve-failure",
  description: "swallow a reservation dependency failure",
  apply: (source) => source.replace(
    "for (const [route, units] of routes) await capacity.reserve(route, units);",
    "for (const [route, units] of routes) await capacity.reserve(route, units).catch(() => undefined);",
  ),
};

const RESERVE_FAILURE_REFERENCE = `
test("surfaces reservation dependency failures", async () => {
  const capacity: CapacityGateway = {
    async remaining() { return 10; },
    async reserve() { throw new Error("storage unavailable"); },
  };
  await assert.rejects(
    () => planDispatch({ shipments: [{ route: "a", units: 1 }], rush: false }, capacity, clock("2026-07-20T12:00:00.000Z")),
    /storage unavailable/,
  );
});
`;

export function feedbackTrainingFixture(): { readonly fixture: TypeScriptTestFixture; readonly referenceFiles: Readonly<Record<string, string>> } {
  const files = {
    ...typescriptTestFixtureFiles(),
    "README.md": "# Dispatch planner\n\nUse the existing Node test runner. Keep tests deterministic and offline.\n",
  };
  const reference = typescriptTestReferenceFiles();
  return {
    fixture: {
      id: "learning-dispatch-planner",
      files,
      sourcePath: "src/plan-dispatch.ts",
      mutations: [...TEST_QUALITY_MUTATIONS, TRAINING_EXTRA_MUTATION],
    },
    referenceFiles: {
      ...reference,
      "README.md": files["README.md"],
      "tests/plan-dispatch.test.ts": `${reference["tests/plan-dispatch.test.ts"] ?? ""}${RESERVE_FAILURE_REFERENCE}`,
    },
  };
}

export const FEEDBACK_TRANSFER_FIXTURES: readonly {
  readonly fixture: TypeScriptTestFixture;
  readonly referenceFiles: Readonly<Record<string, string>>;
  readonly objective: string;
}[] = [batchActivationFixture(), releasePublicationFixture(), migrationFixture()] as const;

export function evaluatorFeedback(survivingMutationIds: readonly string[]): string | null {
  if (survivingMutationIds.length === 0) return null;
  const survivors = new Set(survivingMutationIds);
  const messages: string[] = [];
  if (["empty-list", "zero-units", "maximum-units", "exact-capacity", "empty-batch", "invalid-count", "size-boundary", "empty-migration"].some((id) => survivors.has(id))) {
    messages.push("The suite still misses empty, invalid, or exact-limit behavior. Test both sides of each boundary with independently known outcomes.");
  }
  if (["capacity-atomicity", "activation-atomicity", "upload-atomicity", "migration-atomicity"].some((id) => survivors.has(id))) {
    messages.push("A later preflight failure can still hide an earlier partial write. Arrange an earlier ordered item that could succeed and a later item that fails, then assert that no writes occurred.");
  }
  if (["reserve-failure", "activation-failure", "upload-failure", "migration-failure"].some((id) => survivors.has(id))) {
    messages.push("A dependency write failure is not protected. Make the fake reject and assert that the public operation surfaces the failure rather than reporting success.");
  }
  if (["duplicate-routes", "duplicate-features", "duplicate-artifacts", "duplicate-migrations"].some((id) => survivors.has(id))) {
    messages.push("Duplicate inputs are not distinguished. Exercise the documented aggregation or rejection behavior and assert observable state.");
  }
  if (["rush-window", "rush-surcharge", "injected-clock", "release-clock", "migration-clock"].some((id) => survivors.has(id))) {
    messages.push("Time-dependent behavior remains weak. Inject a fixed clock and cover the exact boundary or returned timestamp without reading ambient time.");
  }
  return messages.length > 0 ? messages.join(" ") : "The evaluator still finds behavior-changing implementations that pass. Inspect the contract and add assertions that distinguish each public branch.";
}

export function evaluatorFeedbackForRun(run: TypeScriptTestQualityRun): string | null {
  const messages: string[] = [];
  if (!run.verification.sourcePreserved) messages.push("Production source changed. Revert it and improve only tests or test-local helpers.");
  if (!run.verification.nativePass || !run.verification.repeatedPass) messages.push("The repository test command is not stably green. Fix the test failures before claiming completion.");
  if (!run.verification.typecheckPass) {
    const diagnostic = run.verification.runs.find((item) => item.label === "typecheck");
    const detail = `${diagnostic?.stdout ?? ""}${diagnostic?.stderr ?? ""}`.trim().slice(0, 1_000);
    messages.push(`The suite fails strict TypeScript compilation. Fix these diagnostics: ${detail || "typecheck exited nonzero"}`);
  }
  if (run.verification.inconclusiveMutationIds.length > 0) messages.push("Some evaluator executions did not terminate conclusively; make the suite deterministic and bounded.");
  const behavior = evaluatorFeedback(run.verification.survivingMutationIds);
  if (behavior !== null) messages.push(behavior);
  return messages.length === 0 ? null : messages.join(" ");
}

export async function runFeedbackEpisode(
  models: ModelRouter,
  input: {
    readonly fixture: TypeScriptTestFixture;
    readonly objective: string;
    readonly condition: TypeScriptTestQualityRun["condition"];
    readonly harnessId: HarnessId;
    readonly installedSkills: readonly InstalledTransferSkill[];
    readonly replicate: number;
    readonly maxFeedbackRounds?: number;
    readonly image?: string;
    readonly typeScriptBin?: string;
    readonly nodeTypeRoots?: string;
    readonly onProgress?: (event: { readonly round: number; readonly kind: "model-turn" | "verification"; readonly turn: number; readonly toolCalls: number }) => void;
  },
): Promise<Result<FeedbackEpisode, EvolutionError>> {
  const rounds: FeedbackEpisodeRound[] = [];
  let files = input.fixture.files;
  let objective = input.objective;
  const maxFeedbackRounds = input.maxFeedbackRounds ?? 3;
  for (let round = 0; round <= maxFeedbackRounds; round += 1) {
    const run = await runTypeScriptTestQualityScenario(models, {
      condition: input.condition,
      replicate: input.replicate * 10 + round,
      harnessId: input.harnessId,
      installedSkills: input.installedSkills,
      ...(input.image === undefined ? {} : { image: input.image }),
      ...(input.typeScriptBin === undefined ? {} : { typeScriptBin: input.typeScriptBin }),
      ...(input.nodeTypeRoots === undefined ? {} : { nodeTypeRoots: input.nodeTypeRoots }),
      fixture: { ...input.fixture, files },
      objective,
      maxModelTurns: 10,
      maxOutputTokens: 10_000,
      modelCallTimeoutMs: 180_000,
      onProgress: (event) => input.onProgress?.({ round: round + 1, ...event }),
    });
    if (!run.ok) return run;
    const complete = run.value.score.executablePassed
      && run.value.verification.killedMutationIds.length === input.fixture.mutations.length;
    const feedback = complete || round === maxFeedbackRounds
      ? null
      : evaluatorFeedbackForRun(run.value);
    rounds.push({ round: round + 1, objective, run: run.value, evaluatorFeedback: feedback });
    files = run.value.finalFiles;
    if (complete || feedback === null) break;
    objective = `The tests are not good enough yet. User feedback: ${feedback} Continue improving the tests. Do not change production source.`;
  }
  const last = rounds.at(-1);
  if (last === undefined) return invalid("Feedback episode produced no authoring round.", "episode.rounds");
  const reachedQuality = last.run.score.executablePassed
    && last.run.verification.killedMutationIds.length === input.fixture.mutations.length;
  return { ok: true, value: {
    fixtureId: input.fixture.id,
    condition: input.condition,
    rounds,
    feedbackCount: rounds.filter((round) => round.evaluatorFeedback !== null).length,
    reachedQuality,
    firstAttemptMutationKills: rounds[0]?.run.score.killedMutations ?? 0,
    finalMutationKills: last.run.score.killedMutations,
    totalMutations: input.fixture.mutations.length,
    modelTurns: rounds.reduce((sum, round) => sum + round.run.modelTurns, 0),
    toolCalls: rounds.reduce((sum, round) => sum + round.run.toolCalls, 0),
    toolErrors: rounds.reduce((sum, round) => sum + round.run.toolErrors.length, 0),
    invalidToolCalls: rounds.reduce((sum, round) => sum + round.run.toolErrors.filter((error) => !error.startsWith("process.start:")).length, 0),
    usage: sumUsage(rounds.map((round) => round.run.usage)),
    reflectionScenario: reflectionScenario(input.fixture.id, input.objective, rounds, reachedQuality),
  } };
}

export function compareFeedbackTransferEpisodes(incumbent: FeedbackEpisode, candidate: FeedbackEpisode): FeedbackTransferPair {
  const firstAttemptKillDelta = candidate.firstAttemptMutationKills - incumbent.firstAttemptMutationKills;
  const feedbackDelta = candidate.feedbackCount - incumbent.feedbackCount;
  const toolErrorDelta = candidate.invalidToolCalls - incumbent.invalidToolCalls;
  const comparable = incumbent.fixtureId === candidate.fixtureId && incumbent.totalMutations === candidate.totalMutations;
  const correctnessNoWorse = candidate.reachedQuality && candidate.finalMutationKills >= incumbent.finalMutationKills;
  const strictlyBetter = firstAttemptKillDelta > 0 || (firstAttemptKillDelta === 0 && feedbackDelta < 0)
    || (firstAttemptKillDelta === 0 && feedbackDelta === 0 && toolErrorDelta < 0);
  return { fixtureId: incumbent.fixtureId, incumbent, candidate, comparable, firstAttemptKillDelta, feedbackDelta, toolErrorDelta,
    transferImproved: comparable && correctnessNoWorse && strictlyBetter };
}

function reflectionScenario(id: string, objective: string, rounds: readonly FeedbackEpisodeRound[], reachedQuality: boolean): ReflectionScenario {
  const turns: ReflectionTurn[] = [{ id: "t01", role: "user", content: objective }];
  let index = 2;
  for (const round of rounds) {
    turns.push({ id: turnId(index++), role: "assistant", content: round.run.response || `Completed test-authoring round ${round.round}.` });
    turns.push({ id: turnId(index++), role: "tool", content: `Evaluator: ${round.run.score.killedMutations}/${round.run.score.totalMutations} defects detected; suite valid: ${round.run.score.executablePassed}.` });
    if (round.evaluatorFeedback !== null) turns.push({ id: turnId(index++), role: "user", content: round.evaluatorFeedback });
  }
  turns.push({ id: turnId(index), role: "user", content: reachedQuality
    ? "Correct. Capture the reusable procedure that made the final tests detect the defects, without memorizing this module's names or expected values."
    : "The correction budget ended. Preserve only evidence-supported lessons and do not claim the tests are complete." });
  const feedbackIds = turns.filter((turn) => turn.role === "user" && turn.id !== "t01").map((turn) => turn.id);
  const requiredSourceIds = feedbackIds.length > 0 ? [feedbackIds[0]!, feedbackIds.at(-1)!] : [turns.at(-1)!.id];
  return {
    id: `feedback-${id}`.slice(0, 64),
    title: "User feedback teaches a reusable TypeScript test-design procedure",
    projectContext: "A developer repeatedly corrects a test-authoring agent until executable mutation checks show a strong suite.",
    turns,
    rubric: {
      decision: "evolve",
      target: "skill",
      requiredSourceIds,
      concepts: [
        { label: "behavioral defect sensitivity", alternatives: ["mutation", "defect", "go red", "behavior-changing"] },
        { label: "systematic boundaries and failures", alternatives: ["boundary", "dependency failure", "error path", "edge case"] },
        { label: "observable state over implementation", alternatives: ["observable state", "public outcome", "partial write", "no writes"] },
      ],
      forbiddenClaims: ["copy this fixture", "hardcode plan-dispatch", "memorize expected values"],
      maxLessons: 2,
    },
  };
}

function turnId(index: number): string { return `t${String(index).padStart(2, "0")}`; }

function sumUsage(values: readonly ModelUsage[]): ModelUsage {
  return {
    inputTokens: values.reduce((sum, value) => sum + Number(value.inputTokens), 0) as TokenCount,
    cachedInputTokens: values.reduce((sum, value) => sum + Number(value.cachedInputTokens), 0) as TokenCount,
    reasoningTokens: values.reduce((sum, value) => sum + Number(value.reasoningTokens), 0) as TokenCount,
    outputTokens: values.reduce((sum, value) => sum + Number(value.outputTokens), 0) as TokenCount,
    costUsdMicros: values.reduce((sum, value) => sum + Number(value.costUsdMicros), 0) as UsdMicros,
  };
}

function invalid(message: string, field: string): Result<never, EvolutionError> {
  return { ok: false, error: { kind: "validation", message, field, recoverable: true, callerAction: "fix-request" } };
}

function commonFiles(name: string, sourcePath: string, source: string, test: string): Readonly<Record<string, string>> {
  return {
    "package.json": `${JSON.stringify({ name, private: true, type: "module", scripts: { test: "node --test tests/*.test.ts" } }, null, 2)}\n`,
    "tsconfig.json": `${JSON.stringify({ compilerOptions: { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true, types: ["node"] }, include: ["src/**/*.ts", "tests/**/*.ts"] }, null, 2)}\n`,
    "README.md": `# ${name}\n\nUse the existing test command. Keep tests deterministic and offline.\n`,
    [sourcePath]: source,
    [`tests/${name}.test.ts`]: test,
  };
}

function replace(source: string, before: string, after: string): string { return source.includes(before) ? source.replace(before, after) : source; }

function batchActivationFixture() {
  const sourcePath = "src/activate-batch.ts";
  const source = `export type Request = Readonly<{ feature: string; seats: number }>;
export interface FeatureStore { available(feature: string): Promise<number>; activate(feature: string, seats: number): Promise<void> }
export async function activateBatch(requests: readonly Request[], store: FeatureStore): Promise<readonly Request[]> {
  if (requests.length === 0) throw new Error("EMPTY");
  const totals = new Map<string, number>();
  for (const item of requests) {
    if (!Number.isInteger(item.seats) || item.seats < 1 || item.seats > 20) throw new Error("INVALID_SEATS");
    totals.set(item.feature, (totals.get(item.feature) ?? 0) + item.seats);
  }
  const entries = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [feature, seats] of entries) if (await store.available(feature) < seats) throw new Error("UNAVAILABLE");
  for (const [feature, seats] of entries) await store.activate(feature, seats);
  return entries.map(([feature, seats]) => ({ feature, seats }));
}
`;
  const seed = `import assert from "node:assert/strict"; import test from "node:test"; import { activateBatch } from "../src/activate-batch.ts";
test("activates one feature", async () => { const writes: unknown[] = []; const result = await activateBatch([{ feature: "search", seats: 2 }], { async available(){return 10}, async activate(f,s){writes.push([f,s])} }); assert.equal(result.length, 1); });
`;
  const reference = `import assert from "node:assert/strict"; import test from "node:test"; import { activateBatch, type FeatureStore } from "../src/activate-batch.ts";
class Store implements FeatureStore { writes: unknown[]=[]; private values: Record<string,number>; constructor(values: Record<string,number>){ this.values=values } async available(k:string){return this.values[k]??0} async activate(k:string,n:number){this.writes.push([k,n])} }
test("rejects empty and invalid boundaries", async()=>{const s=new Store({}); await assert.rejects(()=>activateBatch([],s),/EMPTY/); for(const n of [0,21,1.5]) await assert.rejects(()=>activateBatch([{feature:"a",seats:n}],s),/INVALID/);});
test("accepts exact maximum and aggregates duplicates", async()=>{const s=new Store({a:20}); assert.deepEqual(await activateBatch([{feature:"a",seats:10},{feature:"a",seats:10}],s),[{feature:"a",seats:20}]); assert.deepEqual(s.writes,[["a",20]]);});
test("preflights all before writes", async()=>{const s=new Store({a:1,b:0}); await assert.rejects(()=>activateBatch([{feature:"a",seats:1},{feature:"b",seats:1}],s),/UNAVAILABLE/); assert.deepEqual(s.writes,[]);});
test("surfaces activation failures", async()=>{const failure=new Error("ACTIVATE_FAILED"); await assert.rejects(()=>activateBatch([{feature:"a",seats:1}],{async available(){return 1},async activate(){throw failure}}),failure);});
`;
  const mutations: TypeScriptTestMutation[] = [
    { id: "empty-batch", description: "accept empty", apply: (s) => replace(s, "requests.length === 0", "requests.length < 0") },
    { id: "invalid-count", description: "accept zero", apply: (s) => replace(s, "item.seats < 1", "item.seats < 0") },
    { id: "duplicate-features", description: "drop aggregation", apply: (s) => replace(s, "(totals.get(item.feature) ?? 0) + item.seats", "item.seats") },
    { id: "activation-atomicity", description: "write during preflight", apply: (s) => replace(s, "for (const [feature, seats] of entries) if (await store.available(feature) < seats) throw new Error(\"UNAVAILABLE\");\n  for (const [feature, seats] of entries) await store.activate(feature, seats);", "for (const [feature, seats] of entries) { if (await store.available(feature) < seats) throw new Error(\"UNAVAILABLE\"); await store.activate(feature, seats); }") },
    { id: "activation-failure", description: "swallow activation failure", apply: (s) => replace(s, "await store.activate(feature, seats);", "await store.activate(feature, seats).catch(() => undefined);") },
  ];
  const files = commonFiles("activate-batch", sourcePath, source, seed);
  return { objective: `Create good tests for ${sourcePath}. Do not modify production code.`, fixture: { id: "near-batch-activation", files, sourcePath, mutations }, referenceFiles: { ...files, "tests/activate-batch.test.ts": reference } };
}

function releasePublicationFixture() {
  const sourcePath = "src/publish-release.ts";
  const source = `export type Artifact = Readonly<{ name: string; bytes: number }>;
export interface Registry { quota(name:string):Promise<number>; upload(name:string,bytes:number):Promise<void> }
export async function publishRelease(items: readonly Artifact[], registry: Registry): Promise<number> {
  if (items.length === 0) throw new Error("EMPTY");
  const names = new Set<string>();
  for (const item of items) { if (!Number.isInteger(item.bytes) || item.bytes < 1 || item.bytes > 1000) throw new Error("INVALID_SIZE"); if (names.has(item.name)) throw new Error("DUPLICATE"); names.add(item.name); }
  const ordered = [...items].sort((a,b)=>a.name.localeCompare(b.name));
  for (const item of ordered) if (await registry.quota(item.name) < item.bytes) throw new Error("QUOTA");
  for (const item of ordered) await registry.upload(item.name,item.bytes);
  return ordered.reduce((sum,item)=>sum+item.bytes,0);
}
`;
  const seed = `import assert from "node:assert/strict"; import test from "node:test"; import { publishRelease } from "../src/publish-release.ts";
test("publishes",async()=>{assert.equal(await publishRelease([{name:"a",bytes:2}],{async quota(){return 2},async upload(){}}),2)});
`;
  const reference = `import assert from "node:assert/strict"; import test from "node:test"; import { publishRelease, type Registry } from "../src/publish-release.ts";
class R implements Registry { uploads:string[]=[]; private q:Record<string,number>; constructor(q:Record<string,number>){this.q=q} async quota(n:string){return this.q[n]??0} async upload(n:string,b:number){this.uploads.push(n+":"+b)} }
test("validates empty and size boundaries",async()=>{const r=new R({a:1000}); await assert.rejects(()=>publishRelease([],r),/EMPTY/); for(const bytes of [0,1001,1.5]) await assert.rejects(()=>publishRelease([{name:"a",bytes}],r),/INVALID/); assert.equal(await publishRelease([{name:"a",bytes:1000}],r),1000)});
test("rejects duplicates",async()=>{await assert.rejects(()=>publishRelease([{name:"a",bytes:1},{name:"a",bytes:1}],new R({a:2})),/DUPLICATE/)});
test("preflights every upload",async()=>{const r=new R({a:1,b:0}); await assert.rejects(()=>publishRelease([{name:"a",bytes:1},{name:"b",bytes:1}],r),/QUOTA/); assert.deepEqual(r.uploads,[])});
test("surfaces upload failures",async()=>{const failure=new Error("UPLOAD_FAILED"); await assert.rejects(()=>publishRelease([{name:"a",bytes:1}],{async quota(){return 1},async upload(){throw failure}}),failure)});
`;
  const mutations: TypeScriptTestMutation[] = [
    { id: "size-boundary", description: "reject exact max", apply: (s) => replace(s, "item.bytes > 1000", "item.bytes >= 1000") },
    { id: "duplicate-artifacts", description: "allow duplicates", apply: (s) => replace(s, "if (names.has(item.name)) throw new Error(\"DUPLICATE\");", "if (false) throw new Error(\"DUPLICATE\");") },
    { id: "upload-atomicity", description: "upload during preflight", apply: (s) => replace(s, "for (const item of ordered) if (await registry.quota(item.name) < item.bytes) throw new Error(\"QUOTA\");\n  for (const item of ordered) await registry.upload(item.name,item.bytes);", "for (const item of ordered) { if (await registry.quota(item.name) < item.bytes) throw new Error(\"QUOTA\"); await registry.upload(item.name,item.bytes); }") },
    { id: "upload-failure", description: "swallow upload failure", apply: (s) => replace(s, "await registry.upload(item.name,item.bytes);", "await registry.upload(item.name,item.bytes).catch(() => undefined);") },
  ];
  const files = commonFiles("publish-release", sourcePath, source, seed);
  return { objective: `Create good tests for ${sourcePath}. Do not modify production code.`, fixture: { id: "general-release-publication", files, sourcePath, mutations }, referenceFiles: { ...files, "tests/publish-release.test.ts": reference } };
}

function migrationFixture() {
  const sourcePath = "src/apply-migrations.ts";
  const source = `export type Migration = Readonly<{ id: string }>;
export interface Database { canApply(id:string):Promise<boolean>; apply(id:string):Promise<void> }
export async function applyMigrations(items: readonly Migration[], db: Database): Promise<readonly string[]> {
  if (items.length === 0) throw new Error("EMPTY");
  const ids = [...new Set(items.map(item=>item.id))].sort();
  for (const id of ids) if (!(await db.canApply(id))) throw new Error("BLOCKED");
  for (const id of ids) await db.apply(id);
  return ids;
}
`;
  const seed = `import assert from "node:assert/strict"; import test from "node:test"; import { applyMigrations } from "../src/apply-migrations.ts";
test("applies one",async()=>{assert.deepEqual(await applyMigrations([{id:"001"}],{async canApply(){return true},async apply(){}}),["001"])});
`;
  const reference = `import assert from "node:assert/strict"; import test from "node:test"; import { applyMigrations, type Database } from "../src/apply-migrations.ts";
class D implements Database { writes:string[]=[]; private allowed:Record<string,boolean>; constructor(allowed:Record<string,boolean>){this.allowed=allowed} async canApply(id:string){return this.allowed[id]??false} async apply(id:string){this.writes.push(id)} }
test("rejects empty",async()=>{await assert.rejects(()=>applyMigrations([],new D({})),/EMPTY/)});
test("deduplicates and sorts",async()=>{const d=new D({a:true,b:true}); assert.deepEqual(await applyMigrations([{id:"b"},{id:"a"},{id:"a"}],d),["a","b"]); assert.deepEqual(d.writes,["a","b"])});
test("preflights before applying",async()=>{const d=new D({a:true,b:false}); await assert.rejects(()=>applyMigrations([{id:"a"},{id:"b"}],d),/BLOCKED/); assert.deepEqual(d.writes,[])});
test("surfaces migration failures",async()=>{const failure=new Error("APPLY_FAILED"); await assert.rejects(()=>applyMigrations([{id:"a"}],{async canApply(){return true},async apply(){throw failure}}),failure)});
`;
  const mutations: TypeScriptTestMutation[] = [
    { id: "empty-migration", description: "accept empty", apply: (s) => replace(s, "items.length === 0", "items.length < 0") },
    { id: "duplicate-migrations", description: "keep duplicates", apply: (s) => replace(s, "[...new Set(items.map(item=>item.id))].sort()", "items.map(item=>item.id).sort()") },
    { id: "migration-atomicity", description: "apply during preflight", apply: (s) => replace(s, "for (const id of ids) if (!(await db.canApply(id))) throw new Error(\"BLOCKED\");\n  for (const id of ids) await db.apply(id);", "for (const id of ids) { if (!(await db.canApply(id))) throw new Error(\"BLOCKED\"); await db.apply(id); }") },
    { id: "migration-failure", description: "swallow migration failure", apply: (s) => replace(s, "await db.apply(id);", "await db.apply(id).catch(() => undefined);") },
  ];
  const files = commonFiles("apply-migrations", sourcePath, source, seed);
  return { objective: `Create good tests for ${sourcePath}. Do not modify production code.`, fixture: { id: "distant-migration-batch", files, sourcePath, mutations }, referenceFiles: { ...files, "tests/apply-migrations.test.ts": reference } };
}
