# Module: evolution-benchmarks

## Owns

`src/evolution/evolution-service.ts`, `benchmark-service.ts`, `promotion-evaluator.ts`, `canary-monitor.ts`, `omega-bench-manifest.ts`, and `evolution-benchmarks.test.ts`.

## Implements

Implement `EvolutionService` and `BenchmarkService`. Evolution is a child session, produces content-addressed candidates, supports observe/cancel, runs model-marked paired evaluations, derives the evaluator from the incumbent, creates lexicographic scorecards, and reports automatic promotion or rejection. Canary evidence may come from benchmark runs or verified project sessions.

Export both factories and `createOmegaBenchManifest` as specified in `docs/implementation/runtime-contract.md`. `createBenchmarkService` consumes the injected trusted `BenchmarkRunLauncher`; it never exposes private verifier metadata to the runner. The manifest's promotion policy is authoritative for replicates, thresholds, protected tasks, and baseline evidence.

## Edge cases and gates

Test hidden-verifier separation, fixture hash mismatch, route/provider/quantization mismatch invalidation, free-route availability classification, budget exhaustion, unequal pair counts, threshold boundaries, protected regression, candidate evaluator tampering, cancellation during each phase, and rollback/quarantine on project-session regression. The initial OmegaBench manifest contains ten diagnostic cases but no secret verifier content visible to runners.
