# Omega.dev contract seam inventory

This inventory precedes the frozen TypeScript contract. Every feature module may import the contract, pure-data defaults, and shared helpers. Leaf modules must not import another feature module's concrete implementation. The `daemon-integrator` module is the only module allowed broad concrete imports.

| Producer | Consumer | Contract seam |
| --- | --- | --- |
| persistence | sessions, harness-runtime, knowledge-marketplace, evolution-benchmarks | Content-addressed objects, project/workspace records, append-only session events, artifact byte streams |
| process-runtime | harness-runtime, execution-policy, daemon-integrator | Enforced sandbox specifications, process handles, live stream events, observations, input/control/cancel commands, completion records, and SHA-guarded file operations |
| model-routing | harness-runtime, execution-policy, evolution-benchmarks | Logical model roles, resolved route signature, streamed model events, aggregate usage and provider failures |
| execution-policy | process-runtime, harness-runtime, daemon-integrator | Observed action facts and allow/deny/escalate decisions constrained by immutable capabilities |
| sessions | harness-runtime, clients, daemon-integrator, evolution-benchmarks | Session/thread lifecycle, child sessions, handoffs, recovery, live semantic events |
| harness-runtime | sessions, evolution-benchmarks, clients, daemon-integrator | Harness manifests, runner protocol, activation pointer, safe-boundary version updates and rollback |
| context-bootstrap | harness-runtime, daemon-integrator | Scoped `AGENTS.md` documents, compact knowledge/installed-skill catalogs, and harness-owned full skill reads |
| knowledge-marketplace | harness-runtime, evolution-benchmarks, clients | Knowledge catalog/documents and marketplace search/install/publication artifacts |
| evolution-benchmarks | harness-runtime, sessions, clients | Evolution jobs, benchmark manifests/runs, paired scorecards, promotion decisions and canary outcomes |
| clients | daemon-integrator | Local API commands, query results, SSE event envelopes, authentication failures |
| daemon-integrator | all leaves | `OmegaContext`, parsed `OmegaConfig`, lifecycle ownership, concrete wiring and shutdown order |

## Error-channel rule

Expected operational failures cross seams as `Result<T, E>` with a closed typed error union. Implementations must not throw for a declared operational failure. Uncaught exceptions are implementation defects; the integrator converts them to a sanitized `internal` error at the API/process boundary and records diagnostic details outside the client-visible payload.

## Shared-shape ownership

All shapes named above live in `src/contracts/index.ts`, owned by no feature module. No implementer may redefine a near-equivalent local transport type. Wire data is JSON-compatible unless the contract explicitly declares a byte stream or `AsyncIterable` process boundary.
