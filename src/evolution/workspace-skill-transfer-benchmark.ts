import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

export type WorkspaceSkillScenario = {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly skillRelevant: boolean;
  /** Evaluator-only values are never rendered into model messages. */
  readonly expected: {
    readonly config: string;
    readonly runtime: string;
    readonly documentation: string;
  };
};

export type WorkspaceSkillScore = {
  readonly workspacePassed: boolean;
  readonly retrievalCorrect: boolean;
  readonly closedLoopPassed: boolean;
  readonly checks: Readonly<Record<string, boolean>>;
};

export type WorkspaceSkillRun = {
  readonly scenarioId: string;
  readonly replicate: number;
  readonly order: number;
  readonly condition: "incumbent" | "candidate";
  readonly sessionId: SessionId;
  readonly harnessId: HarnessId;
  readonly route: ModelRouteSignature;
  readonly providerGenerationIds: readonly (string | null)[];
  readonly usage: ModelUsage;
  readonly modelTurns: number;
  readonly providerRetries: number;
  readonly toolCalls: number;
  readonly skillReadComponentIds: readonly ComponentId[];
  readonly fileReads: readonly string[];
  readonly fileWrites: readonly string[];
  readonly processCalls: readonly string[];
  readonly toolErrors: readonly string[];
  readonly completedNaturally: boolean;
  readonly response: string;
  readonly finalFiles: Readonly<Record<string, string>>;
  readonly score: WorkspaceSkillScore;
};

export type WorkspaceSkillPair = {
  readonly scenarioId: string;
  readonly replicate: number;
  readonly incumbent: WorkspaceSkillRun;
  readonly candidate: WorkspaceSkillRun;
  readonly comparable: boolean;
  readonly invalidReason: string | null;
  readonly workspaceDelta: -1 | 0 | 1;
  readonly closedLoopDelta: -1 | 0 | 1;
};

export const WORKSPACE_EFFICIENCY_THRESHOLDS = {
  minimumCostReduction: 0.10,
  minimumToolCallReduction: 0.20,
} as const;

export function assessWorkspaceEfficiency(input: {
  readonly incumbentCostUsdMicros: number;
  readonly candidateCostUsdMicros: number;
  readonly incumbentToolCalls: number;
  readonly candidateToolCalls: number;
}): { readonly costReduction: number; readonly toolCallReduction: number; readonly effectMet: boolean } {
  const costReduction = input.incumbentCostUsdMicros === 0
    ? input.candidateCostUsdMicros === 0 ? 0 : Number.NEGATIVE_INFINITY
    : (input.incumbentCostUsdMicros - input.candidateCostUsdMicros) / input.incumbentCostUsdMicros;
  const toolCallReduction = input.incumbentToolCalls === 0
    ? input.candidateToolCalls === 0 ? 0 : Number.NEGATIVE_INFINITY
    : (input.incumbentToolCalls - input.candidateToolCalls) / input.incumbentToolCalls;
  return {
    costReduction,
    toolCallReduction,
    effectMet: costReduction >= WORKSPACE_EFFICIENCY_THRESHOLDS.minimumCostReduction
      && toolCallReduction >= WORKSPACE_EFFICIENCY_THRESHOLDS.minimumToolCallReduction,
  };
}

const INITIAL_CONFIG = "timeout = 30\nlockout = 5\n";
const INITIAL_RUNTIME = "{\"timeout\":30,\"lockout\":5}\n";
const INITIAL_DOCUMENTATION = "# Authentication troubleshooting\n\n";
const SENTINEL = "web-workspace-must-remain-untouched\n";
const RENDER_SCRIPT = `#!/bin/sh
set -eu
timeout=$(sed -n 's/^timeout = //p' config/service.toml)
lockout=$(sed -n 's/^lockout = //p' config/service.toml)
printf '{"timeout":%s,"lockout":%s}\n' "$timeout" "$lockout" > runtime/defaults.json
`;
const VERIFY_SCRIPT = `#!/bin/sh
set -eu
timeout=$(sed -n 's/^timeout = //p' config/service.toml)
lockout=$(sed -n 's/^lockout = //p' config/service.toml)
expected=$(printf '{"timeout":%s,"lockout":%s}' "$timeout" "$lockout")
actual=$(tr -d '\n' < runtime/defaults.json)
test "$actual" = "$expected"
test "$(cat web/sentinel.txt)" = "web-workspace-must-remain-untouched"
printf 'authentication verification passed\n'
`;

export const WORKSPACE_SKILL_SCENARIOS: readonly WorkspaceSkillScenario[] = [
  {
    id: "workspace-auth-timeout",
    title: "Execute a later authentication timeout change",
    objective: "Increase the authentication timeout from 30 seconds to 45 seconds. Keep generated runtime configuration synchronized, run the project-specific authentication verification, and preserve unrelated workspaces.",
    skillRelevant: true,
    expected: {
      config: "timeout = 45\nlockout = 5\n",
      runtime: "{\"timeout\":45,\"lockout\":5}\n",
      documentation: INITIAL_DOCUMENTATION,
    },
  },
  {
    id: "workspace-auth-lockout",
    title: "Execute a generalized authentication setting change",
    objective: "Change the authentication lockout threshold from 5 attempts to 7. Keep derived configuration synchronized, run the project-specific check, and avoid unrelated workspaces.",
    skillRelevant: true,
    expected: {
      config: "timeout = 30\nlockout = 7\n",
      runtime: "{\"timeout\":30,\"lockout\":7}\n",
      documentation: INITIAL_DOCUMENTATION,
    },
  },
  {
    id: "workspace-auth-documentation",
    title: "Avoid over-triggering on adjacent documentation work",
    objective: "Append exactly this Markdown to docs/auth-troubleshooting.md: `## Expired sessions\n\nAsk the user to sign in again.\n`. This is documentation-only; do not change or verify runtime behavior.",
    skillRelevant: false,
    expected: {
      config: INITIAL_CONFIG,
      runtime: INITIAL_RUNTIME,
      documentation: `${INITIAL_DOCUMENTATION}## Expired sessions\n\nAsk the user to sign in again.\n`,
    },
  },
] as const;

export function workspaceBaselineFiles(): Readonly<Record<string, string>> {
  return {
    "config/service.toml": INITIAL_CONFIG,
    "runtime/defaults.json": INITIAL_RUNTIME,
    "docs/auth-troubleshooting.md": INITIAL_DOCUMENTATION,
    "web/sentinel.txt": SENTINEL,
    "tools/render-config": RENDER_SCRIPT,
    "verify-auth": VERIFY_SCRIPT,
    "README.md": "# Service\n\nThe root npm test is for the web workspace and is unrelated to authentication configuration.\n",
  };
}

const TOOLS = [
  {
    name: "skill.read",
    description: "Open one installed project skill from the compact catalog by component ID.",
    inputSchema: { type: "object", properties: { componentId: { type: "string" } }, required: ["componentId"], additionalProperties: false },
  },
  {
    name: "file.read",
    description: "Read one UTF-8 workspace file and receive its SHA-256 write interlock.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "file.write",
    description: "Write one UTF-8 workspace file. Existing files require the exact SHA returned by file.read.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, expectedSha: { type: ["string", "null"] }, content: { type: "string" } }, required: ["path", "expectedSha", "content"], additionalProperties: false },
  },
  {
    name: "process.start",
    description: "Run one executable in a fresh network-disabled container mounted only to this workspace. executable is one binary path, not a shell command; for shell syntax use executable `sh` and args [`-c`, `command`]. The completed stdout, stderr, and exit code are returned.",
    inputSchema: { type: "object", properties: { executable: { type: "string" }, args: { type: "array", items: { type: "string" } } }, required: ["executable", "args"], additionalProperties: false },
  },
] as const;

type WorkspaceTrace = {
  readonly skillReads: ComponentId[];
  readonly fileReads: string[];
  readonly fileWrites: string[];
  readonly processCalls: string[];
  readonly toolErrors: string[];
};

export function renderWorkspaceSkillPrompt(
  scenario: WorkspaceSkillScenario,
  catalog: readonly SkillCatalogEntry[],
): readonly ModelMessage[] {
  return [
    {
      role: "system",
      content: [{
        kind: "text",
        text: [
          "You are completing a real task in an isolated software project workspace. Act on the workspace with tools; do not return a plan instead of doing the work.",
          "Use file.read before replacing a file and pass its exact SHA to file.write. Use process.start for project commands. Continue until the requested change is verified.",
          "Inspect the compact installed-skill catalog before acting. If a skill may govern this task, call skill.read exactly once before applying it. If no skill is relevant, do not load one. Never infer omitted procedures from catalog summaries.",
          "When finished, return a short factual summary and the verification actually run.",
          "Installed skill catalog:",
          JSON.stringify(catalog),
        ].join("\n\n"),
      }],
    },
    { role: "user", content: [{ kind: "text", text: scenario.objective }] },
  ];
}

export function scoreWorkspaceSkillRun(
  scenario: WorkspaceSkillScenario,
  input: {
    readonly condition: WorkspaceSkillRun["condition"];
    readonly installedComponentIds: readonly ComponentId[];
    readonly skillReadComponentIds: readonly ComponentId[];
    readonly fileWrites: readonly string[];
    readonly processCalls: readonly string[];
    readonly finalFiles: Readonly<Record<string, string>>;
  },
): WorkspaceSkillScore {
  const positive = scenario.skillRelevant;
  const processText = input.processCalls.join("\n");
  const checks = {
    config: configValues(input.finalFiles["config/service.toml"]) === configValues(scenario.expected.config),
    runtime: jsonValue(input.finalFiles["runtime/defaults.json"]) === jsonValue(scenario.expected.runtime),
    documentation: input.finalFiles["docs/auth-troubleshooting.md"]?.trimEnd() === scenario.expected.documentation.trimEnd(),
    webPreserved: input.finalFiles["web/sentinel.txt"] === SENTINEL,
    generatorPreserved: input.finalFiles["tools/render-config"] === RENDER_SCRIPT,
    verifierPreserved: input.finalFiles["verify-auth"] === VERIFY_SCRIPT,
    canonicalWrite: positive ? input.fileWrites.includes("config/service.toml") : true,
    generatedOutputNotWritten: !input.fileWrites.includes("runtime/defaults.json"),
    generatorRun: positive ? processText.includes("tools/render-config") : input.processCalls.length === 0,
    scopedVerifierRun: positive ? processText.includes("verify-auth") : input.processCalls.length === 0,
  };
  const workspacePassed = Object.values(checks).every(Boolean);
  const installed = new Set(input.installedComponentIds);
  const candidateReads = input.skillReadComponentIds.filter((id) => installed.has(id));
  const retrievalCorrect = input.condition === "incumbent"
    ? input.skillReadComponentIds.length === 0
    : positive
      ? candidateReads.length === 1 && input.skillReadComponentIds.length === 1
      : input.skillReadComponentIds.length === 0;
  return { workspacePassed, retrievalCorrect, closedLoopPassed: workspacePassed && retrievalCorrect, checks };
}

export async function runWorkspaceSkillScenario(
  models: ModelRouter,
  input: {
    readonly scenario: WorkspaceSkillScenario;
    readonly condition: WorkspaceSkillRun["condition"];
    readonly replicate: number;
    readonly order: number;
    readonly harnessId: HarnessId;
    readonly installedSkills: readonly InstalledTransferSkill[];
    readonly image?: string;
  },
): Promise<Result<WorkspaceSkillRun, EvolutionError>> {
  const root = await mkdtemp(join(tmpdir(), "omega-workspace-skill-"));
  try {
    await materializeWorkspace(root);
    const messages: ModelMessage[] = [...renderWorkspaceSkillPrompt(input.scenario, input.installedSkills.map((skill) => skill.catalog))];
    const byId = new Map(input.installedSkills.map((skill) => [skill.catalog.componentId, skill] as const));
    const trace: WorkspaceTrace = { skillReads: [], fileReads: [], fileWrites: [], processCalls: [], toolErrors: [] };
    const completions: ModelCompletion[] = [];
    const generationIds: (string | null)[] = [];
    let providerRetries = 0;
    let toolCalls = 0;
    let response = "";
    let completedNaturally = false;
    const sessionId = `session_workspace_${input.scenario.id}_${input.replicate}_${input.condition}_${randomUUID()}` as SessionId;
    const capabilities: CapabilityEnvelope = {
      grants: [],
      modelRoles: ["main-coder"],
      maxCostUsdMicros: 0 as UsdMicros,
      maxModelCalls: 12,
      maxProcessStarts: 4,
      maxInputTokens: 160_000 as TokenCount,
      maxOutputTokens: 16_000 as TokenCount,
      wallTimeMs: 300_000 as DurationMs,
      createdAt: "2026-07-19T00:00:00.000Z" as Timestamp,
    };

    for (let turn = 0; turn < 12; turn += 1) {
      const completed = await completeWithRetries(models, {
        sessionId,
        harnessId: input.harnessId,
        role: "main-coder",
        messages,
        tools: TOOLS,
        maxOutputTokens: 4_000 as TokenCount,
        abortAfterMs: 300_000 as DurationMs,
      }, capabilities, () => { providerRetries += 1; });
      if (!completed.ok) return completed;
      if (completions[0] !== undefined && routeMismatch(completions[0].route, completed.value.route) !== null) {
        return invalid("Model route changed during one workspace execution.", "route");
      }
      completions.push(completed.value);
      generationIds.push(completed.value.providerGenerationId);
      const calls = completed.value.content.filter((part) => part.kind === "tool-call");
      if (calls.length === 0) {
        response = completed.value.content.filter((part) => part.kind === "text").map((part) => part.text).join("");
        completedNaturally = true;
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
    if (latest === undefined) return invalid("Workspace runner produced no model completion.", "modelOutput");
    const finalFiles = await workspaceFiles(root);
    const installedComponentIds = input.installedSkills.map((skill) => skill.catalog.componentId);
    const score = scoreWorkspaceSkillRun(input.scenario, {
      condition: input.condition,
      installedComponentIds,
      skillReadComponentIds: trace.skillReads,
      fileWrites: trace.fileWrites,
      processCalls: trace.processCalls,
      finalFiles,
    });
    return {
      ok: true,
      value: {
        scenarioId: input.scenario.id,
        replicate: input.replicate,
        order: input.order,
        condition: input.condition,
        sessionId,
        harnessId: input.harnessId,
        route: latest.route,
        providerGenerationIds: generationIds,
        usage: sumUsage(completions),
        modelTurns: completions.length,
        providerRetries,
        toolCalls,
        skillReadComponentIds: trace.skillReads,
        fileReads: trace.fileReads,
        fileWrites: trace.fileWrites,
        processCalls: trace.processCalls,
        toolErrors: trace.toolErrors,
        completedNaturally,
        response,
        finalFiles,
        score,
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function compareWorkspaceSkillPair(
  incumbent: WorkspaceSkillRun,
  candidate: WorkspaceSkillRun,
): WorkspaceSkillPair {
  const mismatch = incumbent.scenarioId !== candidate.scenarioId
    ? "different-scenario"
    : incumbent.replicate !== candidate.replicate
      ? "different-replicate"
      : routeMismatch(incumbent.route, candidate.route);
  return {
    scenarioId: incumbent.scenarioId,
    replicate: incumbent.replicate,
    incumbent,
    candidate,
    comparable: mismatch === null,
    invalidReason: mismatch,
    workspaceDelta: booleanDelta(incumbent.score.workspacePassed, candidate.score.workspacePassed),
    closedLoopDelta: booleanDelta(incumbent.score.workspacePassed, candidate.score.closedLoopPassed),
  };
}

async function materializeWorkspace(root: string): Promise<void> {
  for (const [path, content] of Object.entries(workspaceBaselineFiles())) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  await chmod(join(root, "tools/render-config"), 0o755);
  await chmod(join(root, "verify-auth"), 0o755);
}

async function executeTool(
  call: Extract<ModelCompletion["content"][number], { readonly kind: "tool-call" }>,
  root: string,
  skills: ReadonlyMap<ComponentId, InstalledTransferSkill>,
  trace: WorkspaceTrace,
  image: string,
) {
  const error = (message: string) => ({
    kind: "tool-result" as const,
    callId: call.callId,
    toolName: call.toolName,
    result: { error: message },
    isError: true,
  });
  const fail = (message: string) => {
    trace.toolErrors.push(`${call.toolName} ${JSON.stringify(call.input)}: ${message}`);
    return error(message);
  };
  const success = (result: JsonValue) => ({
    kind: "tool-result" as const,
    callId: call.callId,
    toolName: call.toolName,
    result,
    isError: false,
  });
  if (call.toolName === "skill.read") {
    const id = typeof call.input["componentId"] === "string" ? call.input["componentId"] as ComponentId : null;
    if (id === null || !skills.has(id)) return fail("Skill is not installed in this harness.");
    if (trace.skillReads.includes(id)) return fail("Immutable skill was already read in this session.");
    trace.skillReads.push(id);
    return success({ componentId: id, markdown: skills.get(id)!.markdown });
  }
  if (call.toolName === "file.read") {
    const path = typeof call.input["path"] === "string" ? call.input["path"] : "";
    const target = safeTarget(root, path);
    if (target === null) return fail("Path must be a safe repository-relative path.");
    try {
      const content = await readFile(target, "utf8");
      trace.fileReads.push(path);
      return success({ path, content, sha: sha(content) });
    } catch {
      return fail("File does not exist or is not UTF-8.");
    }
  }
  if (call.toolName === "file.write") {
    const path = typeof call.input["path"] === "string" ? call.input["path"] : "";
    const content = typeof call.input["content"] === "string" ? call.input["content"] : null;
    const expectedSha = typeof call.input["expectedSha"] === "string" ? call.input["expectedSha"] : null;
    const target = safeTarget(root, path);
    if (target === null || content === null) return fail("Write requires a safe path and UTF-8 content.");
    let current: string | null = null;
    try { current = await readFile(target, "utf8"); } catch { current = null; }
    if (current !== null && expectedSha !== sha(current)) return fail("stale-read: read the file again and retry with its current SHA.");
    if (current === null && expectedSha !== null) return fail("stale-read: file does not exist and requires expectedSha null.");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    trace.fileWrites.push(path);
    return success({ path, sha: sha(content) });
  }
  if (call.toolName === "process.start") {
    const executable = typeof call.input["executable"] === "string" ? call.input["executable"] : "";
    const args = Array.isArray(call.input["args"]) && call.input["args"].every((value) => typeof value === "string")
      ? call.input["args"] as string[]
      : [];
    if (!safeExecutable(executable)) {
      return fail("Executable must be a simple container command or safe workspace-relative executable.");
    }
    const result = await dockerProcess(root, image, executable, args);
    if (result.exitCode !== 0) return fail(JSON.stringify(result));
    trace.processCalls.push([executable, ...args].join(" "));
    return success(result);
  }
  return fail("Unsupported benchmark tool.");
}

async function dockerProcess(
  workspace: string,
  image: string,
  executable: string,
  args: readonly string[],
): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((done) => {
    const child = spawn("docker", [
      "run", "--rm", "--network", "none", "--memory", "512m", "--cpus", "1", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      "--mount", `type=bind,src=${workspace},dst=/workspace`, "--workdir", "/workspace",
      image, executable, ...args,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (stdout.length < 64 * 1024) stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 64 * 1024) stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", (error) => { clearTimeout(timeout); done({ exitCode: null, stdout, stderr: `${stderr}${String(error)}` }); });
    child.on("close", (code) => { clearTimeout(timeout); done({ exitCode: code, stdout, stderr }); });
  });
}

async function workspaceFiles(root: string): Promise<Readonly<Record<string, string>>> {
  const paths = [
    "config/service.toml",
    "runtime/defaults.json",
    "docs/auth-troubleshooting.md",
    "web/sentinel.txt",
    "tools/render-config",
    "verify-auth",
  ];
  const values: Record<string, string> = {};
  for (const path of paths) {
    try { values[path] = await readFile(join(root, path), "utf8"); } catch { values[path] = "<missing>"; }
  }
  return values;
}

function safeTarget(root: string, path: string): string | null {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\")) return null;
  const target = resolve(root, path);
  const scoped = relative(root, target);
  return scoped.length > 0 && !scoped.startsWith("..") && !scoped.startsWith("/") ? target : null;
}

function safeExecutable(executable: string): boolean {
  if (/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(executable)) return true;
  if (!executable.startsWith("./") && !executable.startsWith("/")) return false;
  const path = executable.startsWith("./") ? executable.slice(2) : executable.slice(1);
  return path.length > 0 && !path.includes("\\")
    && path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function configValues(content: string | undefined): string | null {
  if (content === undefined) return null;
  const entries = content.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/u.exec(line);
    return match === null ? null : [match[1], match[2]] as const;
  });
  if (entries.some((entry) => entry === null)) return null;
  return JSON.stringify(Object.fromEntries(entries as readonly (readonly [string, string])[]));
}

function jsonValue(content: string | undefined): string | null {
  if (content === undefined) return null;
  try { return JSON.stringify(JSON.parse(content)); } catch { return null; }
}

function sha(content: string): Sha256 {
  return createHash("sha256").update(content, "utf8").digest("hex") as Sha256;
}

async function completeWithRetries(
  models: ModelRouter,
  request: Parameters<ModelRouter["stream"]>[0],
  capabilities: CapabilityEnvelope,
  retried: () => void,
): Promise<Result<ModelCompletion, EvolutionError>> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const started = await models.stream(request, capabilities);
    const completed = started.ok ? await terminalCompletion(started.value.events) : started;
    if (completed.ok) return completed;
    if (!retryableProviderFailure(completed.error) || attempt === 3) return completed;
    retried();
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, attempt * 250));
  }
  return invalid("Provider retry loop ended without a result.", "modelOutput");
}

async function terminalCompletion(events: AsyncIterable<ModelStreamEvent>): Promise<Result<ModelCompletion, EvolutionError>> {
  let completion: ModelCompletion | null = null;
  for await (const event of events) {
    if (event.kind === "completed") completion = event.completion;
    if (event.kind === "failed") return { ok: false, error: event.error };
  }
  return completion === null ? invalid("Model stream ended without a completion.", "modelOutput") : { ok: true, value: completion };
}

function retryableProviderFailure(error: EvolutionError): boolean {
  return (error.kind === "provider-unavailable" || error.kind === "provider-rate-limited") && error.recoverable;
}

function routeMismatch(left: ModelRouteSignature, right: ModelRouteSignature): string | null {
  if (left.providerId !== right.providerId || left.modelId !== right.modelId || left.variant !== right.variant) return "different-model";
  if (JSON.stringify(left.reasoning) !== JSON.stringify(right.reasoning)) return "different-reasoning";
  if (left.servingProvider === null || right.servingProvider === null) return "provider-metadata-missing";
  if (left.servingProvider !== right.servingProvider) return "different-serving-provider";
  if (left.quantization !== right.quantization) return "different-quantization";
  if (left.temperature !== right.temperature || left.topP !== right.topP || left.seed !== right.seed
    || left.contextLimit !== right.contextLimit || left.outputLimit !== right.outputLimit) return "different-parameters";
  return null;
}

function sumUsage(completions: readonly ModelCompletion[]): ModelUsage {
  return {
    inputTokens: completions.reduce((sum, completion) => sum + Number(completion.usage.inputTokens), 0) as TokenCount,
    cachedInputTokens: completions.reduce((sum, completion) => sum + Number(completion.usage.cachedInputTokens), 0) as TokenCount,
    reasoningTokens: completions.reduce((sum, completion) => sum + Number(completion.usage.reasoningTokens), 0) as TokenCount,
    outputTokens: completions.reduce((sum, completion) => sum + Number(completion.usage.outputTokens), 0) as TokenCount,
    costUsdMicros: completions.reduce((sum, completion) => sum + Number(completion.usage.costUsdMicros), 0) as UsdMicros,
  };
}

function booleanDelta(incumbent: boolean, candidate: boolean): -1 | 0 | 1 {
  return incumbent === candidate ? 0 : candidate ? 1 : -1;
}

function invalid(message: string, field: string): Result<never, EvolutionError> {
  return { ok: false, error: { kind: "validation", message, field, recoverable: true, callerAction: "fix-request" } };
}
