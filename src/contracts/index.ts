/**
 * FROZEN CONTRACT — immutable once fan-out has started.
 * If this contract is wrong or incomplete, STOP and report to the orchestrator;
 * do not amend locally. Local amendments cause parallel implementers to diverge.
 *
 * This module contains types and signatures only. It owns every cross-module shape.
 * Feature modules may import this contract; they must not redefine its wire types.
 */

// -----------------------------------------------------------------------------
// Primitive wire types
// -----------------------------------------------------------------------------

declare const brand: unique symbol;

export type Brand<T, Name extends string> = T & {
  readonly [brand]: Name;
};

export type ProjectId = Brand<string, "ProjectId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type SessionId = Brand<string, "SessionId">;
export type ThreadId = Brand<string, "ThreadId">;
export type EventId = Brand<string, "EventId">;
export type ProcessId = Brand<string, "ProcessId">;
export type ModelStreamId = Brand<string, "ModelStreamId">;
export type ChildId = Brand<string, "ChildId">;
export type HarnessId = Brand<string, "HarnessId">;
export type ComponentId = Brand<string, "ComponentId">;
export type ObjectHash = Brand<string, "ObjectHash">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type KnowledgeDocumentId = Brand<string, "KnowledgeDocumentId">;
export type MarketplaceArtifactId = Brand<string, "MarketplaceArtifactId">;
export type EvolutionJobId = Brand<string, "EvolutionJobId">;
export type BenchmarkSuiteId = Brand<string, "BenchmarkSuiteId">;
export type BenchmarkTaskId = Brand<string, "BenchmarkTaskId">;
export type BenchmarkRunId = Brand<string, "BenchmarkRunId">;
export type ScorecardId = Brand<string, "ScorecardId">;
export type RequestId = Brand<string, "RequestId">;
export type PolicyEscalationId = Brand<string, "PolicyEscalationId">;

/** ISO-8601 UTC timestamp with millisecond precision. */
export type Timestamp = Brand<string, "Timestamp">;
/** Non-negative integer milliseconds. */
export type DurationMs = Brand<number, "DurationMs">;
/** Non-negative integer byte count. */
export type ByteCount = Brand<number, "ByteCount">;
/** Non-negative integer token count. */
export type TokenCount = Brand<number, "TokenCount">;
/** Non-negative integer micro-US-dollars; avoids floating-point currency. */
export type UsdMicros = Brand<number, "UsdMicros">;
/** SHA-256 lowercase hexadecimal digest. */
export type Sha256 = Brand<string, "Sha256">;
/** Repository-relative POSIX path with no `..` segments. */
export type RelativePath = Brand<string, "RelativePath">;
/** Absolute host path. It must never be sent to an untrusted remote client. */
export type AbsolutePath = Brand<string, "AbsolutePath">;
/** Name only; the associated credential value never crosses the contract. */
export type CredentialEnvName = Brand<string, "CredentialEnvName">;

/**
 * Genuinely open JSON transported to providers or persisted as opaque metadata.
 * The named recursive type is intentional; `unknown` and `any` are forbidden.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export type Page<T> = {
  readonly items: readonly T[];
  /** Null means this is the final page. */
  readonly nextCursor: string | null;
};

export type PageRequest = {
  /** Null means start at the first item. */
  readonly cursor: string | null;
  readonly limit: number;
};

// -----------------------------------------------------------------------------
// Error taxonomy
// -----------------------------------------------------------------------------

export type CallerAction =
  | "fix-request"
  | "reread-and-retry"
  | "retry-with-backoff"
  | "refresh-version-and-retry"
  | "request-new-child"
  | "choose-different-route"
  | "propagate"
  | "abort";

export type ValidationError = {
  readonly kind: "validation";
  readonly message: string;
  readonly field: string | null;
  readonly recoverable: true;
  readonly callerAction: "fix-request";
};

export type NotFoundError = {
  readonly kind: "not-found";
  readonly resource: string;
  readonly id: string;
  readonly recoverable: false;
  readonly callerAction: "propagate";
};

export type ConflictError = {
  readonly kind: "conflict";
  readonly resource: string;
  readonly expected: string;
  readonly actual: string;
  readonly recoverable: true;
  readonly callerAction: "refresh-version-and-retry";
};

export type StaleReadError = {
  readonly kind: "stale-read";
  readonly path: RelativePath;
  readonly expectedSha: Sha256;
  readonly actualSha: Sha256;
  readonly recoverable: true;
  readonly callerAction: "reread-and-retry";
};

export type UnauthorizedError = {
  readonly kind: "unauthorized";
  readonly message: string;
  readonly recoverable: false;
  readonly callerAction: "abort";
};

export type CapabilityDeniedError = {
  readonly kind: "capability-denied";
  readonly capability: CapabilityKind;
  readonly reason: string;
  readonly recoverable: true;
  readonly callerAction: "request-new-child";
};

export type PolicyDeniedError = {
  readonly kind: "policy-denied";
  readonly reason: string;
  readonly ruleId: string;
  readonly recoverable: false;
  readonly callerAction: "abort";
};

export type HarnessVersionMismatchError = {
  readonly kind: "harness-version-mismatch";
  readonly expected: HarnessId;
  readonly active: HarnessId;
  readonly recoverable: true;
  readonly callerAction: "refresh-version-and-retry";
};

export type ProcessNotRunningError = {
  readonly kind: "process-not-running";
  readonly processId: ProcessId;
  readonly state: ProcessState;
  readonly recoverable: false;
  readonly callerAction: "propagate";
};

export type ProcessInterruptedError = {
  readonly kind: "process-interrupted";
  readonly processId: ProcessId;
  readonly outputPreserved: true;
  readonly recoverable: true;
  readonly callerAction: "propagate";
};

export type ProviderRateLimitedError = {
  readonly kind: "provider-rate-limited";
  readonly providerId: string;
  /** Null means the provider supplied no retry duration. */
  readonly retryAfterMs: DurationMs | null;
  readonly recoverable: true;
  readonly callerAction: "retry-with-backoff";
};

export type ProviderUnavailableError = {
  readonly kind: "provider-unavailable";
  readonly providerId: string;
  readonly reason: string;
  readonly recoverable: true;
  readonly callerAction: "choose-different-route";
};

export type BudgetExceededError = {
  readonly kind: "budget-exceeded";
  readonly budget: "wall-time" | "model-calls" | "tokens" | "cost" | "processes";
  readonly limit: number;
  readonly observed: number;
  readonly recoverable: false;
  readonly callerAction: "abort";
};

export type IntegrityError = {
  readonly kind: "integrity-failure";
  readonly resource: string;
  readonly expected: Sha256;
  readonly actual: Sha256;
  readonly recoverable: false;
  readonly callerAction: "abort";
};

export type ProtocolError = {
  readonly kind: "protocol-error";
  readonly protocol: "runner-jsonl" | "session-jsonl" | "http" | "sse";
  readonly message: string;
  readonly recoverable: false;
  readonly callerAction: "abort";
};

export type IoError = {
  readonly kind: "io-error";
  readonly operation: string;
  readonly code: string | null;
  readonly recoverable: boolean;
  readonly callerAction: "retry-with-backoff" | "propagate" | "abort";
};

export type UnsupportedError = {
  readonly kind: "unsupported";
  readonly feature: string;
  readonly recoverable: false;
  readonly callerAction: "propagate";
};

/** Sanitized boundary error. Diagnostic details are stored behind `diagnosticArtifactId`. */
export type InternalError = {
  readonly kind: "internal";
  readonly message: "An internal Omega error occurred";
  readonly diagnosticArtifactId: ArtifactId;
  readonly recoverable: false;
  readonly callerAction: "propagate";
};

export type OmegaError =
  | ValidationError
  | NotFoundError
  | ConflictError
  | StaleReadError
  | UnauthorizedError
  | CapabilityDeniedError
  | PolicyDeniedError
  | HarnessVersionMismatchError
  | ProcessNotRunningError
  | ProcessInterruptedError
  | ProviderRateLimitedError
  | ProviderUnavailableError
  | BudgetExceededError
  | IntegrityError
  | ProtocolError
  | IoError
  | UnsupportedError
  | InternalError;

export type StoreError = NotFoundError | ConflictError | IntegrityError | IoError | ValidationError;
export type SessionError = StoreError | ProtocolError | CapabilityDeniedError;
export type ProcessError =
  | ValidationError
  | CapabilityDeniedError
  | PolicyDeniedError
  | ProcessNotRunningError
  | ProcessInterruptedError
  | BudgetExceededError
  | UnsupportedError
  | IoError;
export type ModelError =
  | ValidationError
  | CapabilityDeniedError
  | ProviderRateLimitedError
  | ProviderUnavailableError
  | BudgetExceededError
  | ProtocolError;
export type HarnessError =
  | StoreError
  | HarnessVersionMismatchError
  | CapabilityDeniedError
  | ProtocolError;
export type KnowledgeError = StoreError | StaleReadError | CapabilityDeniedError;
export type ContextError = HarnessError | KnowledgeError;
export type EvolutionError = HarnessError | SessionError | ModelError | BudgetExceededError;
export type ApiError =
  | UnauthorizedError
  | ValidationError
  | NotFoundError
  | ConflictError
  | CapabilityDeniedError
  | PolicyDeniedError
  | HarnessVersionMismatchError
  | ProviderRateLimitedError
  | ProviderUnavailableError
  | BudgetExceededError
  | UnsupportedError
  | InternalError;

// -----------------------------------------------------------------------------
// Configuration schema
// -----------------------------------------------------------------------------

export type AutonomyProfile = "manual" | "guarded" | "autonomous";
export type ModelRole =
  | "main-coder"
  | "fast-policy"
  | "harness-mutator"
  | "promotion-evaluator"
  | "diagnostician"
  | "crystallizer";

export type ReasoningSetting =
  | { readonly mode: "off" }
  | { readonly mode: "effort"; readonly effort: "low" | "medium" | "high" | "xhigh" }
  | { readonly mode: "token-budget"; readonly maxTokens: TokenCount };

export type OpenRouterSelection = {
  readonly kind: "openrouter";
  readonly mode: "balanced" | "nitro" | "exacto" | "ordered";
  /** Empty means OpenRouter chooses eligible providers. */
  readonly providerOrder: readonly string[];
  readonly allowFallbacks: boolean;
  readonly requireParameters: boolean;
  readonly dataCollection: "allow" | "deny";
  /** Null means do not filter on zero-data-retention status. */
  readonly zeroDataRetention: boolean | null;
};

export type GenericProviderSelection = {
  readonly kind: "provider-defined";
  /** Intentionally open JSON because third-party AI SDK providers define this surface. */
  readonly options: JsonObject;
};

export type ProviderSelection = OpenRouterSelection | GenericProviderSelection;

export type ProviderConfig = {
  readonly providerId: string;
  readonly adapter: "openrouter" | "openai-compatible" | "ai-sdk-provider" | "local-openai-compatible";
  readonly baseUrl: string;
  /** Null means this provider requires no credential. */
  readonly credentialEnvName: CredentialEnvName | null;
};

export type ModelListPrice = {
  readonly inputUsdMicrosPerMillionTokens: UsdMicros;
  readonly cachedInputUsdMicrosPerMillionTokens: UsdMicros;
  readonly outputUsdMicrosPerMillionTokens: UsdMicros;
};

export type ModelRoleRoute = {
  readonly role: ModelRole;
  readonly providerId: string;
  /** Provider-owned model slug; deliberately not a closed enum. */
  readonly modelId: string;
  readonly reasoning: ReasoningSetting;
  readonly selection: ProviderSelection;
  /** Null delegates sampling to the model/provider default. */
  readonly temperature: number | null;
  /** Null delegates nucleus sampling to the model/provider default. */
  readonly topP: number | null;
  /** Null means deterministic seeding is unavailable or intentionally disabled. */
  readonly seed: number | null;
  readonly contextLimit: TokenCount;
  readonly maxOutputTokens: TokenCount;
  readonly timeoutMs: DurationMs;
  /** Frozen comparison price; provider charge remains separately reported by ModelUsage. */
  readonly equivalentListPrice: ModelListPrice;
};

export type BenchmarkBudget = {
  readonly wallTimeMs: DurationMs;
  readonly maxModelCalls: number;
  readonly maxInputTokens: TokenCount;
  readonly maxOutputTokens: TokenCount;
  readonly maxCostUsdMicros: UsdMicros;
  readonly maxProcessStarts: number;
};

export type PolicyHardRule =
  | { readonly id: string; readonly kind: "deny-capabilities"; readonly capabilities: readonly CapabilityKind[] }
  | { readonly id: string; readonly kind: "escalate-capabilities"; readonly capabilities: readonly CapabilityKind[] }
  | { readonly id: string; readonly kind: "deny-path-prefixes"; readonly pathPrefixes: readonly RelativePath[] }
  | { readonly id: string; readonly kind: "deny-network-hosts"; readonly hosts: readonly string[] }
  | { readonly id: string; readonly kind: "maximum-process-timeout"; readonly maximum: DurationMs };

export type OmegaConfig = {
  readonly schemaVersion: 1;
  readonly homeDirectory: {
    readonly kind: "user-home-relative";
    readonly path: ".omega";
  };
  readonly server: {
    readonly host: "127.0.0.1" | "::1";
    readonly port: number;
    readonly bearerTokenEnvName: CredentialEnvName;
    readonly requestPath: "/api/v1/requests";
    readonly sessionEventsPathTemplate: "/api/v1/sessions/:sessionId/events";
    readonly healthPath: "/healthz";
    readonly authScheme: "bearer";
    readonly protocolVersion: 1;
  };
  readonly storage: {
    readonly fsyncEvents: boolean;
    readonly objectHash: "sha256";
    /** Null means retain indefinitely. */
    readonly sessionRetentionDays: number | null;
  };
  readonly processes: {
    readonly maxConcurrent: number;
    readonly liveChunkBytes: ByteCount;
    readonly gracefulShutdownMs: DurationMs;
    readonly orphanPolicy: "verify-and-terminate";
    /** `auto` selects an installed backend that can enforce the requested SandboxSpec. */
    readonly sandboxBackend: "auto" | "docker" | "podman";
    readonly defaultImage: string;
    readonly defaultContainerUser: string;
    readonly workspaceMountPath: AbsolutePath;
  };
  readonly sessions: {
    readonly defaultPolicyProfile: AutonomyProfile;
    readonly mainCapabilities: CapabilityTemplate;
    readonly credentialEnvNames: readonly CredentialEnvName[];
  };
  readonly models: {
    readonly providers: readonly ProviderConfig[];
    readonly routes: readonly ModelRoleRoute[];
  };
  readonly policy: {
    readonly profile: AutonomyProfile;
    readonly uncertainty: "deny" | "escalate";
    readonly policyRole: "fast-policy";
    /** Evaluated in order before model classification; first matching deny/escalate wins. */
    readonly hardRules: readonly PolicyHardRule[];
  };
  readonly benchmarks: {
    readonly developmentSuiteId: BenchmarkSuiteId;
    readonly maxConcurrentRuns: number;
    readonly developmentPromotionPolicy: PromotionEvalPolicy;
    /** Null means every benchmark manifest must declare its own budget. */
    readonly fallbackBudget: BenchmarkBudget | null;
  };
};

// -----------------------------------------------------------------------------
// Projects, workspaces, objects, and artifacts
// -----------------------------------------------------------------------------

export type RepositoryIdentity = {
  /** Normalized remote URL when present; null for repositories without a remote. */
  readonly canonicalRemote: string | null;
  readonly initialRootHash: Sha256;
};

export type ProjectRecord = {
  readonly id: ProjectId;
  readonly displayName: string;
  readonly repository: RepositoryIdentity;
  /** Null only during atomic first-project bootstrap; tasks cannot start until initialized. */
  readonly activeHarnessId: HarnessId | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
};

export type WorkspaceRecord = {
  readonly id: WorkspaceId;
  readonly projectId: ProjectId;
  readonly path: AbsolutePath;
  readonly registeredAt: Timestamp;
  readonly lastSeenAt: Timestamp;
};

export type ObjectDescriptor = {
  readonly hash: ObjectHash;
  readonly size: ByteCount;
  readonly mediaType: string;
  readonly createdAt: Timestamp;
};

export type ArtifactKind =
  | "patch"
  | "handoff"
  | "process-stdout"
  | "process-stderr"
  | "model-response"
  | "diagnostic"
  | "benchmark-report"
  | "workspace-snapshot"
  | "harness-export";

export type ArtifactRecord = {
  readonly id: ArtifactId;
  readonly kind: ArtifactKind;
  readonly object: ObjectDescriptor;
  readonly sessionId: SessionId;
  readonly createdAt: Timestamp;
  readonly metadata: JsonObject;
};

export type ArtifactSlice = {
  readonly artifact: ArtifactRecord;
  readonly range: ByteRange;
  readonly encoding: "utf8" | "base64";
  readonly data: string;
  readonly complete: boolean;
};

// -----------------------------------------------------------------------------
// Processes and file interlocks
// -----------------------------------------------------------------------------

export type ProcessState = "starting" | "running" | "exited" | "cancelled" | "interrupted";
export type ProcessStream = "stdout" | "stderr";

export type SandboxSpec = {
  readonly filesystem: "workspace-read-only" | "workspace-read-write";
  readonly network: "none" | "allowlist" | "unrestricted";
  /** Empty unless `network` is `allowlist`; entries are DNS names, not URLs. */
  readonly allowedHosts: readonly string[];
  readonly memoryLimitBytes: ByteCount;
  readonly cpuTimeLimitMs: DurationMs;
  readonly runtime: {
    readonly kind: "oci";
    readonly image: string;
    /** Null allows a local image name; the backend must still record the resolved digest. */
    readonly expectedImageDigest: Sha256 | null;
    readonly containerUser: string;
    readonly workspaceMountPath: AbsolutePath;
  };
};

export type SandboxRuntimeIdentity = {
  readonly backend: "docker" | "podman";
  readonly backendVersion: string;
  readonly image: string;
  readonly imageDigest: Sha256;
  readonly containerUser: string;
};

export type ProcessSpec = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: AbsolutePath;
  /** Names are injected from the daemon environment; values are never part of the spec. */
  readonly credentialEnvNames: readonly CredentialEnvName[];
  readonly stdin: "closed" | "pipe";
  /** Null means the process has no invocation timeout. */
  readonly timeoutMs: DurationMs | null;
  readonly sandbox: SandboxSpec;
  readonly harnessId: HarnessId;
  readonly sessionId: SessionId;
};

export type ProcessHandle = {
  readonly id: ProcessId;
  readonly state: "starting" | "running";
  readonly harnessId: HarnessId;
  readonly sandbox: SandboxRuntimeIdentity;
  readonly startedAt: Timestamp;
};

export type ByteRange = {
  readonly startInclusive: ByteCount;
  readonly endExclusive: ByteCount;
};

export type StreamSlice = {
  readonly stream: ProcessStream;
  readonly range: ByteRange;
  readonly encoding: "utf8" | "base64";
  readonly data: string;
};

export type ProcessObservation = {
  readonly processId: ProcessId;
  readonly state: ProcessState;
  readonly slices: readonly StreamSlice[];
  readonly observedAt: Timestamp;
};

export type ProcessCompletion = {
  readonly processId: ProcessId;
  readonly state: "exited" | "cancelled" | "interrupted";
  /** Null means the process did not exit normally. */
  readonly exitCode: number | null;
  /** Null means the host did not report a terminating signal. */
  readonly signal: string | null;
  readonly durationMs: DurationMs;
  readonly stdout: ObjectDescriptor;
  readonly stderr: ObjectDescriptor;
};

export type ProcessOutputEvent = {
  readonly processId: ProcessId;
  readonly stream: ProcessStream;
  readonly range: ByteRange;
  readonly encoding: "utf8" | "base64";
  readonly data: string;
};

export type ProcessInput =
  | { readonly kind: "data"; readonly encoding: "utf8" | "base64"; readonly data: string }
  | { readonly kind: "close-stdin" }
  | { readonly kind: "signal"; readonly signal: "SIGINT" | "SIGTERM" | "SIGHUP" };

export type FileReadResult = {
  readonly path: RelativePath;
  readonly content: string;
  readonly sha: Sha256;
  readonly size: ByteCount;
};

export type FileWriteRequest = {
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly path: RelativePath;
  /** Null means create only if the path does not exist. */
  readonly expectedSha: Sha256 | null;
  readonly content: string;
};

export type FileWriteResult = {
  readonly path: RelativePath;
  readonly previousSha: Sha256 | null;
  readonly sha: Sha256;
  readonly size: ByteCount;
};

// -----------------------------------------------------------------------------
// Model routing and streaming
// -----------------------------------------------------------------------------

export type ModelRouteSignature = {
  readonly role: ModelRole;
  readonly providerId: string;
  readonly modelId: string;
  readonly variant: string | null;
  /** Null until the provider reports the actual serving endpoint. */
  readonly servingProvider: string | null;
  /** Null when the provider does not disclose quantization. */
  readonly quantization: string | null;
  readonly reasoning: ReasoningSetting;
  readonly temperature: number | null;
  readonly topP: number | null;
  readonly seed: number | null;
  readonly contextLimit: TokenCount;
  readonly outputLimit: TokenCount;
  readonly equivalentListPrice: ModelListPrice;
};

export type ModelTextPart = { readonly kind: "text"; readonly text: string };
export type ModelReasoningPart = { readonly kind: "reasoning"; readonly text: string };
export type ModelToolCallPart = {
  readonly kind: "tool-call";
  readonly callId: string;
  readonly toolName: string;
  readonly input: JsonObject;
};
export type ModelToolResultPart = {
  readonly kind: "tool-result";
  readonly callId: string;
  readonly toolName: string;
  readonly result: JsonValue;
  readonly isError: boolean;
};
export type ModelContentPart = ModelTextPart | ModelReasoningPart | ModelToolCallPart | ModelToolResultPart;

export type ModelMessage =
  | { readonly role: "system" | "user"; readonly content: readonly (ModelTextPart | ModelToolResultPart)[] }
  | { readonly role: "assistant"; readonly content: readonly ModelContentPart[] }
  | { readonly role: "tool"; readonly content: readonly ModelToolResultPart[] };

export type ToolSchema = {
  readonly name: string;
  readonly description: string;
  /** JSON Schema is intentionally open JSON and validated by the model-routing module. */
  readonly inputSchema: JsonObject;
};

export type ModelRequest = {
  readonly sessionId: SessionId;
  readonly harnessId: HarnessId;
  readonly role: ModelRole;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolSchema[];
  readonly maxOutputTokens: TokenCount;
  readonly abortAfterMs: DurationMs;
};

export type ModelUsage = {
  readonly inputTokens: TokenCount;
  readonly cachedInputTokens: TokenCount;
  readonly reasoningTokens: TokenCount;
  readonly outputTokens: TokenCount;
  readonly costUsdMicros: UsdMicros;
};

export type ModelCompletion = {
  readonly streamId: ModelStreamId;
  readonly providerGenerationId: string | null;
  readonly route: ModelRouteSignature;
  readonly content: readonly ModelContentPart[];
  readonly usage: ModelUsage;
  readonly startedAt: Timestamp;
  readonly firstTokenAt: Timestamp | null;
  readonly completedAt: Timestamp;
  readonly finishReason: "stop" | "tool-calls" | "length" | "content-filter" | "cancelled" | "error";
};

export type ModelStreamEvent =
  | { readonly kind: "text-delta"; readonly streamId: ModelStreamId; readonly delta: string }
  | { readonly kind: "reasoning-delta"; readonly streamId: ModelStreamId; readonly delta: string }
  | { readonly kind: "tool-call"; readonly streamId: ModelStreamId; readonly call: ModelToolCallPart }
  | { readonly kind: "usage"; readonly streamId: ModelStreamId; readonly usage: ModelUsage }
  | { readonly kind: "completed"; readonly completion: ModelCompletion }
  | { readonly kind: "failed"; readonly streamId: ModelStreamId; readonly error: ModelError; readonly partialArtifactId: ArtifactId | null };

export interface ModelStream {
  readonly id: ModelStreamId;
  readonly route: ModelRouteSignature;
  readonly events: AsyncIterable<ModelStreamEvent>;
  cancel(reason: string): Promise<void>;
}

// -----------------------------------------------------------------------------
// Capabilities and execution policy
// -----------------------------------------------------------------------------

export type CapabilityKind =
  | "model-call"
  | "read-files"
  | "write-files"
  | "start-process"
  | "process-input"
  | "network-egress"
  | "inject-credential"
  | "spawn-child"
  | "write-knowledge"
  | "install-marketplace"
  | "publish-marketplace"
  | "manage-marketplace"
  | "create-harness-candidate"
  | "run-promotion-eval"
  | "activate-harness";

export type CapabilityGrant =
  | { readonly kind: "read-files" | "write-files"; readonly pathPrefixes: readonly RelativePath[] }
  | { readonly kind: "start-process"; /** Empty permits any executable present inside the enforced sandbox. */ readonly executableNames: readonly string[] }
  | { readonly kind: "process-input" | "spawn-child" | "write-knowledge" | "install-marketplace" | "publish-marketplace" | "manage-marketplace" | "create-harness-candidate" | "run-promotion-eval" | "activate-harness" }
  | { readonly kind: "network-egress"; readonly allowedHosts: readonly string[] }
  | { readonly kind: "inject-credential"; readonly credentialEnvNames: readonly CredentialEnvName[] };

export type CapabilityEnvelope = {
  readonly grants: readonly CapabilityGrant[];
  readonly modelRoles: readonly ModelRole[];
  readonly maxCostUsdMicros: UsdMicros;
  readonly maxModelCalls: number;
  readonly maxProcessStarts: number;
  readonly maxInputTokens: TokenCount;
  readonly maxOutputTokens: TokenCount;
  readonly wallTimeMs: DurationMs;
  readonly createdAt: Timestamp;
};

export type CapabilityTemplate = Omit<CapabilityEnvelope, "createdAt">;

export type ActionFacts =
  | { readonly kind: "process"; readonly executable: string; readonly args: readonly string[]; readonly cwd: AbsolutePath; readonly credentialEnvNames: readonly CredentialEnvName[]; readonly sandbox: SandboxSpec }
  | { readonly kind: "file-write"; readonly workspaceId: WorkspaceId; readonly path: RelativePath; readonly expectedSha: Sha256 | null }
  | { readonly kind: "process-input"; readonly processId: ProcessId; readonly input: ProcessInput }
  | { readonly kind: "child-spawn"; readonly parentSessionId: SessionId; readonly requestedGrants: readonly CapabilityGrant[] }
  | { readonly kind: "knowledge-write"; readonly projectId: ProjectId; readonly documentId: KnowledgeDocumentId; readonly expectedSha: Sha256 | null }
  | { readonly kind: "marketplace-install"; readonly artifactId: MarketplaceArtifactId; readonly state: MarketplaceState }
  | { readonly kind: "marketplace-publish"; readonly artifactId: MarketplaceArtifactId; readonly sourceProjectId: ProjectId }
  | { readonly kind: "marketplace-transition"; readonly artifactId: MarketplaceArtifactId; readonly from: MarketplaceState; readonly to: MarketplaceState }
  | { readonly kind: "marketplace-activate"; readonly artifactId: MarketplaceArtifactId; readonly projectId: ProjectId; readonly candidateHarnessId: HarnessId; readonly canaryOutcome: "healthy" }
  | { readonly kind: "harness-candidate"; readonly projectId: ProjectId; readonly componentKinds: readonly ComponentKind[] }
  | { readonly kind: "promotion-eval"; readonly projectId: ProjectId; readonly suiteId: BenchmarkSuiteId; readonly incumbentId: HarnessId; readonly candidateId: HarnessId }
  | { readonly kind: "harness-activation"; readonly projectId: ProjectId; readonly incumbentId: HarnessId; readonly candidateId: HarnessId };

export type PolicyDecision =
  | { readonly outcome: "allow"; readonly reason: string; readonly constraints: readonly string[] }
  | { readonly outcome: "deny"; readonly reason: string; readonly ruleId: string }
  | { readonly outcome: "escalate"; readonly reason: string; readonly escalationId: PolicyEscalationId };

export type PolicyEscalation = {
  readonly id: PolicyEscalationId;
  readonly sessionId: SessionId;
  readonly facts: ActionFacts;
  readonly reason: string;
  readonly state: "pending" | "resolved";
  readonly resolution: "allow" | "deny" | null;
  readonly createdAt: Timestamp;
  readonly resolvedAt: Timestamp | null;
};

export type PolicyResolutionRequest = {
  readonly escalationId: PolicyEscalationId;
  readonly resolution: "allow" | "deny";
  readonly reason: string;
};

export type PolicyEvaluation = {
  readonly sessionId: SessionId;
  readonly facts: ActionFacts;
  readonly capabilityEnvelope: CapabilityEnvelope;
  readonly profile: AutonomyProfile;
};

// -----------------------------------------------------------------------------
// Harnesses, components, runner protocol, and activation
// -----------------------------------------------------------------------------

export type ComponentKind = "runner" | "tool" | "connector" | "skill" | "workflow" | "context-compiler" | "promotion-evaluator" | "policy-prompt";
export type ComponentRuntime = "node" | "python" | "bash" | "native" | "document";

export type ComponentManifest = {
  readonly id: ComponentId;
  readonly kind: ComponentKind;
  readonly runtime: ComponentRuntime;
  readonly objectHash: ObjectHash;
  readonly entrypoint: string;
  readonly credentialEnvNames: readonly CredentialEnvName[];
  readonly capabilities: readonly CapabilityKind[];
};

export type HarnessManifest = {
  readonly id: HarnessId;
  readonly projectId: ProjectId;
  readonly alias: string;
  readonly parents: readonly HarnessId[];
  readonly components: readonly ComponentManifest[];
  readonly sourceArtifacts: readonly ArtifactId[];
  readonly createdAt: Timestamp;
};

export type HarnessUpdate = {
  readonly projectId: ProjectId;
  readonly previousHarnessId: HarnessId;
  readonly activeHarnessId: HarnessId;
  readonly reason: "promotion" | "rollback" | "manual-pin";
  readonly scorecardId: ScorecardId | null;
  readonly activatedAt: Timestamp;
};

export type ProjectInstruction = {
  readonly path: RelativePath;
  /** Repository directory governed by this file; deeper scopes take precedence. */
  readonly scope: RelativePath;
  readonly content: string;
  readonly sha: Sha256;
};

export type SkillCatalogEntry = {
  readonly componentId: ComponentId;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly relevantPaths: readonly RelativePath[];
};

export type SkillDocument = {
  readonly componentId: ComponentId;
  readonly objectHash: ObjectHash;
  readonly catalog: SkillCatalogEntry;
  readonly markdown: string;
};

export type RunnerBootstrapContext = {
  /** Ordered from repository root to the deepest lexical scope. */
  readonly instructions: readonly ProjectInstruction[];
  readonly knowledgeCatalog: readonly KnowledgeCatalogEntry[];
  readonly skillCatalog: readonly SkillCatalogEntry[];
};

export type RunnerStart = {
  readonly session: SessionHeader;
  readonly workspace: WorkspaceRecord;
  readonly harness: HarnessManifest;
  readonly handoffArtifactId: ArtifactId | null;
};

export type RunnerRequest =
  | { readonly kind: "context.bootstrap"; readonly requestId: RequestId }
  | { readonly kind: "skill.read"; readonly requestId: RequestId; readonly harnessId: HarnessId; readonly componentId: ComponentId }
  | { readonly kind: "model.start"; readonly requestId: RequestId; readonly request: ModelRequest }
  | { readonly kind: "process.start"; readonly requestId: RequestId; readonly spec: ProcessSpec }
  | { readonly kind: "process.observe"; readonly requestId: RequestId; readonly processId: ProcessId; readonly after: readonly { readonly stream: ProcessStream; readonly offset: ByteCount }[] }
  | { readonly kind: "process.input"; readonly requestId: RequestId; readonly processId: ProcessId; readonly input: ProcessInput }
  | { readonly kind: "process.cancel"; readonly requestId: RequestId; readonly processId: ProcessId; readonly reason: string }
  | { readonly kind: "artifact.read"; readonly requestId: RequestId; readonly artifactId: ArtifactId; readonly offset: ByteCount; readonly limit: ByteCount }
  | { readonly kind: "file.read"; readonly requestId: RequestId; readonly workspaceId: WorkspaceId; readonly path: RelativePath }
  | { readonly kind: "file.write"; readonly requestId: RequestId; readonly request: FileWriteRequest }
  | { readonly kind: "child.spawn"; readonly requestId: RequestId; readonly request: SpawnChildRequest }
  | { readonly kind: "child.observe"; readonly requestId: RequestId; readonly sessionId: SessionId }
  | { readonly kind: "knowledge.catalog"; readonly requestId: RequestId; readonly query: KnowledgeQuery }
  | { readonly kind: "knowledge.read"; readonly requestId: RequestId; readonly documentId: KnowledgeDocumentId }
  | { readonly kind: "knowledge.write"; readonly requestId: RequestId; readonly request: KnowledgeWriteRequest }
  | { readonly kind: "marketplace.search"; readonly requestId: RequestId; readonly query: MarketplaceQuery }
  | { readonly kind: "marketplace.install"; readonly requestId: RequestId; readonly artifactId: MarketplaceArtifactId }
  | { readonly kind: "harness.evolve"; readonly requestId: RequestId; readonly request: EvolutionRequest }
  | { readonly kind: "harness.status"; readonly requestId: RequestId; readonly projectId: ProjectId }
  | { readonly kind: "evolution.observe"; readonly requestId: RequestId; readonly jobId: EvolutionJobId }
  | { readonly kind: "evolution.cancel"; readonly requestId: RequestId; readonly jobId: EvolutionJobId; readonly reason: string }
  | { readonly kind: "session.complete"; readonly requestId: RequestId; readonly outcome: SessionOutcome };

export type RunnerReply =
  | { readonly kind: "request.rejected"; readonly requestId: RequestId; readonly error: HarnessVersionMismatchError }
  | { readonly kind: "context.bootstrapped"; readonly requestId: RequestId; readonly result: Result<RunnerBootstrapContext, ContextError> }
  | { readonly kind: "skill.read"; readonly requestId: RequestId; readonly result: Result<SkillDocument, ContextError> }
  | { readonly kind: "model.started"; readonly requestId: RequestId; readonly result: Result<{ readonly streamId: ModelStreamId; readonly route: ModelRouteSignature }, ModelError> }
  | { readonly kind: "process.started"; readonly requestId: RequestId; readonly result: Result<ProcessHandle, ProcessError> }
  | { readonly kind: "process.observed"; readonly requestId: RequestId; readonly result: Result<ProcessObservation, ProcessError> }
  | { readonly kind: "process.input-accepted"; readonly requestId: RequestId; readonly result: Result<{ readonly acceptedBytes: ByteCount }, ProcessError> }
  | { readonly kind: "process.cancelled"; readonly requestId: RequestId; readonly result: Result<ProcessCompletion, ProcessError> }
  | { readonly kind: "artifact.read"; readonly requestId: RequestId; readonly result: Result<ArtifactSlice, SessionError> }
  | { readonly kind: "file.read"; readonly requestId: RequestId; readonly result: Result<FileReadResult, StoreError | CapabilityDeniedError> }
  | { readonly kind: "file.written"; readonly requestId: RequestId; readonly result: Result<FileWriteResult, StoreError | StaleReadError | CapabilityDeniedError | PolicyDeniedError> }
  | { readonly kind: "child.spawned"; readonly requestId: RequestId; readonly result: Result<ChildSessionRecord, SessionError> }
  | { readonly kind: "child.observed"; readonly requestId: RequestId; readonly result: Result<ChildSessionRecord, SessionError> }
  | { readonly kind: "knowledge.catalogued"; readonly requestId: RequestId; readonly result: Result<readonly KnowledgeCatalogEntry[], KnowledgeError> }
  | { readonly kind: "knowledge.read"; readonly requestId: RequestId; readonly result: Result<KnowledgeDocument, KnowledgeError> }
  | { readonly kind: "knowledge.written"; readonly requestId: RequestId; readonly result: Result<KnowledgeDocument, KnowledgeError> }
  | { readonly kind: "marketplace.found"; readonly requestId: RequestId; readonly result: Result<readonly MarketplaceArtifact[], KnowledgeError> }
  | { readonly kind: "marketplace.installed"; readonly requestId: RequestId; readonly result: Result<MarketplaceInstallation, KnowledgeError> }
  | { readonly kind: "harness.evolution-started"; readonly requestId: RequestId; readonly result: Result<EvolutionJob, EvolutionError> }
  | { readonly kind: "harness.status"; readonly requestId: RequestId; readonly result: Result<HarnessManifest, HarnessError> }
  | { readonly kind: "evolution.observed"; readonly requestId: RequestId; readonly result: Result<EvolutionJob, EvolutionError> }
  | { readonly kind: "evolution.cancelled"; readonly requestId: RequestId; readonly result: Result<EvolutionJob, EvolutionError> }
  | { readonly kind: "session.completed"; readonly requestId: RequestId; readonly result: Result<SessionRecord, SessionError> };

export type KernelToRunnerEvent =
  | { readonly kind: "model.event"; readonly event: ModelStreamEvent }
  | { readonly kind: "process.output"; readonly event: ProcessOutputEvent }
  | { readonly kind: "process.completed"; readonly completion: ProcessCompletion }
  | { readonly kind: "child.completed"; readonly child: ChildSessionRecord; readonly resultArtifactId: ArtifactId }
  | { readonly kind: "policy.resolved"; readonly escalation: PolicyEscalation }
  | { readonly kind: "harness.updated"; readonly update: HarnessUpdate }
  | { readonly kind: "daemon.shutdown"; readonly deadline: Timestamp };

export type RunnerToKernelMessage =
  | { readonly kind: "runner.ready"; readonly harnessId: HarnessId }
  | { readonly kind: "runner.request"; readonly request: RunnerRequest }
  | { readonly kind: "runner.protocol-error"; readonly error: ProtocolError };

export type KernelToRunnerMessage =
  | { readonly kind: "kernel.start"; readonly start: RunnerStart }
  | { readonly kind: "kernel.reply"; readonly reply: RunnerReply }
  | { readonly kind: "kernel.event"; readonly event: KernelToRunnerEvent };

export type RunnerToKernelEnvelope = {
  readonly protocol: "omega-runner-jsonl";
  readonly version: 1;
  readonly message: RunnerToKernelMessage;
};

export type KernelToRunnerEnvelope = {
  readonly protocol: "omega-runner-jsonl";
  readonly version: 1;
  readonly message: KernelToRunnerMessage;
};

// -----------------------------------------------------------------------------
// Sessions, child sessions, handoffs, and semantic events
// -----------------------------------------------------------------------------

export type SessionState = "starting" | "running" | "waiting" | "completed" | "failed" | "cancelled";
export type SessionRole = "main" | "task" | "evolution" | "promotion-eval" | "diagnostician" | "crystallizer";
export type SessionOutcome = "succeeded" | "failed" | "cancelled";

export type SessionContinuation = {
  readonly sourceSessionId: SessionId;
  readonly handoffArtifactId: ArtifactId;
  readonly contextArtifactIds: readonly ArtifactId[];
};

export type SessionHeader = {
  readonly id: SessionId;
  readonly threadId: ThreadId;
  readonly parentSessionId: SessionId | null;
  readonly continuation: SessionContinuation | null;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly role: SessionRole;
  readonly objective: string;
  readonly initialHarnessId: HarnessId;
  readonly initialModelRoutes: readonly ModelRouteSignature[];
  readonly policyProfile: AutonomyProfile;
  readonly capabilityEnvelope: CapabilityEnvelope;
  readonly credentialEnvNames: readonly CredentialEnvName[];
  readonly eventSchemaVersion: 1;
  readonly createdAt: Timestamp;
};

export type SessionRecord = {
  readonly header: SessionHeader;
  readonly state: SessionState;
  readonly lastSequence: number;
  readonly completedAt: Timestamp | null;
  readonly outcome: SessionOutcome | null;
};

export type HandoffRecord = {
  readonly artifactId: ArtifactId;
  readonly sourceSessionId: SessionId;
  readonly objective: string;
  readonly progress: string;
  readonly decisions: readonly string[];
  readonly unresolvedWork: readonly string[];
  readonly relevantArtifactIds: readonly ArtifactId[];
  readonly processStates: readonly { readonly processId: ProcessId; readonly state: ProcessState }[];
  readonly observedFiles: readonly { readonly path: RelativePath; readonly sha: Sha256 }[];
  readonly harnessId: HarnessId;
  readonly createdAt: Timestamp;
};

export type SpawnChildRequest = {
  readonly parentSessionId: SessionId;
  readonly role: Exclude<SessionRole, "main">;
  readonly objective: string;
  readonly contextArtifactIds: readonly ArtifactId[];
  readonly capabilityEnvelope: CapabilityEnvelope;
};

export type ChildSessionRecord = {
  readonly childId: ChildId;
  readonly sessionId: SessionId;
  readonly parentSessionId: SessionId;
  readonly spawnEventId: EventId;
  readonly role: Exclude<SessionRole, "main">;
  readonly state: SessionState;
};

export type PersistedEventPayload =
  | { readonly kind: "session.started" }
  | { readonly kind: "runner.started"; readonly harnessId: HarnessId; readonly processId: ProcessId }
  | { readonly kind: "runner.stopped"; readonly harnessId: HarnessId; readonly outcome: "exited" | "cancelled" | "interrupted" }
  | { readonly kind: "model.started"; readonly streamId: ModelStreamId; readonly route: ModelRouteSignature }
  | { readonly kind: "model.completed"; readonly completion: ModelCompletion; readonly aggregateArtifactId: ArtifactId }
  | { readonly kind: "model.failed"; readonly streamId: ModelStreamId; readonly error: ModelError; readonly partialArtifactId: ArtifactId | null }
  | { readonly kind: "policy.decided"; readonly facts: ActionFacts; readonly decision: PolicyDecision }
  | { readonly kind: "policy.escalated"; readonly escalation: PolicyEscalation }
  | { readonly kind: "policy.resolved"; readonly escalation: PolicyEscalation }
  | { readonly kind: "process.started"; readonly handle: ProcessHandle; readonly spec: ProcessSpec; readonly stdoutArtifactId: ArtifactId; readonly stderrArtifactId: ArtifactId }
  | { readonly kind: "process.observed"; readonly processId: ProcessId; readonly ranges: readonly { readonly stream: ProcessStream; readonly range: ByteRange }[] }
  | { readonly kind: "process.completed"; readonly completion: ProcessCompletion }
  | { readonly kind: "child.spawned"; readonly child: ChildSessionRecord }
  | { readonly kind: "child.completed"; readonly child: ChildSessionRecord; readonly resultArtifactId: ArtifactId }
  | { readonly kind: "artifact.recorded"; readonly artifact: ArtifactRecord }
  | { readonly kind: "knowledge.updated"; readonly documentId: KnowledgeDocumentId; readonly objectHash: ObjectHash }
  | { readonly kind: "marketplace.published"; readonly artifactId: MarketplaceArtifactId; readonly state: MarketplaceState }
  | { readonly kind: "evolution.updated"; readonly jobId: EvolutionJobId; readonly state: EvolutionState }
  | { readonly kind: "benchmark.completed"; readonly runId: BenchmarkRunId; readonly outcome: BenchmarkOutcome }
  | { readonly kind: "harness.updated"; readonly update: HarnessUpdate }
  | { readonly kind: "handoff.created"; readonly handoff: HandoffRecord }
  | { readonly kind: "session.recovered"; readonly interruptedProcessIds: readonly ProcessId[] }
  | { readonly kind: "session.completed"; readonly outcome: SessionOutcome };

export type SessionEvent = {
  readonly id: EventId;
  readonly sequence: number;
  readonly at: Timestamp;
  readonly harnessId: HarnessId;
  readonly payload: PersistedEventPayload;
};

/** Live-only deltas are never appended to `events.jsonl`. */
export type LiveEventEnvelope =
  | { readonly kind: "session-event"; readonly sessionId: SessionId; readonly event: SessionEvent }
  | { readonly kind: "model-delta"; readonly sessionId: SessionId; readonly event: ModelStreamEvent }
  | { readonly kind: "process-output"; readonly sessionId: SessionId; readonly event: ProcessOutputEvent }
  | { readonly kind: "harness-nudge"; readonly sessionId: SessionId; readonly update: HarnessUpdate };

// -----------------------------------------------------------------------------
// Project knowledge and local marketplace
// -----------------------------------------------------------------------------

export type KnowledgeFrontmatter = {
  readonly id: KnowledgeDocumentId;
  readonly title: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly confidence: number;
  readonly verifiedAt: Timestamp;
  readonly sourceSessionIds: readonly SessionId[];
  readonly sourceArtifactIds: readonly ArtifactId[];
  readonly relevantPaths: readonly RelativePath[];
  /** Empty means no automatic invalidation rule is known. */
  readonly invalidationConditions: readonly string[];
};

export type KnowledgeDocument = {
  readonly projectId: ProjectId;
  readonly frontmatter: KnowledgeFrontmatter;
  readonly markdown: string;
  readonly sha: Sha256;
};

export type KnowledgeCatalogEntry = Pick<KnowledgeFrontmatter, "id" | "title" | "summary" | "tags" | "confidence" | "verifiedAt" | "relevantPaths">;

export type KnowledgeQuery = {
  readonly projectId: ProjectId;
  readonly text: string;
  readonly tags: readonly string[];
  readonly relevantPaths: readonly RelativePath[];
  readonly limit: number;
};

export type KnowledgeWriteRequest = {
  readonly projectId: ProjectId;
  readonly document: Omit<KnowledgeDocument, "sha">;
  /** Null creates a new document; otherwise compare-and-swap against this SHA. */
  readonly expectedSha: Sha256 | null;
};

export type MarketplaceState = "experimental" | "proven" | "deprecated" | "quarantined";
export type MarketplaceArtifactKind = "harness" | "tool" | "connector" | "skill" | "workflow" | "component-delta";

export type MarketplaceCompatibility = {
  readonly omegaSchemaVersions: readonly 1[];
  readonly operatingSystems: readonly ("linux" | "darwin" | "windows")[];
  readonly runtimes: readonly ComponentRuntime[];
  readonly requiredExecutables: readonly string[];
};

export type MarketplaceArtifact = {
  readonly id: MarketplaceArtifactId;
  readonly kind: MarketplaceArtifactKind;
  readonly state: MarketplaceState;
  readonly title: string;
  readonly summary: string;
  readonly objectHash: ObjectHash;
  readonly componentIds: readonly ComponentId[];
  readonly sourceProjectId: ProjectId;
  readonly sourceHarnessId: HarnessId;
  readonly scorecardIds: readonly ScorecardId[];
  readonly credentialEnvNames: readonly CredentialEnvName[];
  readonly compatibility: MarketplaceCompatibility;
  readonly publishedAt: Timestamp;
};

export type MarketplaceTransitionRequest = {
  readonly artifactId: MarketplaceArtifactId;
  readonly expectedState: MarketplaceState;
  readonly nextState: MarketplaceState;
  readonly reason: string;
};

export type MarketplaceQuery = {
  readonly text: string;
  readonly kinds: readonly MarketplaceArtifactKind[];
  readonly states: readonly Exclude<MarketplaceState, "quarantined">[];
  readonly limit: number;
};

export type MarketplaceCanaryEvidence = {
  readonly projectId: ProjectId;
  readonly artifactId: MarketplaceArtifactId;
  readonly candidateHarnessId: HarnessId;
  /** Must name the same candidateHarnessId and a project-scoped source. */
  readonly result: CanaryResult;
};

export type MarketplaceInstallation = {
  readonly artifactId: MarketplaceArtifactId;
  readonly projectId: ProjectId;
  readonly installedComponentIds: readonly ComponentId[];
  readonly candidateHarnessId: HarnessId;
  readonly compatibility: {
    readonly compatible: true;
    readonly omegaSchemaVersion: 1;
    readonly operatingSystem: "linux" | "darwin" | "windows";
    readonly availableRuntimes: readonly ComponentRuntime[];
  };
  readonly requiresCanary: boolean;
  readonly activation: "installed-inactive" | "active";
  /** Required before an experimental installation can become active. */
  readonly canary: MarketplaceCanaryEvidence | null;
  readonly installedAt: Timestamp;
  readonly activatedAt: Timestamp | null;
};

// -----------------------------------------------------------------------------
// Evolution, OmegaBench, Promotion Eval, and canary evidence
// -----------------------------------------------------------------------------

export type BenchmarkTaskPublic = {
  readonly id: BenchmarkTaskId;
  readonly title: string;
  readonly objective: string;
  readonly fixtureObjectHash: ObjectHash;
  readonly environmentObjectHash: ObjectHash;
  readonly budget: BenchmarkBudget;
};

export type BenchmarkTaskPrivate = {
  readonly taskId: BenchmarkTaskId;
  readonly verifierObjectHash: ObjectHash;
  readonly negativeInvariantObjectHash: ObjectHash;
  readonly diagnosticTags: readonly string[];
};

export type PromotionEvalPolicy = {
  readonly id: string;
  readonly version: string;
  readonly replicatesPerHarness: number;
  readonly thresholds: PromotionThresholds;
  readonly protectedTaskIds: readonly BenchmarkTaskId[];
  readonly workspaceBaseline: "fixture-object-hash";
  readonly comparisonOrder: readonly ["invariants", "capability", "cost", "latency"];
};

export type BenchmarkManifest = {
  readonly id: BenchmarkSuiteId;
  readonly name: string;
  readonly version: string;
  readonly tasks: readonly BenchmarkTaskPublic[];
  readonly privateTaskMetadataObjectHash: ObjectHash;
  /** Authoritative paired-run schedule and thresholds for this manifest version. */
  readonly promotionPolicy: PromotionEvalPolicy;
  readonly createdAt: Timestamp;
};

export type BenchmarkOutcome = "passed" | "failed" | "budget-exceeded" | "provider-unavailable" | "invalid-run";

export type BenchmarkMetrics = {
  readonly verifierPassed: boolean;
  readonly negativeInvariantsPassed: boolean;
  readonly usage: ModelUsage;
  readonly equivalentListPriceUsdMicros: UsdMicros;
  readonly wallTimeMs: DurationMs;
  readonly timeToFirstTokenMs: DurationMs | null;
  readonly generationTimeMs: DurationMs;
  readonly modelTurns: number;
  readonly toolCalls: number;
  readonly processStarts: number;
  readonly staleWrites: number;
  readonly policyAllows: number;
  readonly policyDenials: number;
  readonly policyEscalations: number;
  readonly retries: number;
  readonly childSessions: number;
  readonly harnessUpdates: number;
};

export type BenchmarkRun = {
  readonly id: BenchmarkRunId;
  readonly suiteId: BenchmarkSuiteId;
  readonly taskId: BenchmarkTaskId;
  readonly sessionId: SessionId;
  readonly harnessId: HarnessId;
  readonly harnessComponentObjectHashes: readonly ObjectHash[];
  readonly executionPolicyComponentId: ComponentId;
  readonly route: ModelRouteSignature;
  readonly servingProviderGenerationId: string | null;
  readonly fixtureObjectHash: ObjectHash;
  readonly environmentObjectHash: ObjectHash;
  readonly effectiveBudget: BenchmarkBudget;
  readonly benchmarkManifestVersion: string;
  readonly promotionPolicyId: string;
  readonly outcome: BenchmarkOutcome;
  readonly failureCategory: string | null;
  readonly metrics: BenchmarkMetrics;
  readonly finalDiffArtifactId: ArtifactId;
  readonly reportArtifactId: ArtifactId;
  readonly startedAt: Timestamp;
  readonly completedAt: Timestamp;
};

export type BenchmarkExecutionRequest = {
  readonly suiteId: BenchmarkSuiteId;
  readonly manifestVersion: string;
  readonly promotionPolicy: PromotionEvalPolicy;
  readonly task: BenchmarkTaskPublic;
  /** Supplied only to the trusted launcher/verifier boundary, never to the runner. */
  readonly privateTask: BenchmarkTaskPrivate;
  readonly harness: HarnessManifest;
  readonly route: ModelRouteSignature;
};

export type BenchmarkExecutionEvidence = {
  readonly sessionId: SessionId;
  readonly executionPolicyComponentId: ComponentId;
  /** Actual completed route, including serving provider and quantization. */
  readonly route: ModelRouteSignature;
  readonly servingProviderGenerationId: string | null;
  readonly outcome: BenchmarkOutcome;
  readonly failureCategory: string | null;
  readonly metrics: BenchmarkMetrics;
  readonly finalDiffArtifactId: ArtifactId;
  readonly reportArtifactId: ArtifactId;
  readonly startedAt: Timestamp;
  readonly completedAt: Timestamp;
};

/** Trusted integrator seam that materializes isolated fixtures and runs hidden verifiers. */
export interface BenchmarkRunLauncher {
  execute(request: BenchmarkExecutionRequest, signal?: AbortSignal): Promise<Result<BenchmarkExecutionEvidence, EvolutionError>>;
}

export type PairInvalidReason =
  | "different-model"
  | "different-reasoning"
  | "different-serving-provider"
  | "different-quantization"
  | "different-budget"
  | "different-fixture"
  | "different-environment"
  | "different-policy"
  | "different-component-set"
  | "unequal-replicates"
  | "provider-metadata-missing";

export type PairedTaskEvidence = {
  readonly taskId: BenchmarkTaskId;
  readonly incumbent: BenchmarkRun;
  readonly candidate: BenchmarkRun;
};

export type PairedTaskResult = PairedTaskEvidence & (
  | { readonly comparable: true; readonly invalidReason: null }
  | { readonly comparable: false; readonly invalidReason: PairInvalidReason }
);

export type PromotionDecision =
  | { readonly outcome: "promote"; readonly reason: string }
  | { readonly outcome: "reject"; readonly reason: string }
  | { readonly outcome: "insufficient-evidence"; readonly reason: string };

export type PromotionThresholds = {
  readonly minimumComparablePairs: number;
  readonly minimumSuccessRateDelta: number;
  readonly maximumProtectedRegressions: 0;
  readonly confidenceLevel: number;
};

export type PromotionScorecard = {
  readonly id: ScorecardId;
  readonly projectId: ProjectId;
  readonly suiteId: BenchmarkSuiteId;
  readonly incumbentHarnessId: HarnessId;
  readonly candidateHarnessId: HarnessId;
  readonly evaluatorHarnessId: HarnessId;
  readonly promotionPolicyId: string;
  readonly pairedResults: readonly PairedTaskResult[];
  readonly thresholds: PromotionThresholds;
  readonly observedSuccessRateDelta: number;
  readonly decision: PromotionDecision;
  readonly createdAt: Timestamp;
};

export type PromotableScorecard = Omit<PromotionScorecard, "decision"> & {
  readonly decision: Extract<PromotionDecision, { readonly outcome: "promote" }>;
};

export type EvolutionState = "queued" | "diagnosing" | "mutating" | "evaluating" | "promoted" | "rejected" | "cancelled" | "failed";

export type EvolutionRequest = {
  readonly projectId: ProjectId;
  readonly sourceSessionId: SessionId;
  readonly goal: string;
  readonly evidenceArtifactIds: readonly ArtifactId[];
  readonly allowedComponentKinds: readonly ComponentKind[];
  readonly budget: BenchmarkBudget;
};

export type EvolutionJob = {
  readonly id: EvolutionJobId;
  readonly request: EvolutionRequest;
  readonly incumbentHarnessId: HarnessId;
  readonly sessionId: SessionId;
  readonly childId: ChildId;
  readonly candidateHarnessId: HarnessId | null;
  readonly scorecardId: ScorecardId | null;
  readonly state: EvolutionState;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
};

export type CanarySource =
  | { readonly kind: "benchmark"; readonly benchmarkRunId: BenchmarkRunId }
  | { readonly kind: "project-session"; readonly sessionId: SessionId; readonly verificationArtifactId: ArtifactId };

export type CanaryResult = {
  readonly harnessId: HarnessId;
  readonly source: CanarySource;
  readonly outcome: "healthy" | "regressed";
  readonly action: "retain" | "rollback-and-quarantine";
};

// -----------------------------------------------------------------------------
// Local HTTP/SSE client contract
// -----------------------------------------------------------------------------

export type StartTaskRequest = {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly objective: string;
  readonly modelRole: "main-coder";
};

export type StartBenchmarkSessionRequest = {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly objective: string;
  readonly harnessId: HarnessId;
  readonly route: ModelRouteSignature;
  readonly policyProfile: AutonomyProfile;
  readonly capabilityEnvelope: CapabilityEnvelope;
  readonly credentialEnvNames: readonly CredentialEnvName[];
};

export type ResumeThreadRequest = {
  readonly sourceSessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly handoffArtifactId: ArtifactId;
  readonly contextArtifactIds: readonly ArtifactId[];
};

export type ClientRequest =
  | { readonly kind: "project.list"; readonly requestId: RequestId; readonly page: PageRequest }
  | { readonly kind: "project.register-workspace"; readonly requestId: RequestId; readonly path: AbsolutePath }
  | { readonly kind: "task.start"; readonly requestId: RequestId; readonly request: StartTaskRequest }
  | { readonly kind: "thread.resume"; readonly requestId: RequestId; readonly request: ResumeThreadRequest }
  | { readonly kind: "session.get"; readonly requestId: RequestId; readonly sessionId: SessionId }
  | { readonly kind: "session.list"; readonly requestId: RequestId; readonly projectId: ProjectId; readonly page: PageRequest }
  | { readonly kind: "artifact.read"; readonly requestId: RequestId; readonly artifactId: ArtifactId; readonly offset: ByteCount; readonly limit: ByteCount }
  | { readonly kind: "session.cancel"; readonly requestId: RequestId; readonly sessionId: SessionId; readonly reason: string }
  | { readonly kind: "policy.list"; readonly requestId: RequestId; readonly sessionId: SessionId; readonly state: "pending" | "resolved"; readonly page: PageRequest }
  | { readonly kind: "policy.resolve"; readonly requestId: RequestId; readonly request: PolicyResolutionRequest }
  | { readonly kind: "evolution.start"; readonly requestId: RequestId; readonly request: EvolutionRequest }
  | { readonly kind: "evolution.get"; readonly requestId: RequestId; readonly jobId: EvolutionJobId }
  | { readonly kind: "evolution.list"; readonly requestId: RequestId; readonly projectId: ProjectId; readonly page: PageRequest }
  | { readonly kind: "evolution.retry"; readonly requestId: RequestId; readonly jobId: EvolutionJobId }
  | { readonly kind: "evolution.cancel"; readonly requestId: RequestId; readonly jobId: EvolutionJobId; readonly reason: string }
  | { readonly kind: "benchmark.run-task"; readonly requestId: RequestId; readonly suiteId: BenchmarkSuiteId; readonly taskId: BenchmarkTaskId; readonly harnessId: HarnessId }
  | { readonly kind: "benchmark.run-paired"; readonly requestId: RequestId; readonly suiteId: BenchmarkSuiteId; readonly incumbentId: HarnessId; readonly candidateId: HarnessId }
  | { readonly kind: "scorecard.get"; readonly requestId: RequestId; readonly scorecardId: ScorecardId }
  | { readonly kind: "scorecard.list"; readonly requestId: RequestId; readonly projectId: ProjectId; readonly page: PageRequest }
  | { readonly kind: "knowledge.catalog"; readonly requestId: RequestId; readonly query: KnowledgeQuery }
  | { readonly kind: "knowledge.read"; readonly requestId: RequestId; readonly projectId: ProjectId; readonly documentId: KnowledgeDocumentId }
  | { readonly kind: "marketplace.search"; readonly requestId: RequestId; readonly query: MarketplaceQuery }
  | { readonly kind: "marketplace.transition"; readonly requestId: RequestId; readonly request: MarketplaceTransitionRequest }
  | { readonly kind: "harness.get"; readonly requestId: RequestId; readonly harnessId: HarnessId }
  | { readonly kind: "harness.list"; readonly requestId: RequestId; readonly projectId: ProjectId; readonly page: PageRequest }
  | { readonly kind: "harness.rollback"; readonly requestId: RequestId; readonly projectId: ProjectId; readonly targetHarnessId: HarnessId; readonly reason: string }
  | { readonly kind: "harness.pin"; readonly requestId: RequestId; readonly projectId: ProjectId; readonly targetHarnessId: HarnessId; readonly reason: string };

export type ClientResponseValue =
  | { readonly kind: "projects"; readonly page: Page<ProjectRecord> }
  | { readonly kind: "workspace.registered"; readonly workspace: WorkspaceRecord; readonly project: ProjectRecord }
  | { readonly kind: "session"; readonly session: SessionRecord }
  | { readonly kind: "sessions"; readonly page: Page<SessionRecord> }
  | { readonly kind: "artifact"; readonly slice: ArtifactSlice }
  | { readonly kind: "policy-escalation"; readonly escalation: PolicyEscalation }
  | { readonly kind: "policy-escalations"; readonly page: Page<PolicyEscalation> }
  | { readonly kind: "evolution"; readonly job: EvolutionJob }
  | { readonly kind: "evolutions"; readonly page: Page<EvolutionJob> }
  | { readonly kind: "benchmark-run"; readonly run: BenchmarkRun }
  | { readonly kind: "scorecard"; readonly scorecard: PromotionScorecard }
  | { readonly kind: "scorecards"; readonly page: Page<PromotionScorecard> }
  | { readonly kind: "knowledge-catalog"; readonly entries: readonly KnowledgeCatalogEntry[] }
  | { readonly kind: "knowledge-document"; readonly document: KnowledgeDocument }
  | { readonly kind: "marketplace-results"; readonly artifacts: readonly MarketplaceArtifact[] }
  | { readonly kind: "marketplace-artifact"; readonly artifact: MarketplaceArtifact }
  | { readonly kind: "harness"; readonly harness: HarnessManifest }
  | { readonly kind: "harnesses"; readonly page: Page<HarnessManifest> }
  | { readonly kind: "harness-update"; readonly update: HarnessUpdate };

export type ClientResponse = {
  readonly requestId: RequestId;
  readonly result: Result<ClientResponseValue, ApiError>;
};

export type SseFrame = {
  /** Decimal SessionEvent sequence for persisted events; live deltas reuse the latest persisted sequence. */
  readonly id: string;
  readonly event: "omega.live";
  readonly data: LiveEventEnvelope;
};

export type LocalHttpErrorResponse = {
  readonly error: UnauthorizedError | ValidationError | ProtocolError | InternalError;
};

/** Complete loopback HTTP surface. Both clients and the daemon implement these literal routes. */
export interface LocalApiRoutes {
  readonly "GET /": {
    readonly auth: "none";
    readonly response: { readonly contentType: "text/html; charset=utf-8"; readonly body: string };
  };
  readonly "POST /api/v1/requests": {
    readonly auth: "bearer";
    readonly body: ClientRequest;
    readonly response: ClientResponse;
    readonly boundaryError: LocalHttpErrorResponse;
  };
  readonly "GET /api/v1/sessions/:sessionId/events": {
    readonly auth: "bearer";
    readonly params: { readonly sessionId: SessionId };
    readonly query: { readonly afterSequence: number };
    readonly response: AsyncIterable<SseFrame>;
    readonly boundaryError: LocalHttpErrorResponse;
  };
  readonly "GET /healthz": {
    readonly auth: "none";
    readonly response: { readonly status: "ok"; readonly protocolVersion: 1 };
  };
}

export interface HttpServerHandle {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  stop(deadline: Timestamp): Promise<Result<void, IoError>>;
}

// -----------------------------------------------------------------------------
// Module service interfaces
// -----------------------------------------------------------------------------

export interface ObjectStore {
  put(mediaType: string, chunks: AsyncIterable<Uint8Array>): Promise<Result<ObjectDescriptor, StoreError>>;
  get(hash: ObjectHash): Promise<Result<AsyncIterable<Uint8Array>, StoreError>>;
  describe(hash: ObjectHash): Promise<Result<ObjectDescriptor, StoreError>>;
}

export interface ProjectRepository {
  registerWorkspace(path: AbsolutePath): Promise<Result<{ readonly project: ProjectRecord; readonly workspace: WorkspaceRecord }, StoreError>>;
  /** Trusted benchmark-only attachment; preserves the existing project's repository identity. */
  registerBenchmarkWorkspace(projectId: ProjectId, path: AbsolutePath, fixtureHash: ObjectHash): Promise<Result<WorkspaceRecord, StoreError>>;
  getProject(id: ProjectId): Promise<Result<ProjectRecord, StoreError>>;
  getWorkspace(id: WorkspaceId): Promise<Result<WorkspaceRecord, StoreError>>;
  listProjects(page: PageRequest): Promise<Result<Page<ProjectRecord>, StoreError>>;
  compareAndSetActiveHarness(projectId: ProjectId, expected: HarnessId | null, next: HarnessId, commitGuard?: () => boolean): Promise<Result<ProjectRecord, StoreError>>;
}

export interface SessionRepository {
  create(header: SessionHeader): Promise<Result<SessionRecord, SessionError>>;
  get(id: SessionId): Promise<Result<SessionRecord, SessionError>>;
  list(projectId: ProjectId, page: PageRequest): Promise<Result<Page<SessionRecord>, SessionError>>;
  append(id: SessionId, expectedSequence: number, payload: PersistedEventPayload, harnessId: HarnessId, reservedEventId: EventId | null): Promise<Result<SessionEvent, SessionError>>;
  read(id: SessionId, afterSequence: number, limit: number): Promise<Result<readonly SessionEvent[], SessionError>>;
  recordArtifact(record: ArtifactRecord): Promise<Result<ArtifactRecord, SessionError>>;
  readArtifact(id: ArtifactId, offset: ByteCount, limit: ByteCount): Promise<Result<ArtifactSlice, SessionError>>;
}

export interface FileService {
  read(workspaceId: WorkspaceId, path: RelativePath, capabilities: CapabilityEnvelope): Promise<Result<FileReadResult, StoreError | CapabilityDeniedError>>;
  write(request: FileWriteRequest, capabilities: CapabilityEnvelope): Promise<Result<FileWriteResult, StoreError | StaleReadError | CapabilityDeniedError | PolicyDeniedError>>;
}

export interface ProcessSupervisor {
  start(spec: ProcessSpec, capabilities: CapabilityEnvelope): Promise<Result<ProcessHandle, ProcessError>>;
  observe(processId: ProcessId, after: readonly { readonly stream: ProcessStream; readonly offset: ByteCount }[]): Promise<Result<ProcessObservation, ProcessError>>;
  input(processId: ProcessId, input: ProcessInput): Promise<Result<{ readonly acceptedBytes: ByteCount }, ProcessError>>;
  cancel(processId: ProcessId, reason: string): Promise<Result<ProcessCompletion, ProcessError>>;
  listActive(sessionId: SessionId): Promise<Result<readonly ProcessHandle[], ProcessError>>;
  recoverOrphans(): Promise<Result<readonly ProcessId[], ProcessError>>;
  shutdown(deadline: Timestamp): Promise<Result<readonly ProcessCompletion[], ProcessError>>;
}

export interface ModelRouter {
  resolve(role: ModelRole): Promise<Result<ModelRouteSignature, ModelError>>;
  stream(request: ModelRequest, capabilities: CapabilityEnvelope): Promise<Result<ModelStream, ModelError>>;
}

export interface ExecutionPolicy {
  evaluate(evaluation: PolicyEvaluation): Promise<Result<PolicyDecision, ValidationError | ModelError>>;
  getEscalation(id: PolicyEscalationId): Promise<Result<PolicyEscalation, NotFoundError>>;
  listEscalations(sessionId: SessionId, state: "pending" | "resolved", page: PageRequest): Promise<Result<Page<PolicyEscalation>, NotFoundError | ValidationError>>;
  resolve(request: PolicyResolutionRequest): Promise<Result<PolicyEscalation, NotFoundError | ConflictError | ValidationError>>;
}

export interface SessionService {
  startTask(request: StartTaskRequest): Promise<Result<SessionRecord, SessionError | HarnessError | ModelError>>;
  /** Starts an isolated benchmark session without changing the project's active harness pointer. */
  startBenchmarkTask(request: StartBenchmarkSessionRequest): Promise<Result<SessionRecord, SessionError | HarnessError | ModelError>>;
  resumeThread(request: ResumeThreadRequest): Promise<Result<SessionRecord, SessionError | HarnessError>>;
  spawnChild(request: SpawnChildRequest): Promise<Result<ChildSessionRecord, SessionError | HarnessError>>;
  complete(sessionId: SessionId, outcome: SessionOutcome): Promise<Result<SessionRecord, SessionError>>;
  /** Completes a session at the runner protocol boundary without stopping the runner before its reply is delivered. */
  completeFromRunner(sessionId: SessionId, outcome: SessionOutcome): Promise<Result<SessionRecord, SessionError>>;
  cancel(sessionId: SessionId, reason: string): Promise<Result<SessionRecord, SessionError | ProcessError>>;
  createHandoff(sessionId: SessionId): Promise<Result<HandoffRecord, SessionError>>;
  recordRunnerEvent(sessionId: SessionId, payload: PersistedEventPayload, harnessId: HarnessId): Promise<Result<SessionEvent, SessionError>>;
  publishRunnerEvent(event: LiveEventEnvelope): void;
  subscribe(sessionId: SessionId, afterSequence: number): AsyncIterable<LiveEventEnvelope>;
}

export interface HarnessRepository {
  putComponent(component: ComponentManifest): Promise<Result<ComponentManifest, HarnessError>>;
  putHarness(manifest: HarnessManifest): Promise<Result<HarnessManifest, HarnessError>>;
  getHarness(id: HarnessId): Promise<Result<HarnessManifest, HarnessError>>;
  getActiveHarness(projectId: ProjectId): Promise<Result<HarnessManifest, HarnessError>>;
  listProjectHarnesses(projectId: ProjectId, page: PageRequest): Promise<Result<Page<HarnessManifest>, HarnessError>>;
}

export interface RunnerHost {
  start(start: RunnerStart): Promise<Result<ProcessHandle, HarnessError | ProcessError>>;
  send(sessionId: SessionId, envelope: KernelToRunnerEnvelope): Promise<Result<void, HarnessError | ProcessError>>;
  receive(sessionId: SessionId): AsyncIterable<RunnerToKernelEnvelope>;
  stop(sessionId: SessionId, reason: string): Promise<Result<ProcessCompletion, HarnessError | ProcessError>>;
}

/** Daemon-owned pump that consumes each launched runner's request stream exactly once. */
export interface RunnerProtocolDispatcher {
  start(sessionId: SessionId): void;
  stop(sessionId: SessionId): Promise<void>;
}

export interface HarnessActivationService {
  promote(scorecard: PromotableScorecard, commitGuard?: () => boolean): Promise<Result<HarnessUpdate, HarnessError>>;
  pin(projectId: ProjectId, target: HarnessId, reason: string): Promise<Result<HarnessUpdate, HarnessError>>;
  rollback(projectId: ProjectId, target: HarnessId, reason: string): Promise<Result<HarnessUpdate, HarnessError>>;
}

export interface KnowledgeService {
  catalog(query: KnowledgeQuery): Promise<Result<readonly KnowledgeCatalogEntry[], KnowledgeError>>;
  read(projectId: ProjectId, id: KnowledgeDocumentId): Promise<Result<KnowledgeDocument, KnowledgeError>>;
  write(request: KnowledgeWriteRequest, capabilities: CapabilityEnvelope): Promise<Result<KnowledgeDocument, KnowledgeError>>;
}

export interface ContextService {
  bootstrap(workspace: WorkspaceRecord, harness: HarnessManifest): Promise<Result<RunnerBootstrapContext, ContextError>>;
  readSkill(harnessId: HarnessId, componentId: ComponentId): Promise<Result<SkillDocument, ContextError>>;
}

export interface MarketplaceService {
  search(query: MarketplaceQuery): Promise<Result<readonly MarketplaceArtifact[], KnowledgeError>>;
  publish(artifact: MarketplaceArtifact): Promise<Result<MarketplaceArtifact, KnowledgeError>>;
  install(projectId: ProjectId, artifactId: MarketplaceArtifactId, capabilities: CapabilityEnvelope): Promise<Result<MarketplaceInstallation, KnowledgeError>>;
  activateInstallation(evidence: MarketplaceCanaryEvidence, capabilities: CapabilityEnvelope): Promise<Result<MarketplaceInstallation, KnowledgeError | ValidationError>>;
  transition(request: MarketplaceTransitionRequest, capabilities: CapabilityEnvelope): Promise<Result<MarketplaceArtifact, KnowledgeError>>;
  quarantine(artifactId: MarketplaceArtifactId, reason: string): Promise<Result<MarketplaceArtifact, KnowledgeError>>;
}

export interface EvolutionService {
  start(request: EvolutionRequest, capabilities: CapabilityEnvelope): Promise<Result<EvolutionJob, EvolutionError>>;
  retry(id: EvolutionJobId): Promise<Result<EvolutionJob, EvolutionError>>;
  get(id: EvolutionJobId): Promise<Result<EvolutionJob, EvolutionError>>;
  list(projectId: ProjectId, page: PageRequest): Promise<Result<Page<EvolutionJob>, EvolutionError>>;
  cancel(id: EvolutionJobId, reason: string): Promise<Result<EvolutionJob, EvolutionError>>;
}

export interface BenchmarkService {
  getManifest(id: BenchmarkSuiteId): Promise<Result<BenchmarkManifest, EvolutionError>>;
  runTask(suiteId: BenchmarkSuiteId, taskId: BenchmarkTaskId, harnessId: HarnessId, route: ModelRouteSignature): Promise<Result<BenchmarkRun, EvolutionError>>;
  /** The evaluator is derived from the incumbent harness; callers cannot supply it. */
  runPaired(suiteId: BenchmarkSuiteId, incumbentId: HarnessId, candidateId: HarnessId, signal?: AbortSignal): Promise<Result<PromotionScorecard, EvolutionError>>;
  getScorecard(id: ScorecardId): Promise<Result<PromotionScorecard, EvolutionError>>;
  listScorecards(projectId: ProjectId, page: PageRequest): Promise<Result<Page<PromotionScorecard>, EvolutionError>>;
  recordCanary(harnessId: HarnessId, source: CanarySource): Promise<Result<CanaryResult, EvolutionError>>;
}

export interface OmegaClient {
  request(request: ClientRequest): Promise<ClientResponse>;
  events(sessionId: SessionId, afterSequence: number): AsyncIterable<LiveEventEnvelope>;
}

export interface OmegaApplication {
  execute(request: ClientRequest): Promise<ClientResponse>;
  events(sessionId: SessionId, afterSequence: number): AsyncIterable<LiveEventEnvelope>;
  recordDiagnostic(input: { readonly boundary: "application" | "http" | "sse"; readonly message: string; readonly stack: string | null; readonly at: Timestamp }): Promise<Result<ArtifactId, IoError>>;
  start(): Promise<Result<void, InternalError | IoError | ValidationError>>;
  stop(deadline: Timestamp): Promise<Result<void, InternalError | IoError>>;
}

// Exact concrete-module export signatures used by the sole integrator.
export type EnvironmentVariables = Readonly<Record<string, string | undefined>>;
export type CreateFileObjectStore = (root: AbsolutePath) => ObjectStore;
export type CreateFileProjectRepository = (root: AbsolutePath, objects: ObjectStore) => ProjectRepository;
export type CreateFileSessionRepository = (root: AbsolutePath, objects: ObjectStore) => SessionRepository;
export type CreateModelRouter = (config: OmegaConfig["models"], environment: EnvironmentVariables) => ModelRouter;
export type CreateExecutionPolicy = (config: OmegaConfig["policy"], models: ModelRouter, stateRoot: AbsolutePath) => ExecutionPolicy;
export type CreateProcessRuntime = (options: {
  readonly config: OmegaConfig["processes"];
  readonly environment: EnvironmentVariables;
  readonly projects: ProjectRepository;
  readonly sessions: SessionRepository;
  readonly objects: ObjectStore;
  readonly policy: ExecutionPolicy;
}) => { readonly processes: ProcessSupervisor; readonly files: FileService };
export type CreateHarnessRepository = (root: AbsolutePath, objects: ObjectStore, projects: ProjectRepository) => HarnessRepository;
export type CreateRunnerHost = (processes: ProcessSupervisor, harnesses: HarnessRepository) => RunnerHost;
export type CreateHarnessActivationService = (projects: ProjectRepository, harnesses: HarnessRepository) => HarnessActivationService;
export type CreateInitialHarness = (project: ProjectRecord, objects: ObjectStore, projects: ProjectRepository) => Promise<Result<HarnessManifest, HarnessError>>;
export type CreateSessionService = (options: {
  readonly config: OmegaConfig["sessions"];
  readonly repository: SessionRepository;
  readonly projects: ProjectRepository;
  readonly harnesses: HarnessRepository;
  readonly runners: RunnerHost;
  readonly processes: ProcessSupervisor;
  readonly models: ModelRouter;
  readonly policy: ExecutionPolicy;
  readonly objects: ObjectStore;
  readonly runnerRequests: RunnerProtocolDispatcher;
}) => SessionService;
export type CreateRunnerProtocolDispatcher = (context: () => OmegaContext) => RunnerProtocolDispatcher;
export type CreateKnowledgeService = (root: AbsolutePath, objects: ObjectStore) => KnowledgeService;
export type CreateContextService = (options: {
  readonly objects: ObjectStore;
  readonly knowledge: KnowledgeService;
  readonly harnesses: HarnessRepository;
}) => ContextService;
export type CreateMarketplaceService = (options: {
  readonly root: AbsolutePath;
  readonly objects: ObjectStore;
  readonly harnesses: HarnessRepository;
  readonly activation: HarnessActivationService;
}) => MarketplaceService;
export type CreateBenchmarkService = (options: {
  readonly root: AbsolutePath;
  readonly objects: ObjectStore;
  readonly sessions: SessionService;
  readonly harnesses: HarnessRepository;
  readonly activation: HarnessActivationService;
  readonly launcher: BenchmarkRunLauncher;
}) => BenchmarkService;
export type CreateEvolutionService = (options: {
  readonly root: AbsolutePath;
  readonly objects: ObjectStore;
  readonly repository: SessionRepository;
  readonly sessions: SessionService;
  readonly harnesses: HarnessRepository;
  readonly benchmarks: BenchmarkService;
  readonly activation: HarnessActivationService;
}) => EvolutionService;
export type CreateOmegaBenchManifest = (policy: PromotionEvalPolicy) => BenchmarkManifest;
export type CreateOmegaClient = (baseUrl: string, bearerToken: string) => OmegaClient;
export type RunCli = (argv: readonly string[], client: OmegaClient) => Promise<number>;
export type RenderHtmlApp = (config: OmegaConfig["server"]) => string;
export type CreateOmegaApplication = (config: OmegaConfig, environment: EnvironmentVariables) => OmegaApplication;
export type StartHttpServer = (application: OmegaApplication, config: OmegaConfig["server"], environment: EnvironmentVariables) => Promise<Result<HttpServerHandle, IoError | ValidationError>>;

/**
 * The sole wiring context. Leaf modules receive only the interfaces they need;
 * the daemon-integrator constructs this complete object and owns shutdown order.
 */
export interface OmegaContext {
  readonly config: OmegaConfig;
  readonly objects: ObjectStore;
  readonly projects: ProjectRepository;
  readonly sessionRepository: SessionRepository;
  readonly files: FileService;
  readonly processes: ProcessSupervisor;
  readonly models: ModelRouter;
  readonly policy: ExecutionPolicy;
  readonly sessions: SessionService;
  readonly harnesses: HarnessRepository;
  readonly runners: RunnerHost;
  readonly runnerRequests: RunnerProtocolDispatcher;
  readonly activation: HarnessActivationService;
  readonly knowledge: KnowledgeService;
  readonly context: ContextService;
  readonly marketplace: MarketplaceService;
  readonly evolution: EvolutionService;
  readonly benchmarks: BenchmarkService;
}

/**
 * ## Decision Log
 *
 * - Expected failures use `Result`: operational branches remain exhaustive and do not depend on thrown error text.
 * - IDs and units are branded: session/project confusion and milliseconds/token/currency mixups become compile errors.
 * - JSON openness is named and localized: provider metadata and JSON Schema are truly provider-defined; all other shapes are closed.
 * - Currency uses micro-dollars: benchmark comparison never relies on floating-point money.
 * - Session deltas are split from persisted events: raw chunks stream live and remain in sidecars rather than bloating JSONL.
 * - Model route signatures include serving provider: OpenRouter-routed runs cannot be compared across different backends by accident.
 * - Child capabilities are immutable values: authority expansion creates a new child instead of mutating an existing audit trail.
 * - Escalated runner requests defer their reply: resolution emits `policy.resolved`, then the original request completes with its normal success or `policy-denied` result.
 * - The runner protocol owns typed request/reply unions: Node, Python, Bash, and native runners can share one JSONL protocol.
 * - Benchmark public/private shapes are separate: the task runner never receives verifier code or diagnostic labels.
 * - `OmegaContext` is the only broad wiring surface: leaf modules import the contract, not each other's concrete classes.
 */
