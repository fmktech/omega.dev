# TypeScript test-quality benchmark plan

## Claim under test

A project-scoped TypeScript test-authoring skill improves the defect-detection quality of tests produced for a sparse but realistic repository, without modifying production code or introducing flaky/invalid tests.

## Observable outcome

Run the same main-coder route on isolated copies of one fixture:

- incumbent: compact catalog contains no test-authoring skill;
- candidate: compact catalog contains `write-tests-typescript`, which must be read exactly once.

Both receive the same objective, files, process tools, limits, and hidden verifier. Evaluation results are never returned to either authoring run.

Primary evidence is executable: native suite pass, strict typecheck, repeated-run stability, production-source preservation, and hidden mutation kills. Gemini 3 Flash independently grades each resulting suite with `grade-tests-typescript`; its score is secondary evidence and cannot compensate for a failing executable gate.

## Fixture contract

The repository contains one asynchronous dispatch planner, a written public contract, and one weak happy-path `node:test` test. The function validates empty input and quantity boundaries, aggregates duplicate routes, enforces an injected-clock rush window, checks all capacity before reserving, handles exact capacity, computes a rush surcharge, writes observable state through an in-memory fake, and returns the injected timestamp.

## Edge-case gate

| Area | Applicability and hidden evidence |
| --- | --- |
| Empty/nullish/missing | Apply: empty shipment list must reject |
| Boundaries | Apply: units 0, 50, 51; exact remaining capacity; rush-hour edges 06:00 and 22:00 UTC |
| Invalid input | Apply: non-integer and negative units |
| Dependency failure | Apply: insufficient capacity and no partial reservations |
| Concurrency/ordering | N/A: the contract serializes gateway checks and writes; ordering itself is not public |
| Idempotency/duplicates | Apply: duplicate route lines aggregate before capacity and reservation |
| Unicode/encoding/timezone | Apply only to UTC boundary: injected clock uses UTC hours and ISO output; route identifiers are opaque |
| Runtime/configuration | Apply: Node ESM with built-in `node:test`; no network or package installation |

## Hidden mutations

Each mutation is applied alone to the frozen production source. A mutation is killed only when the generated tests exit nonzero.

1. Accept an empty shipment list.
2. Accept zero units.
3. Reject the valid maximum of 50 units.
4. Allow rush dispatch at 05:00 UTC.
5. Reject exact remaining capacity.
6. Stop aggregating duplicate-route quantities.
7. Compute a 20-cent rather than 25-cent rush surcharge per unit.
8. Reserve a route before all routes pass capacity preflight.
9. Return the real current time instead of the injected clock value.

The verifier itself must pass a mutation check: a known reference suite must kill every mutant, and the seed sparse suite must leave multiple mutants alive.

## Promotion interpretation

The candidate demonstrates useful impact only when:

- both sides preserve source, typecheck, pass natively twice, and use comparable author routes;
- candidate retrieval is exactly correct;
- candidate kills at least two more hidden mutations than the incumbent and does not kill fewer;
- Gemini returns structurally valid, model-marked grades for both artifacts.

The judge score is reported as corroborating evidence, not a sole pass/fail oracle.
