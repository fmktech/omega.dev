import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  ArtifactId,
  CapabilityEnvelope,
  ComponentId,
  ComponentKind,
  ComponentManifest,
  ComponentRuntime,
  CreateEvolutionService,
  EvolutionError,
  EvolutionJob,
  EvolutionJobId,
  EvolutionRequest,
  EvolutionService,
  HarnessId,
  HarnessManifest,
  JsonObject,
  JsonValue,
  Page,
  PageRequest,
  ProcessError,
  Result,
  SessionError,
  SessionRecord,
  SessionId,
  Timestamp,
} from "../contracts/index.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { atomicWriteFile, ioError, safeStorageKey } from "../persistence/artifact-store.js";
import { readAllEvents } from "../sessions/handoffs.js";
import { createReflectionSkillCandidate } from "./reflection-skills.js";
import { parseReflectionProposal } from "./reflection-proposal.js";
import type { ReflectionProposal } from "./reflection-proposal.js";
import { compileSkillEvalSuite } from "./skill-foundry.js";

const COMPONENT_KINDS: ReadonlySet<string> = new Set([
  "runner", "tool", "connector", "skill", "workflow", "context-compiler", "promotion-evaluator", "policy-prompt",
]);
const COMPONENT_RUNTIMES: ReadonlySet<string> = new Set(["node", "python", "bash", "native", "document"]);
const TERMINAL_STATES: ReadonlySet<EvolutionJob["state"]> = new Set(["promoted", "rejected", "cancelled", "failed"]);
const SINGLETON_COMPONENT_KINDS: ReadonlySet<ComponentKind> = new Set([
  "runner", "context-compiler", "promotion-evaluator", "policy-prompt",
]);

type ComponentDelta = {
  readonly kind: ComponentKind;
  readonly runtime: ComponentRuntime;
  readonly entrypoint: string;
  readonly content: string;
  readonly replaceComponentId: ComponentId | null;
};

type ChildMutation =
  | { readonly kind: "component"; readonly delta: ComponentDelta; readonly artifactId: ArtifactId }
  | { readonly kind: "reflection"; readonly proposal: ReflectionProposal; readonly artifactId: ArtifactId };

function now(): Timestamp {
  return new Date().toISOString() as Timestamp;
}

function validation(message: string, field: string | null): EvolutionError {
  return { kind: "validation", message, field, recoverable: true, callerAction: "fix-request" };
}

function notFound(id: EvolutionJobId): EvolutionError {
  return { kind: "not-found", resource: "evolution-job", id, recoverable: false, callerAction: "propagate" };
}

function capabilityDenied(): EvolutionError {
  return {
    kind: "capability-denied",
    capability: "create-harness-candidate",
    reason: "The evolution child lacks candidate-creation authority.",
    recoverable: true,
    callerAction: "request-new-child",
  };
}

function cancellationError(error: SessionError | ProcessError): EvolutionError {
  switch (error.kind) {
    case "policy-denied":
    case "process-not-running":
    case "process-interrupted":
    case "unsupported":
      return validation(`Evolution child cancellation failed: ${error.kind}.`, "jobId");
    default:
      return error;
  }
}

function pageFrom(items: readonly EvolutionJob[], page: PageRequest): Result<Page<EvolutionJob>, EvolutionError> {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 1_000) {
    return { ok: false, error: validation("Page limit must be an integer between 1 and 1000.", "page.limit") };
  }
  const offset = page.cursor === null ? 0 : Number(page.cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return { ok: false, error: validation("Page cursor is invalid.", "page.cursor") };
  }
  const selected = items.slice(offset, offset + page.limit);
  const nextOffset = offset + selected.length;
  return { ok: true, value: { items: selected, nextCursor: nextOffset < items.length ? String(nextOffset) : null } };
}

function evolutionObjective(request: EvolutionRequest): string {
  const allowedSourceIds = [request.sourceSessionId, ...request.evidenceArtifactIds];
  const canonicalSkillReflection = request.evaluationMode === "synthetic-skill-suite"
    && request.allowedComponentKinds.length === 1
    && request.allowedComponentKinds[0] === "skill";
  const exampleKind = request.allowedComponentKinds[0] ?? "skill";
  const exampleRuntime = exampleKind === "runner" ? "node" : "document";
  const exampleEntrypoint = exampleKind === "runner" ? "runner.js" : "SKILL.md";
  const evidenceInstruction = request.evidenceArtifactIds.length === 0
    ? "No additional evidence artifacts were supplied. The completed source session and the goal above are the complete evidence. Do not call artifact.read or any discovery tool."
    : `Read only these supplied evidence artifacts with artifact.read before proposing a mutation: ${request.evidenceArtifactIds.join(", ")}.`;
  const proposalToolInstruction = request.evidenceArtifactIds.length === 0
    ? "This is a proposal-only child: every tool is unavailable and forbidden. Never call file.write or process.start, and never try to save or validate the component in the workspace; return it directly in the final response."
    : "This is a proposal-only child: after the supplied artifact.read calls, every other tool is unavailable and forbidden. Never call file.write or process.start, and never try to save or validate the component in the workspace; return it directly in the final response.";
  const mutationFormatInstructions = canonicalSkillReflection
    ? [
      "You must return the reflection JSON described below as the entire final response, with no prose or code fence.",
      "Raw component deltas and hand-authored SKILL.md documents are invalid for synthetic skill evolution because they bypass canonical catalog and contract validation.",
    ]
    : [
      "Return the proposed harness mutation as the entire final response in this JSON shape, with no prose or code fence:",
      JSON.stringify({ kind: exampleKind, runtime: exampleRuntime, entrypoint: exampleEntrypoint, content: "...", replaceComponentId: null }),
      `Allowed component kinds: ${request.allowedComponentKinds.join(", ")}.`,
      "Use replaceComponentId to replace an existing component; omit it or use null to add a non-singleton component.",
      "For a runner mutation, content is the complete executable runner artifact, not the TypeScript factory that embeds it.",
      "The content must be complete executable or document content, not a patch or description of the change.",
    ];
  const instructions = [
    request.goal,
    evidenceInstruction,
    "Work under a strict synthesis budget. Inspect only the minimum named incumbent source needed, at most once per file. Do not inspect benchmark implementations, verifier assets, prior scorecards, or broad contracts.",
    proposalToolInstruction,
    "Treat exact signatures, parameter order, identifiers, paths, commands, constants, error codes, and literal values in the goal or evidence as authoritative contracts. Copy them verbatim. Before returning, audit the proposal against every such exact contract; never paraphrase, reorder, generalize, or rename them.",
    "Make the smallest complete mutation that addresses the supplied evidence. Do not repeatedly restate or plan the solution.",
    ...mutationFormatInstructions,
  ];
  if (request.allowedComponentKinds.includes("skill")) {
    instructions.push(
      canonicalSkillReflection
        ? "Reflect before mutating. If the evidence establishes a repeatable procedure, return the reflection JSON shape below; the daemon will atomically compile each skill lesson together with every related knowledge, runner, tool, and policy lesson into a canonical project skill bundle. Choose no-change when the behavior was temporary or unsupported."
        : "When the evidence is a completed project conversation, reflect before mutating. If it establishes a repeatable procedure, you may return the reflection JSON shape below instead of a component delta; the daemon will atomically compile each skill lesson together with every related knowledge, runner, tool, and policy lesson into a canonical project skill bundle. Choose no-change when the behavior was temporary or unsupported.",
      "Use target skill for repeatable or conditional procedures, including project-specific host and environment command corrections. Use target runner only for a project-wide decision rule that must apply to every task without retrieval.",
      JSON.stringify({
        reflection: "short evidence-grounded synthesis",
        decision: "evolve",
        lessons: [{
          sourceIds: [request.sourceSessionId],
          target: "skill",
          title: "short skill title",
          guidance: "complete repeatable project procedure",
          relevantPaths: ["project/relative/path"],
          appliesWhen: ["specific triggering task condition"],
          doesNotApplyWhen: ["specific adjacent task that must not trigger it"],
          observableContracts: [{
            operation: "exact function, route, command, or workflow step",
            inputs: ["accepted inputs and boundary normalization"],
            outputs: ["direct return value or exact response shape"],
            errors: ["thrown error or exact status/body; use 'none' only when evidenced"],
            sideEffects: ["state/process/file effects and their ordering; use 'none' when absent"],
            exactValues: ["verbatim signature, path, command, code, status, or literal"],
          }],
        }],
      }),
      `The completed source session is primary evidence: ${request.sourceSessionId}.`,
      `Reflection sourceIds must cite only these supplied evidence source IDs: ${allowedSourceIds.join(", ")}.`,
      "Keep each lesson's guidance complete and actionable, but no longer than 4096 characters.",
      "Every skill lesson must include one observableContracts entry per learned operation. Every entry must explicitly cover inputs, outputs, errors, sideEffects, and exactValues; write the literal 'none' only when the evidence establishes no behavior in that category. Never collapse direct values into envelopes, thrown errors into returned errors, or exact response bodies into approximate examples.",
      "Return between one and four lessons total. Merge related details into fewer lessons; never return five or more lessons.",
      "Include every related destination supported by the same evidence. The skill-scoped compiler preserves them in one candidate and exposes companion lessons only when the skill is selected.",
    );
  }
  return instructions.join("\n\n");
}

function evolutionChildCapabilities(parent: CapabilityEnvelope, request: EvolutionRequest): CapabilityEnvelope {
  return {
    // Evolution is proposal-only. Its explicit evidence arrives through the
    // goal/handoff and artifact.read, so workspace discovery is both wasteful
    // and a source of benchmark leakage.
    grants: [],
    modelRoles: parent.modelRoles.filter((role) => role === "main-coder" || role === "harness-mutator"),
    maxCostUsdMicros: request.budget.maxCostUsdMicros <= parent.maxCostUsdMicros ? request.budget.maxCostUsdMicros : parent.maxCostUsdMicros,
    maxModelCalls: Math.min(request.budget.maxModelCalls, parent.maxModelCalls),
    maxProcessStarts: 0,
    maxInputTokens: request.budget.maxInputTokens <= parent.maxInputTokens ? request.budget.maxInputTokens : parent.maxInputTokens,
    maxOutputTokens: request.budget.maxOutputTokens <= parent.maxOutputTokens ? request.budget.maxOutputTokens : parent.maxOutputTokens,
    wallTimeMs: request.budget.wallTimeMs <= parent.wallTimeMs ? request.budget.wallTimeMs : parent.wallTimeMs,
    createdAt: now(),
  };
}

function skillEvalObjective(request: EvolutionRequest): string {
  const evidenceInstruction = request.evidenceArtifactIds.length === 0
    ? "No evidence artifacts were supplied. The opportunity text below is the complete evidence available to you. Do not call any tool; return the fixture JSON immediately."
    : "Read only the supplied evidence artifacts with artifact.read. Do not inspect benchmark implementations, prior scorecards, evaluation results, or any proposed harness mutation.";
  return [
    "Independently design a hidden synthetic evaluation for the reusable behavior revealed by the supplied evidence.",
    evidenceInstruction,
    "Return exactly one JSON object with a fixtures array and no prose or code fence.",
    "The array must contain exactly one fixture for each variation: near-transfer, generalization, and negative-control.",
    "Near-transfer should replay the same durable behavior with changed names or values. Generalization should require the underlying procedure in a meaningfully different case. Negative-control must match at least one explicit doesNotApplyWhen cue from the opportunity and request none of the positive learned contracts; it is an adjacent task where the skill must not trigger.",
    "This synthetic suite isolates one learned procedure; full-workspace replay separately validates the complete project. Each fixture must cover one focused change, use at most three starting files, contain at most six baseline checks, and must not request a complete application or unrelated architectural layers.",
    "Each fixture shape is {variation,title,objective,files,checks,verifier,invariants}. files MUST be a JSON object mapping safe relative path keys directly to string contents, never an array; for example {\"src/index.js\":\"// starting content\\n\"}. files contains only the small STARTING workspace inputs visible before the task; never put a reference solution, expected output, completed test suite, or any file that solves the objective in files. checks are non-authoritative static diagnostics only; they may describe starting markers or expected source hints but never establish baseline state or success. Put baseline content that must remain true in invariants. The untouched starting files must satisfy every invariant. checks and invariants are non-empty arrays. Every static assertion uses exactly one operator: {path,equals:string}, {path,contains:string}, {path,notContains:string}, or {path,absent:true}.",
    "verifier is the authoritative hidden behavioral test: {files:{\"verify.mjs\":\"...\"},command:{executable:\"node\",args:[\"verify.mjs\"]}}. Its files are injected only after the task runner finishes. The completed workspace snapshot is mirrored into the private verifier directory, and its command runs there offline and read-only. Use runtime-native assertions and import task files from the snapshot with workspace-relative paths such as ./src/module.js. Verifier files must not replace task files. Exit zero only when observable inputs, outputs, thrown errors, side effects, and exact wire values satisfy the opportunity. Equivalent implementations must pass; comments or matching source substrings with wrong behavior must fail. For every no-mutation or state-preservation claim, capture the relevant state immediately before the operation and compare the after-state with that snapshot; never assert a hardcoded collection length. Do not inspect source spelling when behavior is executable. Use only language/runtime built-ins and never install dependencies.",
    "Static checks are diagnostics only. Never use them as a proxy for baseline state or final behavior, or infer that a token belongs in a particular file merely because both token and path appear in the opportunity. Preserve learned module responsibilities and verify externally visible behavior in the executable verifier.",
    "Keep fixtures tiny, isolated, offline, deterministic, and free of secrets. Hide the checks and invariants from the task-solving runner.",
    `Opportunity: ${request.goal}`,
    `Evidence artifact IDs: ${request.evidenceArtifactIds.join(", ") || "none"}.`,
  ].join("\n\n");
}

function skillEvalChildCapabilities(parent: CapabilityEnvelope, request: EvolutionRequest): CapabilityEnvelope {
  return {
    grants: [],
    modelRoles: parent.modelRoles.filter((role) => role === "promotion-evaluator"),
    maxCostUsdMicros: request.budget.maxCostUsdMicros <= parent.maxCostUsdMicros ? request.budget.maxCostUsdMicros : parent.maxCostUsdMicros,
    maxModelCalls: Math.min(request.budget.maxModelCalls, parent.maxModelCalls),
    maxProcessStarts: 0,
    maxInputTokens: request.budget.maxInputTokens <= parent.maxInputTokens ? request.budget.maxInputTokens : parent.maxInputTokens,
    maxOutputTokens: request.budget.maxOutputTokens <= parent.maxOutputTokens ? request.budget.maxOutputTokens : parent.maxOutputTokens,
    wallTimeMs: request.budget.wallTimeMs <= parent.wallTimeMs ? request.budget.wallTimeMs : parent.wallTimeMs,
    createdAt: now(),
  };
}

function skillEvalRepairObjective(request: EvolutionRequest, proposal: string, error: EvolutionError): string {
  return [
    "Repair your previous synthetic fixture proposal after static validation. This is fixture-authoring feedback only; no candidate, benchmark execution, score, or promotion result exists or is disclosed.",
    "This is a one-turn proposal-only correction. Do not call any tool; return the corrected fixture JSON immediately.",
    "Return exactly one corrected JSON object with a fixtures array and no prose or code fence. Preserve the required near-transfer, generalization, and negative-control meanings from the opportunity.",
    "Every fixture's files MUST be a JSON object mapping safe relative path keys directly to string contents, never an array. Static checks are diagnostics and do not need a particular baseline truth value. Every invariant must be true. Every fixture must include verifier:{files,command}; the completed workspace is mirrored into the private verifier directory, so import task files as ./src/module.js (or the corresponding workspace-relative path), and never replace a task file from verifier.files. It must execute observable behavior with runtime-native assertions, accept equivalent implementations, and reject comments or matching source text with wrong behavior. For every no-mutation or state-preservation claim, capture the relevant state immediately before the operation and compare the after-state with that snapshot; never assert a hardcoded collection length. Negative-control must match an explicit doesNotApplyWhen cue and request none of the positive learned contracts.",
    `Validation error: ${JSON.stringify(error)}`,
    `Opportunity: ${request.goal}`,
    `Previous proposal:\n${proposal}`,
  ].join("\n\n");
}

function reflectionRepairObjective(request: EvolutionRequest, proposal: string, error: EvolutionError): string {
  return [
    "Repair your previous reflection proposal after deterministic schema and retrieval validation. No benchmark result, score, candidate behavior, or promotion outcome exists or is disclosed.",
    "This is one bounded proposal-only correction. Do not call any tool. Return exactly one corrected reflection JSON object and no prose or code fence. Raw component deltas and SKILL.md content are invalid.",
    "Preserve every evidence-supported observable contract and source ID. decision must be evolve or no-change. For evolve, lessons must contain one to four items with target, title, guidance, relevantPaths, appliesWhen, doesNotApplyWhen, and observableContracts.",
    "For every skill lesson, each observable contract must have a distinct behaviorally portable appliesWhen cue containing that operation and an exact signature, status, error, input, output, or side-effect value. Negative cues must describe behavioral boundaries, preserve negation polarity, and must not exclude renamed projects, services, repositories, or domain nouns.",
    "Every observable contract must explicitly include non-empty operation, inputs, outputs, errors, sideEffects, and exactValues arrays. Use the literal 'none' only when the evidence establishes absence.",
    `Allowed evidence source IDs: ${[request.sourceSessionId, ...request.evidenceArtifactIds].join(", ")}`,
    `Validation error: ${JSON.stringify(error)}`,
    `Opportunity: ${request.goal}`,
    `Previous proposal:\n${proposal}`,
  ].join("\n\n");
}

function reflectionRepairChildCapabilities(parent: CapabilityEnvelope, request: EvolutionRequest): CapabilityEnvelope {
  return {
    ...evolutionChildCapabilities(parent, request),
    maxModelCalls: 1,
    maxProcessStarts: 0,
    createdAt: now(),
  };
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

function componentBody(component: Omit<ComponentManifest, "id">): JsonObject {
  return {
    kind: component.kind,
    runtime: component.runtime,
    objectHash: component.objectHash,
    entrypoint: component.entrypoint,
    credentialEnvNames: [...component.credentialEnvNames],
    capabilities: [...component.capabilities],
  };
}

function harnessBody(manifest: Omit<HarnessManifest, "id">): JsonObject {
  return {
    projectId: manifest.projectId,
    alias: manifest.alias,
    parents: [...manifest.parents],
    components: manifest.components.map((component) => ({ id: component.id, ...componentBody(component) })),
    sourceArtifacts: [...manifest.sourceArtifacts],
    createdAt: manifest.createdAt,
  };
}

function mediaType(runtime: ComponentRuntime): string {
  switch (runtime) {
    case "node": return "text/javascript";
    case "python": return "text/x-python";
    case "bash": return "text/x-shellscript";
    case "document": return "text/markdown";
    case "native": return "application/octet-stream";
  }
}

function isSafeEntrypoint(entrypoint: string): boolean {
  if (entrypoint.trim() !== entrypoint || entrypoint.length === 0 || entrypoint.startsWith("/") || entrypoint.includes("\\")) {
    return false;
  }
  return entrypoint.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
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

function parseDelta(text: string, allowedKinds: readonly ComponentKind[]): Result<ComponentDelta, EvolutionError> {
  let source = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(source);
  if (fenced?.[1] !== undefined) source = fenced[1].trim();
  let value: unknown;
  let parsed = false;
  for (const candidate of [source, ...embeddedJsonObjects(source)]) {
    try {
      value = JSON.parse(candidate);
      parsed = true;
      break;
    } catch {
      // Models occasionally prefix the required object with a short explanation.
    }
  }
  if (!parsed) {
    return { ok: false, error: validation("Evolution child output must be one JSON component delta.", "childOutput") };
  }
  if (!isRecord(value) || typeof value["kind"] !== "string" || typeof value["runtime"] !== "string"
    || typeof value["entrypoint"] !== "string" || typeof value["content"] !== "string"
    || (value["replaceComponentId"] !== undefined && value["replaceComponentId"] !== null
      && typeof value["replaceComponentId"] !== "string")) {
    return { ok: false, error: validation("Evolution child output has an invalid component delta shape.", "childOutput") };
  }
  if (!COMPONENT_KINDS.has(value["kind"]) || !allowedKinds.includes(value["kind"] as ComponentKind)) {
    return { ok: false, error: validation("Evolution child selected a component kind outside its mutation envelope.", "childOutput.kind") };
  }
  if (!COMPONENT_RUNTIMES.has(value["runtime"])) {
    return { ok: false, error: validation("Evolution child selected an unsupported component runtime.", "childOutput.runtime") };
  }
  if (!isSafeEntrypoint(value["entrypoint"])) {
    return { ok: false, error: validation("Evolution component entrypoint must be a normalized relative path.", "childOutput.entrypoint") };
  }
  if (value["content"].trim().length === 0) {
    return { ok: false, error: validation("Evolution component content cannot be empty.", "childOutput.content") };
  }
  return {
    ok: true,
    value: {
      kind: value["kind"] as ComponentKind,
      runtime: value["runtime"] as ComponentRuntime,
      entrypoint: value["entrypoint"],
      content: value["content"],
      replaceComponentId: (value["replaceComponentId"] ?? null) as ComponentId | null,
    },
  };
}

export const createEvolutionService: CreateEvolutionService = (options): EvolutionService => {
  const jobs = new Map<EvolutionJobId, EvolutionJob>();
  const controls = new Map<EvolutionJobId, { readonly controller: AbortController; readonly completion: Promise<void> }>();
  const writes = new Map<EvolutionJobId, Promise<void>>();
  const loaded = loadPersistedJobs(String(options.root), jobs);

  async function ensureLoaded(): Promise<Result<void, EvolutionError>> {
    try {
      await loaded;
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: ioError("load-evolution-jobs", error) };
    }
  }

  async function store(job: EvolutionJob): Promise<Result<EvolutionJob, EvolutionError>> {
    const previous = writes.get(job.id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      await persistJob(String(options.root), job);
      jobs.set(job.id, job);
    });
    writes.set(job.id, current);
    try {
      await current;
      return { ok: true, value: job };
    } catch (error) {
      return { ok: false, error: ioError("persist-evolution-job", error) };
    } finally {
      if (writes.get(job.id) === current) writes.delete(job.id);
    }
  }

  async function update(
    job: EvolutionJob,
    patch: Partial<Pick<EvolutionJob, "candidateHarnessId" | "scorecardId" | "failure" | "state" | "suiteId" | "sessionId" | "childId" | "evaluationSessionId" | "evaluationChildId">>,
  ): Promise<Result<EvolutionJob, EvolutionError>> {
    return store({ ...job, ...patch, updatedAt: now() });
  }

  function isCancelled(id: EvolutionJobId): boolean {
    return jobs.get(id)?.state === "cancelled";
  }

  function schedule(job: EvolutionJob): void {
    const controller = new AbortController();
    const finished = Promise.withResolvers<void>();
    controls.set(job.id, { controller, completion: finished.promise });
    queueMicrotask(() => {
      void execute(job.id, controller.signal).finally(() => {
        finished.resolve();
        controls.delete(job.id);
      });
    });
  }

  async function finishFailed(id: EvolutionJobId, failure: EvolutionError): Promise<void> {
    const job = jobs.get(id);
    if (job === undefined || job.state === "cancelled") return;
    await update(job, { state: "failed", failure });
    if (job.evaluationSessionId !== undefined && job.evaluationSessionId !== null) {
      const evaluator = await options.repository.get(job.evaluationSessionId);
      if (evaluator.ok && evaluator.value.outcome === null) {
        await options.sessions.cancel(job.evaluationSessionId, "Evolution job failed");
      }
    }
    await options.sessions.complete(job.sessionId, "failed");
  }

  async function waitForSession(
    job: EvolutionJob,
    sessionId: SessionId,
    label: string,
    signal: AbortSignal,
  ): Promise<Result<SessionRecord, EvolutionError>> {
    const deadline = Date.now() + Number(job.request.budget.wallTimeMs);
    while (!signal.aborted) {
      const child = await options.repository.get(sessionId);
      if (!child.ok) return child;
      if (child.value.outcome !== null) {
        return child.value.outcome === "succeeded"
          ? { ok: true, value: child.value }
          : { ok: false, error: validation(`${label} child ended with ${child.value.outcome}.`, "childSession") };
      }
      if (Date.now() >= deadline) {
        return { ok: false, error: validation(`${label} child exceeded its wall-time budget.`, "budget.wallTimeMs") };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
    return { ok: false, error: validation("Evolution was cancelled.", "signal") };
  }

  async function childOutput(
    sessionId: SessionId,
    label: string,
  ): Promise<Result<{ readonly text: string; readonly artifactId: ArtifactId }, EvolutionError>> {
    const events = await readAllEvents(options.repository, sessionId);
    if (!events.ok) return events;
    for (let index = events.value.length - 1; index >= 0; index -= 1) {
      const event = events.value[index];
      if (event?.payload.kind !== "model.completed") continue;
      const payload = event.payload;
      const artifact = events.value.find((candidate) => candidate.payload.kind === "artifact.recorded"
        && candidate.payload.artifact.id === payload.aggregateArtifactId
        && candidate.payload.artifact.kind === "model-response");
      if (artifact === undefined) continue;
      return {
        ok: true,
        value: {
          text: payload.completion.content.filter((part) => part.kind === "text").map((part) => part.text).join(""),
          artifactId: payload.aggregateArtifactId,
        },
      };
    }
    return { ok: false, error: validation(`${label} child produced no recorded model response.`, "childOutput") };
  }

  async function childMutation(job: EvolutionJob): Promise<Result<ChildMutation, EvolutionError>> {
    const output = await childOutput(job.sessionId, "Evolution");
    if (!output.ok) return output;
    if (job.request.allowedComponentKinds.includes("skill")) {
      const allowedSourceIds = [job.request.sourceSessionId, ...job.request.evidenceArtifactIds];
      const reflection = parseReflectionProposal(output.value.text, allowedSourceIds, job.request.sourceSessionId);
      if (reflection.ok) {
        return {
          ok: true,
          value: { kind: "reflection", proposal: reflection.value, artifactId: output.value.artifactId },
        };
      }
      if (job.request.evaluationMode === "synthetic-skill-suite"
        && job.request.allowedComponentKinds.length === 1
        && job.request.allowedComponentKinds[0] === "skill") {
        return reflection;
      }
    }
    const parsed = parseDelta(output.value.text, job.request.allowedComponentKinds);
    return parsed.ok
      ? { ok: true, value: { kind: "component", delta: parsed.value, artifactId: output.value.artifactId } }
      : parsed;
  }

  async function mutate(
    incumbent: HarnessManifest,
    job: EvolutionJob,
  ): Promise<Result<HarnessManifest | null, EvolutionError>> {
    const proposed = await childMutation(job);
    if (!proposed.ok) return proposed;
    if (proposed.value.kind === "reflection") {
      if (proposed.value.proposal.decision === "no-change") return { ok: true, value: null };
      return createReflectionSkillCandidate({
        incumbent,
        proposal: proposed.value.proposal,
        sourceSessionId: job.request.sourceSessionId,
        evidenceArtifactIds: job.request.evidenceArtifactIds,
        proposalArtifactId: proposed.value.artifactId,
        alias: `candidate-${String(job.id).slice(0, 12)}`,
        createdAt: now(),
      }, options.objects, options.harnesses);
    }
    const delta = proposed.value.delta;
    let replaceIndex = delta.replaceComponentId === null
      ? -1
      : incumbent.components.findIndex((component) => component.id === delta.replaceComponentId);
    if (delta.replaceComponentId !== null && replaceIndex < 0) {
      return { ok: false, error: validation("Evolution replacement component does not exist in the incumbent.", "childOutput.replaceComponentId") };
    }
    if (replaceIndex < 0 && SINGLETON_COMPONENT_KINDS.has(delta.kind)) {
      replaceIndex = incumbent.components.findIndex((component) => component.kind === delta.kind);
    }
    const replaced = replaceIndex < 0 ? null : incumbent.components[replaceIndex] ?? null;
    if (replaced !== null && replaced.kind !== delta.kind) {
      return { ok: false, error: validation("Evolution replacement must preserve the component kind.", "childOutput.replaceComponentId") };
    }

    const bytes = Buffer.from(delta.content, "utf8");
    const object = await options.objects.put(mediaType(delta.runtime), (async function* (): AsyncIterable<Uint8Array> {
      yield bytes;
    })());
    if (!object.ok) return object;
    const body: Omit<ComponentManifest, "id"> = {
      kind: delta.kind,
      runtime: delta.runtime,
      objectHash: object.value.hash,
      entrypoint: delta.kind === "runner" && delta.runtime !== "native"
        ? `inline-base64:${bytes.toString("base64")}`
        : delta.entrypoint,
      credentialEnvNames: replaced?.credentialEnvNames ?? [],
      capabilities: replaced?.capabilities ?? [],
    };
    const component: ComponentManifest = {
      id: `component_${hash(canonical(componentBody(body)))}` as ComponentId,
      ...body,
    };
    if (replaced !== null && component.id === replaced.id) {
      return { ok: false, error: validation("Evolution child proposed an unchanged component.", "childOutput") };
    }
    if (incumbent.components.some((candidate) => candidate.id === component.id)) {
      return { ok: false, error: validation("Evolution child proposed a component already present in the incumbent.", "childOutput") };
    }
    const storedComponent = await options.harnesses.putComponent(component);
    if (!storedComponent.ok) return storedComponent;
    const components = [...incumbent.components];
    if (replaceIndex < 0) components.push(storedComponent.value);
    else components.splice(replaceIndex, 1, storedComponent.value);
    if (components.map((item) => item.id).join("\n") === incumbent.components.map((item) => item.id).join("\n")) {
      return { ok: false, error: validation("Evolution mutation did not change the harness component set.", "childOutput") };
    }

    const createdAt = now();
    const candidateBody: Omit<HarnessManifest, "id"> = {
      projectId: incumbent.projectId,
      alias: `candidate-${String(job.id).slice(0, 12)}`,
      parents: [incumbent.id],
      components,
      sourceArtifacts: [...new Set([
        ...incumbent.sourceArtifacts,
        ...job.request.evidenceArtifactIds,
        proposed.value.artifactId,
      ])],
      createdAt,
    };
    const candidate: HarnessManifest = {
      id: `harness_${hash(canonical(harnessBody(candidateBody)))}` as HarnessId,
      ...candidateBody,
    };
    return options.harnesses.putHarness(candidate);
  }

  async function execute(id: EvolutionJobId, signal: AbortSignal): Promise<void> {
    const queued = jobs.get(id);
    if (queued === undefined || queued.state === "cancelled") return;
    const diagnosingResult = await update(queued, { state: "diagnosing" });
    if (!diagnosingResult.ok) return;
    const diagnosing = diagnosingResult.value;
    if (signal.aborted || isCancelled(id)) return;
    const incumbent = await options.harnesses.getHarness(diagnosing.incumbentHarnessId);
    if (!incumbent.ok) {
      await finishFailed(id, incumbent.error);
      return;
    }
    const child = await waitForSession(diagnosing, diagnosing.sessionId, "Evolution", signal);
    if (!child.ok || isCancelled(id)) {
      if (!isCancelled(id)) await finishFailed(id, child.ok ? validation("Evolution was cancelled.", "signal") : child.error);
      return;
    }
    const synthetic = diagnosing.request.evaluationMode === "synthetic-skill-suite";
    if (synthetic) {
      if (diagnosing.evaluationSessionId === undefined || diagnosing.evaluationSessionId === null) {
        await finishFailed(id, validation("Synthetic evolution is missing its evaluation child.", "evaluationSessionId"));
        return;
      }
      const evaluator = await waitForSession(diagnosing, diagnosing.evaluationSessionId, "Evaluation", signal);
      if (!evaluator.ok || isCancelled(id)) {
        if (!isCancelled(id)) await finishFailed(id, evaluator.ok ? validation("Evolution was cancelled.", "signal") : evaluator.error);
        return;
      }
    }

    const mutatingResult = await update(jobs.get(id) ?? diagnosing, { state: "mutating" });
    if (!mutatingResult.ok) return;
    let mutationJob = mutatingResult.value;
    let mutated = await mutate(incumbent.value, mutationJob);
    const canonicalSkillReflection = synthetic
      && diagnosing.request.allowedComponentKinds.length === 1
      && diagnosing.request.allowedComponentKinds[0] === "skill";
    if (!mutated.ok && canonicalSkillReflection && !isCancelled(id)) {
      const previous = await childOutput(mutationJob.sessionId, "Evolution");
      const source = await options.repository.get(diagnosing.request.sourceSessionId);
      if (previous.ok && source.ok) {
        const repair = await options.sessions.spawnChild({
          parentSessionId: diagnosing.request.sourceSessionId,
          role: "evolution",
          objective: reflectionRepairObjective(diagnosing.request, previous.value.text, mutated.error),
          contextArtifactIds: diagnosing.request.evidenceArtifactIds,
          capabilityEnvelope: reflectionRepairChildCapabilities(source.value.header.capabilityEnvelope, diagnosing.request),
        });
        if (repair.ok) {
          const repairedSession = await waitForSession(mutationJob, repair.value.sessionId, "Evolution repair", signal);
          if (repairedSession.ok && !isCancelled(id)) {
            const repairedJob = await update(jobs.get(id) ?? mutationJob, {
              sessionId: repair.value.sessionId,
              childId: repair.value.childId,
            });
            if (!repairedJob.ok) return;
            mutationJob = repairedJob.value;
            mutated = await mutate(incumbent.value, mutationJob);
          }
        }
      }
    }
    if (!mutated.ok) {
      await finishFailed(id, mutated.error);
      return;
    }
    if (mutated.value === null) {
      await update(jobs.get(id) ?? mutatingResult.value, { state: "rejected" });
      return;
    }
    if (isCancelled(id)) return;

    let suite = null;
    if (synthetic) {
      const evaluationSessionId = diagnosing.evaluationSessionId;
      if (evaluationSessionId === undefined || evaluationSessionId === null) {
        await finishFailed(id, validation("Synthetic evolution is missing its evaluation child.", "evaluationSessionId"));
        return;
      }
      const output = await childOutput(evaluationSessionId, "Evaluation");
      if (!output.ok) {
        await finishFailed(id, output.error);
        return;
      }
      const compileInput = {
        projectId: diagnosing.request.projectId,
        sourceSessionId: diagnosing.request.sourceSessionId,
        evidenceArtifactIds: diagnosing.request.evidenceArtifactIds,
        proposalArtifactId: output.value.artifactId,
        budget: options.syntheticSkillTaskBudget ?? DEFAULT_CONFIG.benchmarks.syntheticSkillTaskBudget,
        createdAt: now(),
      } as const;
      let compiled = await compileSkillEvalSuite(output.value.text, compileInput, options.objects);
      if (!compiled.ok) {
        const source = await options.repository.get(diagnosing.request.sourceSessionId);
        if (!source.ok) {
          await finishFailed(id, source.error);
          return;
        }
        let previousText = output.value.text;
        for (let repairAttempt = 1; repairAttempt <= 3 && !compiled.ok; repairAttempt += 1) {
          const repair = await options.sessions.spawnChild({
            parentSessionId: diagnosing.request.sourceSessionId,
            role: "promotion-eval",
            objective: skillEvalRepairObjective(diagnosing.request, previousText, compiled.error),
            contextArtifactIds: diagnosing.request.evidenceArtifactIds,
            capabilityEnvelope: skillEvalChildCapabilities(source.value.header.capabilityEnvelope, diagnosing.request),
          });
          if (!repair.ok) {
            await finishFailed(id, repair.error);
            return;
          }
          const repairedSession = await waitForSession(jobs.get(id) ?? mutatingResult.value, repair.value.sessionId, `Evaluation repair ${repairAttempt}`, signal);
          if (!repairedSession.ok || isCancelled(id)) {
            if (!isCancelled(id)) await finishFailed(id, repairedSession.ok ? validation("Evolution was cancelled.", "signal") : repairedSession.error);
            return;
          }
          const repairJob = await update(jobs.get(id) ?? mutatingResult.value, {
            evaluationSessionId: repair.value.sessionId,
            evaluationChildId: repair.value.childId,
          });
          if (!repairJob.ok) return;
          const repairedOutput = await childOutput(repair.value.sessionId, `Evaluation repair ${repairAttempt}`);
          if (!repairedOutput.ok) {
            await finishFailed(id, repairedOutput.error);
            return;
          }
          previousText = repairedOutput.value.text;
          compiled = await compileSkillEvalSuite(previousText, {
            ...compileInput,
            proposalArtifactId: repairedOutput.value.artifactId,
            createdAt: now(),
          }, options.objects);
        }
      }
      if (!compiled.ok) {
        await finishFailed(id, compiled.error);
        return;
      }
      suite = compiled.value;
    }
    const evaluatingResult = await update(jobs.get(id) ?? mutatingResult.value, {
      state: "evaluating",
      candidateHarnessId: mutated.value.id,
      suiteId: suite?.manifest.id ?? null,
    });
    if (!evaluatingResult.ok) return;
    const evaluating = evaluatingResult.value;
    const scorecard = suite === null
      ? await options.benchmarks.runPaired(
        DEFAULT_CONFIG.benchmarks.developmentSuiteId,
        evaluating.incumbentHarnessId,
        mutated.value.id,
        signal,
      )
      : await options.benchmarks.runSkillPaired(
        suite,
        evaluating.incumbentHarnessId,
        mutated.value.id,
        signal,
      );
    if (!scorecard.ok) {
      if (!isCancelled(id)) await finishFailed(id, scorecard.error);
      return;
    }
    if (isCancelled(id)) return;

    const terminalState = scorecard.value.decision.outcome === "promote" ? "promoted" : "rejected";
    await update(jobs.get(id) ?? evaluating, { state: terminalState, scorecardId: scorecard.value.id });
  }

  async function start(
    request: EvolutionRequest,
    capabilities: CapabilityEnvelope,
  ): Promise<Result<EvolutionJob, EvolutionError>> {
    const ready = await ensureLoaded();
    if (!ready.ok) return ready;
    if (request.goal.trim().length === 0) return { ok: false, error: validation("Evolution goal cannot be empty.", "goal") };
    if (request.allowedComponentKinds.length === 0) {
      return { ok: false, error: validation("At least one mutable component kind is required.", "allowedComponentKinds") };
    }
    const synthetic = request.evaluationMode === "synthetic-skill-suite";
    if (synthetic && (request.allowedComponentKinds.length !== 1 || request.allowedComponentKinds[0] !== "skill")) {
      return { ok: false, error: validation("Synthetic skill evaluation is only valid for a skill-only mutation.", "evaluationMode") };
    }
    if (!capabilities.grants.some((grant) => grant.kind === "create-harness-candidate")) {
      return { ok: false, error: capabilityDenied() };
    }

    const incumbent = await options.harnesses.getActiveHarness(request.projectId);
    if (!incumbent.ok) return incumbent;
    const child = await options.sessions.spawnChild({
      parentSessionId: request.sourceSessionId,
      role: "evolution",
      objective: evolutionObjective(request),
      contextArtifactIds: request.evidenceArtifactIds,
      capabilityEnvelope: evolutionChildCapabilities(capabilities, request),
    });
    if (!child.ok) return child;
    const evaluator = synthetic ? await options.sessions.spawnChild({
      parentSessionId: request.sourceSessionId,
      role: "promotion-eval",
      objective: skillEvalObjective(request),
      contextArtifactIds: request.evidenceArtifactIds,
      capabilityEnvelope: skillEvalChildCapabilities(capabilities, request),
    }) : null;
    if (evaluator !== null && !evaluator.ok) {
      await options.sessions.cancel(child.value.sessionId, "Synthetic skill evaluator could not be started");
      return evaluator;
    }

    const createdAt = now();
    const job: EvolutionJob = {
      id: randomUUID() as EvolutionJobId,
      request,
      incumbentHarnessId: incumbent.value.id,
      sessionId: child.value.sessionId,
      childId: child.value.childId,
      evaluationSessionId: evaluator?.ok === true ? evaluator.value.sessionId : null,
      evaluationChildId: evaluator?.ok === true ? evaluator.value.childId : null,
      suiteId: null,
      candidateHarnessId: null,
      scorecardId: null,
      failure: null,
      state: "queued",
      createdAt,
      updatedAt: createdAt,
    };
    const persisted = await store(job);
    if (!persisted.ok) return persisted;
    schedule(job);
    return { ok: true, value: job };
  }

  async function retry(id: EvolutionJobId): Promise<Result<EvolutionJob, EvolutionError>> {
    const ready = await ensureLoaded();
    if (!ready.ok) return ready;
    const job = jobs.get(id);
    if (job === undefined) return { ok: false, error: notFound(id) };
    if (job.state !== "failed" && job.state !== "cancelled") {
      return { ok: false, error: validation("Only a failed or cancelled evolution job can be retried.", "jobId") };
    }
    const child = await options.repository.get(job.sessionId);
    if (!child.ok) return child;
    if (child.value.outcome !== "succeeded") {
      return { ok: false, error: validation("Evolution retry requires a succeeded proposal child.", "jobId") };
    }
    if (job.evaluationSessionId !== undefined && job.evaluationSessionId !== null) {
      const evaluator = await options.repository.get(job.evaluationSessionId);
      if (!evaluator.ok) return evaluator;
      if (evaluator.value.outcome !== "succeeded") {
        return { ok: false, error: validation("Evolution retry requires a succeeded evaluation child.", "jobId") };
      }
    }
    const queued = await store({ ...job, state: "queued", candidateHarnessId: null, scorecardId: null, failure: null, suiteId: null, updatedAt: now() });
    if (!queued.ok) return queued;
    schedule(queued.value);
    return queued;
  }

  async function get(id: EvolutionJobId): Promise<Result<EvolutionJob, EvolutionError>> {
    const ready = await ensureLoaded();
    if (!ready.ok) return ready;
    const job = jobs.get(id);
    return job === undefined ? { ok: false, error: notFound(id) } : { ok: true, value: job };
  }

  async function list(projectId: EvolutionRequest["projectId"], page: PageRequest): Promise<Result<Page<EvolutionJob>, EvolutionError>> {
    const ready = await ensureLoaded();
    if (!ready.ok) return ready;
    const matches = [...jobs.values()]
      .filter((job) => job.request.projectId === projectId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return pageFrom(matches, page);
  }

  async function cancel(id: EvolutionJobId, reason: string): Promise<Result<EvolutionJob, EvolutionError>> {
    const ready = await ensureLoaded();
    if (!ready.ok) return ready;
    const job = jobs.get(id);
    if (job === undefined) return { ok: false, error: notFound(id) };
    if (TERMINAL_STATES.has(job.state)) return { ok: true, value: job };
    const control = controls.get(id);
    control?.controller.abort(reason);
    const cancelledResult = await update(job, { state: "cancelled" });
    if (!cancelledResult.ok) return cancelledResult;
    const sessionCancellations = [options.sessions.cancel(job.sessionId, reason)];
    if (job.evaluationSessionId !== undefined && job.evaluationSessionId !== null) {
      sessionCancellations.push(options.sessions.cancel(job.evaluationSessionId, reason));
    }
    if (control !== undefined) {
      await Promise.race([
        control.completion,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    const sessions = await Promise.all(sessionCancellations);
    const failed = sessions.find((session) => !session.ok);
    if (failed === undefined || failed.ok) return cancelledResult;
    return { ok: false, error: cancellationError(failed.error) };
  }

  return { start, retry, get, list, cancel };
};

async function persistJob(root: string, job: EvolutionJob): Promise<void> {
  const path = join(root, "evolution", "jobs", `${safeStorageKey(job.id)}.json`);
  await atomicWriteFile(path, `${JSON.stringify(job)}\n`);
}

async function loadPersistedJobs(root: string, jobs: Map<EvolutionJobId, EvolutionJob>): Promise<void> {
  const directory = join(root, "evolution", "jobs");
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json"))) {
    const value: unknown = JSON.parse(await readFile(join(directory, entry.name), "utf8"));
    if (!isEvolutionJob(value)) throw new Error(`Stored evolution job ${entry.name} is malformed`);
    if (TERMINAL_STATES.has(value.state)) {
      jobs.set(value.id, value);
      continue;
    }
    const failed: EvolutionJob = { ...value, state: "failed", updatedAt: now() };
    jobs.set(failed.id, failed);
    await persistJob(root, failed);
  }
}

function isEvolutionJob(value: unknown): value is EvolutionJob {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["incumbentHarnessId"] !== "string"
    || typeof value["sessionId"] !== "string" || typeof value["childId"] !== "string"
    || (value["evaluationSessionId"] !== undefined && value["evaluationSessionId"] !== null && typeof value["evaluationSessionId"] !== "string")
    || (value["evaluationChildId"] !== undefined && value["evaluationChildId"] !== null && typeof value["evaluationChildId"] !== "string")
    || (value["suiteId"] !== undefined && value["suiteId"] !== null && typeof value["suiteId"] !== "string")
    || (value["candidateHarnessId"] !== null && typeof value["candidateHarnessId"] !== "string")
    || (value["scorecardId"] !== null && typeof value["scorecardId"] !== "string")
    || (value["failure"] !== undefined && value["failure"] !== null
      && (!isRecord(value["failure"]) || typeof value["failure"]["kind"] !== "string"
        || typeof value["failure"]["recoverable"] !== "boolean" || typeof value["failure"]["callerAction"] !== "string"))
    || typeof value["state"] !== "string" || !TERMINAL_STATES.has(value["state"] as EvolutionJob["state"])
      && !["queued", "diagnosing", "mutating", "evaluating"].includes(value["state"])
    || typeof value["createdAt"] !== "string" || typeof value["updatedAt"] !== "string" || !isRecord(value["request"])) {
    return false;
  }
  const request = value["request"];
  return typeof request["projectId"] === "string" && typeof request["sourceSessionId"] === "string"
    && typeof request["goal"] === "string" && Array.isArray(request["evidenceArtifactIds"])
    && request["evidenceArtifactIds"].every((item) => typeof item === "string")
    && Array.isArray(request["allowedComponentKinds"])
    && request["allowedComponentKinds"].every((item) => typeof item === "string" && COMPONENT_KINDS.has(item))
    && (request["evaluationMode"] === undefined || request["evaluationMode"] === "development-suite"
      || request["evaluationMode"] === "synthetic-skill-suite")
    && isRecord(request["budget"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
