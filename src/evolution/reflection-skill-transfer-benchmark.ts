import type {
  CapabilityEnvelope,
  ComponentId,
  DurationMs,
  EvolutionError,
  HarnessId,
  JsonObject,
  JsonValue,
  ModelCompletion,
  ModelMessage,
  ModelRouteSignature,
  ModelRouter,
  ModelStreamEvent,
  ModelUsage,
  Result,
  SessionId,
  SkillCatalogEntry,
  Timestamp,
  TokenCount,
  UsdMicros,
} from "../contracts/index.js";

type Concept = {
  readonly label: string;
  readonly alternatives: readonly string[];
};

export type SkillTransferScenario = {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly repositoryInventory: readonly string[];
  readonly skillRelevant: boolean;
  /** Evaluator-only. renderSkillTransferPrompt never serializes these fields. */
  readonly rubric: {
    readonly requiredConcepts: readonly Concept[];
    readonly forbiddenClaims: readonly string[];
  };
};

export type InstalledTransferSkill = {
  readonly catalog: SkillCatalogEntry;
  readonly markdown: string;
};

export type SkillTransferScore = {
  readonly requiredConcepts: readonly boolean[];
  readonly contradictionFree: boolean;
  readonly taskPassed: boolean;
  readonly retrievalCorrect: boolean;
  readonly closedLoopPassed: boolean;
};

export type SkillTransferRun = {
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
  readonly skillReadComponentIds: readonly ComponentId[];
  readonly response: string;
  readonly parsedResponse: JsonObject | null;
  readonly score: SkillTransferScore;
};

export type SkillTransferPair = {
  readonly scenarioId: string;
  readonly replicate: number;
  readonly incumbent: SkillTransferRun;
  readonly candidate: SkillTransferRun;
  readonly comparable: boolean;
  readonly invalidReason: string | null;
  readonly taskDelta: -1 | 0 | 1;
  readonly closedLoopDelta: -1 | 0 | 1;
};

export const REFLECTION_SKILL_TRANSFER_SCENARIOS: readonly SkillTransferScenario[] = [
  {
    id: "auth-timeout-followup",
    title: "Apply the learned auth generation workflow to a later timeout change",
    objective: "Increase the authentication timeout from 30 seconds to 45 seconds. Keep the generated runtime configuration consistent and verify only authentication. Preserve unrelated work.",
    repositoryInventory: [
      "config/service.toml",
      "runtime/defaults.json",
      "tools/render-config",
      "verify-auth",
      "web/package.json",
      "README.md (mentions a generic root npm test)",
    ],
    skillRelevant: true,
    rubric: {
      requiredConcepts: [
        { label: "canonical source", alternatives: ["config/service.toml"] },
        { label: "regeneration", alternatives: ["tools/render-config", "render-config"] },
        { label: "auth-scoped verification", alternatives: ["./verify-auth", "verify-auth"] },
        { label: "generated output is not edited directly", alternatives: ["do not edit runtime/defaults.json", "not runtime/defaults.json directly", "never edit runtime/defaults.json", "generated file directly"] },
        { label: "web workspace preserved", alternatives: ["web workspace untouched", "do not touch the web workspace", "leave the web workspace untouched", "preserve the web workspace", "avoid the web workspace"] },
      ],
      forbiddenClaims: ["update web/", "edit web/", "npm test is authoritative", "skip regeneration"],
    },
  },
  {
    id: "auth-lockout-followup",
    title: "Reuse the learned workflow for a different auth setting",
    objective: "Change the authentication lockout threshold from 5 attempts to 7. Keep derived configuration synchronized, run the project-specific check, and avoid unrelated workspaces.",
    repositoryInventory: [
      "config/service.toml",
      "runtime/defaults.json",
      "tools/render-config",
      "verify-auth",
      "web/src/auth.ts",
      "README.md (mentions a generic root npm test)",
    ],
    skillRelevant: true,
    rubric: {
      requiredConcepts: [
        { label: "canonical source", alternatives: ["config/service.toml"] },
        { label: "regeneration", alternatives: ["tools/render-config", "render-config"] },
        { label: "auth-scoped verification", alternatives: ["./verify-auth", "verify-auth"] },
        { label: "generated output is not edited directly", alternatives: ["do not edit runtime/defaults.json", "not runtime/defaults.json directly", "never edit runtime/defaults.json", "generated file directly"] },
        { label: "web workspace preserved", alternatives: ["web workspace untouched", "do not touch the web workspace", "leave the web workspace untouched", "preserve the web workspace", "avoid the web workspace"] },
      ],
      forbiddenClaims: ["update web/", "edit web/", "npm test is authoritative", "skip regeneration"],
    },
  },
  {
    id: "auth-documentation-only",
    title: "Avoid over-triggering the runtime skill for adjacent documentation work",
    objective: "Add a short troubleshooting note about expired authentication sessions. This is documentation-only; do not change runtime behavior.",
    repositoryInventory: [
      "docs/auth-troubleshooting.md",
      "config/service.toml",
      "runtime/defaults.json",
      "tools/render-config",
      "verify-auth",
    ],
    skillRelevant: false,
    rubric: {
      requiredConcepts: [
        { label: "documentation target", alternatives: ["docs/auth-troubleshooting.md"] },
        { label: "documentation-only boundary", alternatives: ["documentation-only", "documentation only", "no runtime behavior", "do not change runtime behavior", "do not modify any runtime configuration or code"] },
      ],
      forbiddenClaims: ["config/service.toml", "runtime/defaults.json", "tools/render-config", "verify-auth"],
    },
  },
] as const;

const SKILL_READ_TOOL = {
  name: "skill.read",
  description: "Open one installed project skill from the compact catalog by component ID.",
  inputSchema: {
    type: "object",
    properties: { componentId: { type: "string" } },
    required: ["componentId"],
    additionalProperties: false,
  },
} as const;

const MAX_MODEL_TURNS = 2;

export function renderSkillTransferPrompt(
  scenario: SkillTransferScenario,
  catalog: readonly SkillCatalogEntry[],
): { readonly messages: readonly ModelMessage[]; readonly tools: readonly [typeof SKILL_READ_TOOL] } {
  const system = [
    "You are handling a later task in an ongoing software project.",
    "You receive only a compact catalog of installed project skills. If an installed skill may govern the task, call skill.read before answering; do not infer omitted procedures from a title. If no skill is relevant, do not open one.",
    "Return a concrete implementation plan as exactly one JSON object with keys summary, steps, filesTouched, commands, and constraints. Use arrays of strings for every key except summary. Do not wrap the JSON in a code fence.",
    "Installed skill catalog:",
    JSON.stringify(catalog),
  ].join("\n\n");
  const user = [
    scenario.objective,
    "Repository inventory:",
    scenario.repositoryInventory.map((path) => `- ${path}`).join("\n"),
  ].join("\n\n");
  return {
    messages: [
      { role: "system", content: [{ kind: "text", text: system }] },
      { role: "user", content: [{ kind: "text", text: user }] },
    ],
    tools: [SKILL_READ_TOOL],
  };
}

export function scoreSkillTransferResponse(
  scenario: SkillTransferScenario,
  response: string,
  readComponentIds: readonly ComponentId[],
  installedComponentIds: readonly ComponentId[],
): SkillTransferScore {
  const parsedResponse = parseResponse(response);
  const text = parsedResponse === null ? response : flattenedText(parsedResponse);
  const normalized = text.toLocaleLowerCase("en-US");
  const requiredConcepts = scenario.rubric.requiredConcepts.map((concept) =>
    concept.alternatives.some((alternative) => normalized.includes(alternative.toLocaleLowerCase("en-US"))));
  const contradictionFree = !scenario.rubric.forbiddenClaims.some((claim) =>
    normalized.includes(claim.toLocaleLowerCase("en-US")));
  const taskPassed = parsedResponse !== null && requiredConcepts.every(Boolean) && contradictionFree;
  const installed = new Set(installedComponentIds);
  const exactReads = readComponentIds.length > 0 && readComponentIds.every((id) => installed.has(id));
  const retrievalCorrect = scenario.skillRelevant
    ? installedComponentIds.length === 0 ? readComponentIds.length === 0 : exactReads
    : readComponentIds.length === 0;
  return {
    requiredConcepts,
    contradictionFree,
    taskPassed,
    retrievalCorrect,
    closedLoopPassed: taskPassed && retrievalCorrect,
  };
}

export async function runSkillTransferScenario(
  models: ModelRouter,
  input: {
    readonly scenario: SkillTransferScenario;
    readonly condition: SkillTransferRun["condition"];
    readonly replicate: number;
    readonly order: number;
    readonly harnessId: HarnessId;
    readonly installedSkills: readonly InstalledTransferSkill[];
  },
): Promise<Result<SkillTransferRun, EvolutionError>> {
  const rendered = renderSkillTransferPrompt(input.scenario, input.installedSkills.map((skill) => skill.catalog));
  const messages: ModelMessage[] = [...rendered.messages];
  const sessionId = `session_transfer_${input.scenario.id}_${input.replicate}_${input.condition}` as SessionId;
  const capabilities: CapabilityEnvelope = {
    grants: [],
    modelRoles: ["main-coder"],
    maxCostUsdMicros: 0 as UsdMicros,
    maxModelCalls: MAX_MODEL_TURNS,
    maxProcessStarts: 0,
    maxInputTokens: 80_000 as TokenCount,
    maxOutputTokens: 8_000 as TokenCount,
    wallTimeMs: 300_000 as DurationMs,
    createdAt: "2026-07-19T00:00:00.000Z" as Timestamp,
  };
  const byId = new Map(input.installedSkills.map((skill) => [skill.catalog.componentId, skill] as const));
  const reads: ComponentId[] = [];
  const generationIds: (string | null)[] = [];
  const completions: ModelCompletion[] = [];
  let providerRetries = 0;

  function finish(completion: ModelCompletion, response: string): Result<SkillTransferRun, EvolutionError> {
    const installedIds = input.installedSkills.map((skill) => skill.catalog.componentId);
    return {
      ok: true,
      value: {
        scenarioId: input.scenario.id,
        replicate: input.replicate,
        order: input.order,
        condition: input.condition,
        sessionId,
        harnessId: input.harnessId,
        route: completion.route,
        providerGenerationIds: generationIds,
        usage: sumUsage(completions),
        modelTurns: completions.length,
        providerRetries,
        skillReadComponentIds: reads,
        response,
        parsedResponse: parseResponse(response),
        score: scoreSkillTransferResponse(input.scenario, response, reads, installedIds),
      },
    };
  }

  for (let turn = 0; turn < MAX_MODEL_TURNS; turn += 1) {
    const request = {
      sessionId,
      harnessId: input.harnessId,
      role: "main-coder",
      messages,
      tools: turn === 0 ? rendered.tools : [],
      maxOutputTokens: 4_000 as TokenCount,
      abortAfterMs: 300_000 as DurationMs,
    } as const;
    const completed = await completeWithRetries(models, request, capabilities, () => { providerRetries += 1; });
    if (!completed.ok) return completed;
    if (completions.length > 0 && routeMismatch(completions[0]!.route, completed.value.route) !== null) {
      return invalid("Model route changed between skill retrieval and final response.", "route");
    }
    completions.push(completed.value);
    generationIds.push(completed.value.providerGenerationId);
    const calls = completed.value.content.filter((part) => part.kind === "tool-call");
    if (calls.length === 0) {
      const response = completed.value.content.filter((part) => part.kind === "text").map((part) => part.text).join("");
      return finish(completed.value, response);
    }
    messages.push({ role: "assistant", content: calls });
    const results = calls.map((call) => {
      const requested = typeof call.input["componentId"] === "string"
        ? call.input["componentId"] as ComponentId
        : null;
      if (call.toolName === "skill.read" && requested !== null) reads.push(requested);
      const skill = requested === null ? undefined : byId.get(requested);
      if (call.toolName === "skill.read" && requested !== null && skill !== undefined) {
        return {
          kind: "tool-result" as const,
          callId: call.callId,
          toolName: call.toolName,
          result: { componentId: requested, markdown: skill.markdown },
          isError: false,
        };
      }
      return {
        kind: "tool-result" as const,
        callId: call.callId,
        toolName: call.toolName,
        result: {
          error: "Requested skill is not installed in this harness. The installed skill catalog below is authoritative; do not retry an unavailable ID.",
          installedSkillCatalog: input.installedSkills.map((item) => item.catalog),
        },
        isError: true,
      };
    });
    messages.push({ role: "tool", content: results });
  }
  const latest = completions.at(-1);
  if (latest === undefined) return invalid("Model stream produced no completion.", "modelOutput");
  const partialResponse = latest.content.filter((part) => part.kind === "text").map((part) => part.text).join("");
  return finish(latest, partialResponse);
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
    await new Promise<void>((resolve) => setTimeout(resolve, attempt * 250));
  }
  return invalid("Provider retry loop ended without a result.", "modelOutput");
}

function retryableProviderFailure(error: EvolutionError): boolean {
  return (error.kind === "provider-unavailable" || error.kind === "provider-rate-limited") && error.recoverable;
}

export function compareSkillTransferPair(
  incumbent: SkillTransferRun,
  candidate: SkillTransferRun,
): SkillTransferPair {
  const mismatch = incumbent.scenarioId !== candidate.scenarioId
    ? "different-scenario"
    : incumbent.replicate !== candidate.replicate
      ? "different-replicate"
      : routeMismatch(incumbent.route, candidate.route);
  const taskDelta = booleanDelta(incumbent.score.taskPassed, candidate.score.taskPassed);
  const closedLoopDelta = booleanDelta(incumbent.score.taskPassed, candidate.score.closedLoopPassed);
  return {
    scenarioId: incumbent.scenarioId,
    replicate: incumbent.replicate,
    incumbent,
    candidate,
    comparable: mismatch === null,
    invalidReason: mismatch,
    taskDelta,
    closedLoopDelta,
  };
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

async function terminalCompletion(
  events: AsyncIterable<ModelStreamEvent>,
): Promise<Result<ModelCompletion, EvolutionError>> {
  let completion: ModelCompletion | null = null;
  for await (const event of events) {
    if (event.kind === "completed") completion = event.completion;
    if (event.kind === "failed") return { ok: false, error: event.error };
  }
  return completion === null
    ? invalid("Model stream ended without a completion.", "modelOutput")
    : { ok: true, value: completion };
}

function parseResponse(text: string): JsonObject | null {
  for (const source of [text.trim(), ...embeddedJsonObjects(text)]) {
    try {
      const parsed: unknown = JSON.parse(source);
      if (isRecord(parsed) && typeof parsed["summary"] === "string"
        && ["steps", "filesTouched", "commands", "constraints"].every((key) =>
          Array.isArray(parsed[key]) && (parsed[key] as unknown[]).every((value) => typeof value === "string"))) {
        return parsed as JsonObject;
      }
    } catch {
      // Continue to embedded objects.
    }
  }
  return null;
}

function flattenedText(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(flattenedText).join("\n");
  return Object.values(value).map(flattenedText).join("\n");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
