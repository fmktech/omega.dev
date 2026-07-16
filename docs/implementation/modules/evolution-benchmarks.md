# Module: evolution-benchmarks

## Owns

`src/evolution/evolution-service.ts`, `benchmark-service.ts`, `promotion-evaluator.ts`, `canary-monitor.ts`, `omega-bench-manifest.ts`, and `evolution-benchmarks.test.ts`.

## Implements

Implement `EvolutionService` and `BenchmarkService`. Evolution is a child session, produces content-addressed candidates, supports observe/cancel, runs model-marked paired evaluations, derives the evaluator from the incumbent, creates lexicographic scorecards, and reports automatic promotion or rejection. Canary evidence may come from benchmark runs or verified project sessions.

## Edge cases and gates

Test hidden-verifier separation, fixture hash mismatch, route/provider/quantization mismatch invalidation, free-route availability classification, budget exhaustion, unequal pair counts, threshold boundaries, protected regression, candidate evaluator tampering, cancellation during each phase, and rollback/quarantine on project-session regression. The initial OmegaBench manifest contains ten diagnostic cases but no secret verifier content visible to runners.

