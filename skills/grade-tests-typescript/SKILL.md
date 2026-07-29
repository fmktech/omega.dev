---
name: grade-tests-typescript
description: Grade existing TypeScript test suites with a mechanical 100-point rubric. Use when asked to grade, score, audit, or review the quality of tests written with Vitest, Jest, Node test, Mocha, or similar runners, including coverage completeness against the source under test.
---

# Grade TypeScript tests

Grade tests; do not fix them. Read [references/rubric.md](references/rubric.md) completely before scoring. Treat it as normative.

## 1. Establish the test environment

Read every target test file in full, then read:

- the source modules under test;
- `package.json`, test-runner config, relevant `tsconfig` files, setup files, and shared fixtures;
- repository instructions that define testing conventions;
- test doubles, fixtures, snapshots, and helpers used by the target tests.

Record the runner, runtime environment, module system, fake-timer behavior, mock reset policy, and test-layer convention. If source cannot be found, flag the limitation and score coverage from test-visible evidence only.

Run the narrow test command and typecheck when safe and available. Never contact external services, mutate production data, or modify repository files.

## 2. Complete the evidence tables

Create one row per test case. Parameterized/table tests count as one test case plus their named rows when rows exercise materially different branches.

`Test id | claimed → actual layer | isolation/determinism | assertion focus B/I/N; claims verified Y/N | source paths covered | AAA/name | stability/type risks | finding ids`

Use `B` for observable behavior, `I` for implementation detail, and `N` for no meaningful assertion. A name or comment claim is verified only when an assertion would fail if that exact outcome stopped happening.

Then inventory every public behavior and meaningful branch in the source:

`Source behavior/branch (file:line) | covered by test id(s) or GAP | flip mutation and assertion that catches it`

A branch counts as covered only when one concrete mutation can be named and one assertion would fail under it. Merely executing a branch or asserting an internal mock call is not coverage.

No table cell may remain unresolved before scoring.

## 3. Classify and score

Map each defect to exactly one rubric item:

- `VIOLATION`: a stated rule is broken and costs points.
- `GAP`: required evidence is missing and costs points.
- `NIT`: useful advice outside the rubric; costs zero.

Never charge the same underlying defect twice. Start each dimension at its maximum, apply the fixed deductions, floor it at zero, and sum to 100.

## 4. Apply TypeScript-specific interpretation

- Determine the test layer by the highest boundary touched: pure/in-memory is unit; filesystem, real database, worker, queue, or multi-module runtime is component; real external service is integration.
- Treat outgoing requests as behavior when the source is an HTTP client. Treat call order, counts, and exact arguments to owned internal collaborators as implementation details.
- Accept Vitest/Jest mocks at unowned boundaries. Prefer a small fake for owned collaborators when observable state is feasible.
- Deduct for real time or randomness only when it reaches an assertion or can cause flakiness.
- Require explicit control and restoration of environment variables, fake timers, spies, module caches, globals, and temporary resources.
- Treat an unawaited promise, missing async assertion, or callback test that can finish early as a false-green stability defect.
- Judge coverage against the source contract, not line percentage. Do not award coverage when no assertion distinguishes the behavior.
- Do not deduct merely for framework choice, test classes versus functions, folder preference without a repository convention, lack of snapshots, lack of mutation tooling, or missing TDD history.

## 5. Report

Return, in this order:

1. Files graded, sources/config read, framework, and test count.
2. `Dimension | Max | Earned | Finding ids`, including total and verdict.
3. Per-test table and behavior inventory.
4. Findings in descending deduction order:
   `[F1] VIOLATION|GAP (rubric 3.1, -4) — file:line — evidence — fix: one line.`
5. Nits.
6. Caveats, including unavailable source, commands not run, config ambiguity, and directory/config classification mismatch.

Verdicts: 90–100 Exemplary; 75–89 Compliant; 50–74 Needs work; 0–49 Non-compliant.

When the caller explicitly requests machine-readable output, return exactly one JSON object with keys `total`, `verdict`, `dimensions`, `tests`, `behaviors`, `findings`, `nits`, and `caveats`. Findings must contain `id`, `classification`, `rubricId`, `deduction`, `location`, `evidence`, and `fix`.
