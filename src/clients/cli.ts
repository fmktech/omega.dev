import type {
  AbsolutePath,
  ArtifactId,
  BenchmarkBudget,
  BenchmarkSuiteId,
  BenchmarkTaskId,
  ByteCount,
  ClientRequest,
  ComponentKind,
  EvolutionJobId,
  HarnessId,
  KnowledgeDocumentId,
  MarketplaceArtifactId,
  MarketplaceArtifactKind,
  MarketplaceState,
  OmegaClient,
  PolicyEscalationId,
  ProjectId,
  RelativePath,
  RequestId,
  RunCli,
  ScorecardId,
  SessionId,
  TokenCount,
  UsdMicros,
  DurationMs,
  WorkspaceId,
} from "../contracts/index.js";

const HELP = `omega.dev CLI

Discovery
  projects [cursor] [limit]
  register <absolute-path>
  sessions <project-id> [cursor] [limit]
  session <session-id>
  artifact <artifact-id> [offset] [limit]

Work
  start <project-id> <workspace-id> <objective...>
  resume <source-session-id> <workspace-id> <handoff-artifact-id> [context-artifact-ids-csv]
  cancel-session <session-id> <reason...>
  watch <session-id> [after-sequence]

Governance
  policies <session-id> <pending|resolved> [cursor] [limit]
  resolve-policy <escalation-id> <allow|deny> <reason...>
  harness <harness-id>
  harnesses <project-id> [cursor] [limit]
  pin-harness <project-id> <harness-id> <reason...>
  rollback-harness <project-id> <harness-id> <reason...>

Knowledge and marketplace
  knowledge <project-id> <text> [tags-csv] [paths-csv] [limit]
  knowledge-read <project-id> <document-id>
  marketplace <text> [kinds-csv] [states-csv] [limit]
  marketplace-transition <artifact-id> <expected-state> <next-state> <reason...>

Evolution and evaluation
  evolutions <project-id> [cursor] [limit]
  evolution <job-id>
  evolution-retry <job-id>
  evolution-cancel <job-id> <reason...>
  evolution-start <project-id> <source-session-id> <goal> <wall-ms> <model-calls> <input-tokens> <output-tokens> <cost-micros> <processes> [evidence-csv] [component-kinds-csv]
  benchmark <suite-id> <task-id> <harness-id>
  paired <suite-id> <incumbent-harness-id> <candidate-harness-id>
  scorecards <project-id> [cursor] [limit]
  scorecard <scorecard-id>`;

function required(argv: readonly string[], index: number, label: string): string {
  const value = argv[index];
  if (value === undefined || value.length === 0) throw new Error(`Missing ${label}`);
  return value;
}

function integer(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function positiveInteger(value: string, label: string): number {
  const parsed = integer(value, 0, label);
  if (parsed === 0) throw new Error(`${label} must be greater than zero`);
  return parsed;
}

function csv(value: string | undefined): readonly string[] {
  return value === undefined || value.length === 0 ? [] : value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

function page(argv: readonly string[], cursorIndex: number): { readonly cursor: string | null; readonly limit: number } {
  const cursor = argv[cursorIndex];
  return { cursor: cursor === undefined || cursor === "-" ? null : cursor, limit: positiveInteger(argv[cursorIndex + 1] ?? "50", "limit") };
}

function requestId(): RequestId {
  return crypto.randomUUID() as RequestId;
}

const COMPONENT_KINDS: readonly ComponentKind[] = ["runner", "tool", "connector", "skill", "workflow", "context-compiler", "promotion-evaluator", "policy-prompt"];
const MARKETPLACE_KINDS: readonly MarketplaceArtifactKind[] = ["harness", "tool", "connector", "skill", "workflow", "component-delta"];
const SEARCHABLE_STATES: readonly Exclude<MarketplaceState, "quarantined">[] = ["experimental", "proven", "deprecated"];
const TRANSITION_STATES: readonly MarketplaceState[] = [...SEARCHABLE_STATES, "quarantined"];

function enumValues<T extends string>(values: readonly string[], allowed: readonly T[], label: string): readonly T[] {
  for (const value of values) if (!allowed.includes(value as T)) throw new Error(`Invalid ${label}: ${value}`);
  return values as readonly T[];
}

function reason(argv: readonly string[], index: number): string {
  const value = argv.slice(index).join(" ").trim();
  if (value.length === 0) throw new Error("A reason is required");
  return value;
}

function createRequest(argv: readonly string[]): ClientRequest {
  const command = required(argv, 0, "command");
  const id = requestId();
  switch (command) {
    case "projects": return { kind: "project.list", requestId: id, page: page(argv, 1) };
    case "register": return { kind: "project.register-workspace", requestId: id, path: required(argv, 1, "path") as AbsolutePath };
    case "start": return { kind: "task.start", requestId: id, request: { projectId: required(argv, 1, "project ID") as ProjectId, workspaceId: required(argv, 2, "workspace ID") as WorkspaceId, objective: reason(argv, 3), modelRole: "main-coder" } };
    case "resume": return { kind: "thread.resume", requestId: id, request: { sourceSessionId: required(argv, 1, "source session ID") as SessionId, workspaceId: required(argv, 2, "workspace ID") as WorkspaceId, handoffArtifactId: required(argv, 3, "handoff artifact ID") as ArtifactId, contextArtifactIds: csv(argv[4]) as readonly ArtifactId[] } };
    case "session": return { kind: "session.get", requestId: id, sessionId: required(argv, 1, "session ID") as SessionId };
    case "sessions": return { kind: "session.list", requestId: id, projectId: required(argv, 1, "project ID") as ProjectId, page: page(argv, 2) };
    case "artifact": return { kind: "artifact.read", requestId: id, artifactId: required(argv, 1, "artifact ID") as ArtifactId, offset: integer(argv[2], 0, "offset") as ByteCount, limit: positiveInteger(argv[3] ?? "65536", "limit") as ByteCount };
    case "cancel-session": return { kind: "session.cancel", requestId: id, sessionId: required(argv, 1, "session ID") as SessionId, reason: reason(argv, 2) };
    case "policies": {
      const state = required(argv, 2, "state");
      if (state !== "pending" && state !== "resolved") throw new Error("state must be pending or resolved");
      return { kind: "policy.list", requestId: id, sessionId: required(argv, 1, "session ID") as SessionId, state, page: page(argv, 3) };
    }
    case "resolve-policy": {
      const resolution = required(argv, 2, "resolution");
      if (resolution !== "allow" && resolution !== "deny") throw new Error("resolution must be allow or deny");
      return { kind: "policy.resolve", requestId: id, request: { escalationId: required(argv, 1, "escalation ID") as PolicyEscalationId, resolution, reason: reason(argv, 3) } };
    }
    case "evolutions": return { kind: "evolution.list", requestId: id, projectId: required(argv, 1, "project ID") as ProjectId, page: page(argv, 2) };
    case "evolution": return { kind: "evolution.get", requestId: id, jobId: required(argv, 1, "job ID") as EvolutionJobId };
    case "evolution-retry": return { kind: "evolution.retry", requestId: id, jobId: required(argv, 1, "job ID") as EvolutionJobId };
    case "evolution-cancel": return { kind: "evolution.cancel", requestId: id, jobId: required(argv, 1, "job ID") as EvolutionJobId, reason: reason(argv, 2) };
    case "evolution-start": {
      const budget: BenchmarkBudget = {
        wallTimeMs: positiveInteger(required(argv, 4, "wall time"), "wall time") as DurationMs,
        maxModelCalls: positiveInteger(required(argv, 5, "model calls"), "model calls"),
        maxInputTokens: positiveInteger(required(argv, 6, "input tokens"), "input tokens") as TokenCount,
        maxOutputTokens: positiveInteger(required(argv, 7, "output tokens"), "output tokens") as TokenCount,
        maxCostUsdMicros: integer(required(argv, 8, "cost"), 0, "cost") as UsdMicros,
        maxProcessStarts: positiveInteger(required(argv, 9, "processes"), "processes"),
      };
      return { kind: "evolution.start", requestId: id, request: { projectId: required(argv, 1, "project ID") as ProjectId, sourceSessionId: required(argv, 2, "source session ID") as SessionId, goal: required(argv, 3, "goal"), budget, evidenceArtifactIds: csv(argv[10]) as readonly ArtifactId[], allowedComponentKinds: enumValues(csv(argv[11]), COMPONENT_KINDS, "component kind") } };
    }
    case "benchmark": return { kind: "benchmark.run-task", requestId: id, suiteId: required(argv, 1, "suite ID") as BenchmarkSuiteId, taskId: required(argv, 2, "task ID") as BenchmarkTaskId, harnessId: required(argv, 3, "harness ID") as HarnessId };
    case "paired": return { kind: "benchmark.run-paired", requestId: id, suiteId: required(argv, 1, "suite ID") as BenchmarkSuiteId, incumbentId: required(argv, 2, "incumbent harness ID") as HarnessId, candidateId: required(argv, 3, "candidate harness ID") as HarnessId };
    case "scorecards": return { kind: "scorecard.list", requestId: id, projectId: required(argv, 1, "project ID") as ProjectId, page: page(argv, 2) };
    case "scorecard": return { kind: "scorecard.get", requestId: id, scorecardId: required(argv, 1, "scorecard ID") as ScorecardId };
    case "knowledge": return { kind: "knowledge.catalog", requestId: id, query: { projectId: required(argv, 1, "project ID") as ProjectId, text: required(argv, 2, "search text"), tags: csv(argv[3]), relevantPaths: csv(argv[4]) as readonly RelativePath[], limit: positiveInteger(argv[5] ?? "50", "limit") } };
    case "knowledge-read": return { kind: "knowledge.read", requestId: id, projectId: required(argv, 1, "project ID") as ProjectId, documentId: required(argv, 2, "document ID") as KnowledgeDocumentId };
    case "marketplace": return { kind: "marketplace.search", requestId: id, query: { text: required(argv, 1, "search text"), kinds: enumValues(csv(argv[2]), MARKETPLACE_KINDS, "marketplace kind"), states: enumValues(csv(argv[3]), SEARCHABLE_STATES, "marketplace state"), limit: positiveInteger(argv[4] ?? "50", "limit") } };
    case "marketplace-transition": {
      const expected = required(argv, 2, "expected state");
      const next = required(argv, 3, "next state");
      if (!TRANSITION_STATES.includes(expected as MarketplaceState) || !TRANSITION_STATES.includes(next as MarketplaceState)) throw new Error("Invalid marketplace state");
      return { kind: "marketplace.transition", requestId: id, request: { artifactId: required(argv, 1, "artifact ID") as MarketplaceArtifactId, expectedState: expected as MarketplaceState, nextState: next as MarketplaceState, reason: reason(argv, 4) } };
    }
    case "harness": return { kind: "harness.get", requestId: id, harnessId: required(argv, 1, "harness ID") as HarnessId };
    case "harnesses": return { kind: "harness.list", requestId: id, projectId: required(argv, 1, "project ID") as ProjectId, page: page(argv, 2) };
    case "rollback-harness": return { kind: "harness.rollback", requestId: id, projectId: required(argv, 1, "project ID") as ProjectId, targetHarnessId: required(argv, 2, "harness ID") as HarnessId, reason: reason(argv, 3) };
    case "pin-harness": return { kind: "harness.pin", requestId: id, projectId: required(argv, 1, "project ID") as ProjectId, targetHarnessId: required(argv, 2, "harness ID") as HarnessId, reason: reason(argv, 3) };
    default: throw new Error(`Unknown command: ${command}`);
  }
}

async function watch(argv: readonly string[], client: OmegaClient): Promise<number> {
  const sessionId = required(argv, 1, "session ID") as SessionId;
  const after = integer(argv[2], 0, "after sequence");
  const iterator = client.events(sessionId, after)[Symbol.asyncIterator]();
  let interrupted = false;
  const interrupt = (): void => {
    interrupted = true;
    void iterator.return?.();
  };
  process.once("SIGINT", interrupt);
  try {
    while (!interrupted) {
      const next = await iterator.next();
      if (next.done) break;
      process.stdout.write(`${JSON.stringify(next.value)}\n`);
    }
    return interrupted ? 130 : 0;
  } finally {
    process.off("SIGINT", interrupt);
    await iterator.return?.();
  }
}

export const runCli: RunCli = async (argv, client) => {
  try {
    const command = argv[0];
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      process.stdout.write(`${HELP}\n`);
      return 0;
    }
    if (command === "watch") return await watch(argv, client);
    const response = await client.request(createRequest(argv));
    process.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);
    return response.result.ok ? 0 : 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Omega client failed";
    process.stderr.write(`omega: ${message}\n`);
    return 1;
  }
};
