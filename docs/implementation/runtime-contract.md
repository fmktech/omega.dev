# Omega.dev runtime integration contract

This appendix freezes the construction and transport details shared by otherwise independent implementation modules. It is normative alongside `src/contracts/index.ts` and `src/config/defaults.ts`.

## Loopback HTTP and SSE

The daemon exposes exactly four routes from `LocalApiRoutes`:

| Method and path | Authentication | Semantics |
| --- | --- | --- |
| `GET /` | None | Serves the local HTML application. Its unlock form accepts the bearer token into page memory only. |
| `POST /api/v1/requests` | `Authorization: Bearer $OMEGA_API_TOKEN` | One JSON `ClientRequest`; a well-formed request always returns HTTP 200 with one `ClientResponse`, including declared operational failures. |
| `GET /api/v1/sessions/:sessionId/events?afterSequence=N` | Same bearer header | UTF-8 `text/event-stream`; each event has `id`, `event: omega.live`, and one-line JSON `data` matching `SseFrame`. |
| `GET /healthz` | None | HTTP 200 with `{ "status": "ok", "protocolVersion": 1 }`. |

Missing or invalid authentication returns HTTP 401 with `LocalHttpErrorResponse`. Malformed JSON, an unknown request discriminator, an invalid branded-ID encoding, or an invalid query returns HTTP 400 with `LocalHttpErrorResponse`. An uncaught implementation defect returns HTTP 500 with a sanitized `InternalError`; diagnostics go to an artifact. No other HTTP surface is part of v0.

SSE reconnect starts after the supplied persisted sequence. Persisted session events use their decimal sequence as the SSE id. Live-only model/process deltas reuse the most recently persisted sequence and clients deduplicate persisted events by `(sessionId, sequence)`. A heartbeat comment may be sent every 15 seconds and is not a domain event.

## Runner JSONL

Every stdin/stdout line is one UTF-8 JSON object terminated by `\n` and matching `KernelToRunnerEnvelope` or `RunnerToKernelEnvelope`. The outer `protocol` is `omega-runner-jsonl` and `version` is `1`. Stderr is diagnostic output only and never carries protocol messages.

The host rejects an invalid envelope before dispatch. It caps one line at 1 MiB, tolerates a final partial line only by recording `ProtocolError`, and never guesses a newer version. A runner first receives `kernel.start` and must answer `runner.ready` with the same harness ID. Every `runner.request` receives exactly one matching reply, except an escalated request whose reply is deferred as documented in the contract. A stale harness call receives `request.rejected` with `HarnessVersionMismatchError`.

## Exact construction exports

Feature modules export these named factories and annotate them with the corresponding contract-owned `Create*`, `RunCli`, `RenderHtmlApp`, or `StartHttpServer` function type. Local aliases are not substitutes. Factories perform no background work until explicitly noted.

| Module | Required named exports |
| --- | --- |
| persistence | `createFileObjectStore: CreateFileObjectStore`; `createFileProjectRepository: CreateFileProjectRepository`; `createFileSessionRepository: CreateFileSessionRepository` |
| model-routing | `createModelRouter: CreateModelRouter` |
| execution-policy | `createExecutionPolicy: CreateExecutionPolicy` |
| process-runtime | `createProcessRuntime: CreateProcessRuntime` |
| harness-runtime | `createHarnessRepository: CreateHarnessRepository`; `createRunnerHost: CreateRunnerHost`; `createHarnessActivationService: CreateHarnessActivationService`; `createInitialHarness: CreateInitialHarness` |
| sessions | `createSessionService: CreateSessionService` |
| knowledge-marketplace | `createKnowledgeService: CreateKnowledgeService`; `createMarketplaceService: CreateMarketplaceService` |
| evolution-benchmarks | `createBenchmarkService: CreateBenchmarkService`; `createEvolutionService: CreateEvolutionService`; `createOmegaBenchManifest: CreateOmegaBenchManifest` |
| clients | `createOmegaClient: CreateOmegaClient`; `runCli: RunCli`; `renderHtmlApp: RenderHtmlApp` |
| daemon-integrator | `createOmegaApplication: CreateOmegaApplication`; `startHttpServer: StartHttpServer`; a `BenchmarkRunLauncher` implementation that materializes fixtures and keeps private verifier metadata outside runner messages |

The integrator resolves the home directory and constructs modules in this order: persistence, model routing, policy, process runtime, harness runtime, sessions, knowledge/marketplace, benchmark launcher, benchmark service, evolution service, application, HTTP server. A newly registered project has `activeHarnessId: null`; the integrator immediately calls `createInitialHarness`, which stores the manifest and CAS-initializes the pointer before returning registration success to a client. Shutdown reverses ownership: stop accepting HTTP, notify runners, cancel/terminate supervised processes by deadline, flush session/object state, then close the listener.

## Deterministic policy precedence

Execution policy evaluates in this order:

1. Reject a missing capability or any requested authority outside the immutable envelope.
2. Apply configured hard rules in array order; the first matching deny or escalation wins.
3. Apply the autonomy-profile matrix below.
4. Ask the fast policy model only when the deterministic layers permit the action but ambiguity remains.
5. On policy-model timeout, provider failure, malformed output, or unresolved uncertainty, apply `policy.uncertainty`; the default is deny.

Every side-effecting service operation first constructs the corresponding `ActionFacts` variant. An allow decision never widens capabilities or relaxes the effective sandbox.

| Profile | Deterministic behavior after capability and hard-rule checks |
| --- | --- |
| `manual` | Every `ActionFacts` value becomes a persisted escalation. |
| `guarded` | Offline/non-credentialed sandbox processes, in-workspace file writes, and process input are allowed. Networked or credentialed processes, child spawn, knowledge/marketplace mutation, candidate creation, promotion evaluation, and activation go to the fast policy model for an allow/deny decision. |
| `autonomous` | Actions inside the envelope are allowed unless facts are malformed or ambiguous; only ambiguity goes to the fast policy model. |

Process, session, and evolution cancellation are policy-exempt because they only reduce active authority and resource use. They still require exact session/project ownership and idempotent state checks.

## Sandbox construction

The daemon resolves `auto` to Docker or Podman and records backend version plus resolved image digest in every `ProcessHandle`. The workspace host path comes from `WorkspaceRecord`; it is mounted only at `SandboxSpec.runtime.workspaceMountPath` with the requested read-only/read-write mode. The backend uses the declared container user, applies CPU/memory limits, and implements `none`/allowlist/unrestricted networking without host fallback. Missing backend, image, or required enforcement returns `UnsupportedError` through `ProcessError`.

## Promotion evidence

`BenchmarkManifest.promotionPolicy` is the only source of paired-run thresholds and replicate count. Each replicate uses the same public task, fixture, environment, effective budget, route signature, and policy/component evidence. The launcher returns the actual completed route, including serving provider and quantization; the benchmark service never substitutes the requested route. `PairInvalidReason` is exhaustive; an invalid pair contributes no success or efficiency evidence. Protected tasks may not regress. Promotion proceeds lexicographically in the policy's fixed comparison order.

An experimental marketplace install creates a project-scoped candidate harness and remains inactive. Activation requires `MarketplaceCanaryEvidence` whose project, artifact, and candidate harness match the installation and whose healthy `CanaryResult` names that same harness; evidence from another installation is rejected.

## Client acceptance matrix

Both CLI and HTML clients expose project/session discovery, start/resume/cancel, pending policy resolution, harness history/pin/rollback, knowledge and marketplace browsing, evolution start/list/observe/cancel, and scorecard list/detail. The CLI reads `OMEGA_API_TOKEN` from its process environment. The HTML unlock form asks the operator for the same token and holds it only in JavaScript memory for bearer-authenticated fetch/SSE requests; refresh locks the UI again. Lists render loading, populated, empty, terminal-page, and retryable-error states. Streams render reconnecting and interrupted states without duplicating persisted events. Binary artifact slices are identified as base64 and never rendered as text. Credentials are never written to browser storage, local client config, logs, or session events.

## Mechanical presubmit

The implementation is not green until `pnpm presubmit` runs strict typecheck, production build, deterministic unit/integration tests, protocol and sandbox conformance tests, and the scripted-model end-to-end smoke flow. Live OpenRouter benchmarks remain a separate explicitly model-marked command.
