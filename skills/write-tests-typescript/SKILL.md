---
name: write-tests-typescript
description: Design and implement mutation-resistant TypeScript tests for Vitest, Jest, Node test, Mocha, and similar runners. Use when asked to add, improve, extend, or repair a TypeScript test suite, especially for branch coverage, edge cases, determinism, async behavior, or weak existing tests.
---

# Write TypeScript tests

Build confidence in observable behavior, not line coverage or internal call wiring.

## Workflow

1. Read repository instructions, `package.json`, test config, TypeScript config, setup files, target tests, and source under test.
2. State the public behavior contract. Derive expected outcomes from requirements, types, and documentation; use implementation only to discover branches and seams.
3. Before editing, enumerate applicable cases from [references/case-gate.md](references/case-gate.md). Cover high-risk behavior first.
4. Preserve production files unless the request explicitly authorizes production changes. Add or change only tests, fixtures, and test-local helpers.
5. Prefer observable outputs: returned values, thrown errors, emitted events, persisted fake state, rendered UI, and boundary requests. Do not assert call count/order/exact arguments for owned internal collaborators.
6. Use real owned objects or small stateful fakes. Stub unowned boundaries such as HTTP, clocks, randomness, filesystem, and external SDKs.
7. Use table tests for the same behavior across inputs; use separate tests for distinct behaviors. Give every test a behavior-and-scenario name.
8. Run the narrow suite and typecheck. Then perform a mutation check: name or temporarily apply one plausible production defect per behavior and prove a test goes red. Revert temporary mutations.

## TypeScript guardrails

- Use the repository's runner and assertion style; do not add a framework when one is already configured.
- Keep fixtures strongly typed. Do not use `any`, `@ts-ignore`, or unsafe casts to make setup compile.
- Await promises and asynchronous matchers. Ensure callbacks, streams, timers, and rejected promises cannot finish the test early.
- Inject/fake time and randomness whenever they influence assertions or branches.
- Set and restore environment variables, fake timers, spies, module mocks, globals, and module cache changes.
- Isolate filesystem/database/port resources per test and clean them up.
- Avoid snapshots for behavior better expressed by focused semantic assertions.
- Do not edit expected values to mirror current implementation. Use independently known examples and boundaries.

## Completion gate

Do not finish until:

- every named contract behavior maps to a test or a stated, risk-justified omission;
- empty/missing, boundary, invalid, dependency failure, ordering/concurrency, duplicate/idempotency, and encoding/timezone cases are each marked applicable or not applicable;
- every test has a concrete mutation it catches;
- tests pass in the repository's real command and typecheck;
- production source remains unchanged unless explicitly requested.

Report behaviors covered, the case-gate result, files changed, boundaries doubled, verification commands, and remaining risks.
