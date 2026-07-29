# TypeScript test-quality rubric

Version: 2026-07-20. Start each dimension at its maximum. Apply fixed deductions per finding, floor each dimension at zero, and never double-charge one defect. Findings outside this table are zero-point nits.

## D1 — Classification and execution boundary (10)

| Id | Finding | Type | Cost |
| --- | --- | --- | ---: |
| 1.1 | Test file is assigned to a lower layer/runtime than the highest boundary it touches | VIOLATION | -4/file |
| 1.2 | Repository has an explicit unit/component/integration naming or project convention and the file is unclassified | GAP | -2/file |
| 1.3 | Unit/component test contacts a real external service | VIOLATION | -6/test |
| 1.4 | Test requires a DOM, Node, worker, or edge runtime different from its configured test environment | VIOLATION | -3/file |

Over-classifying a test is a zero-point caveat unless it causes the wrong runtime or forbidden resources to load.

## D2 — Isolation and determinism (20)

| Id | Finding | Type | Cost |
| --- | --- | --- | ---: |
| 2.1 | Real time reaches an asserted value or timing-sensitive branch without an injected clock or fake timers | VIOLATION | -4/test |
| 2.2 | Uncontrolled randomness or generated identity reaches asserted output/order/snapshot | VIOLATION | -3/test |
| 2.3 | Owned internal collaborator is mocked where an in-memory fake or real object can expose behavior | VIOLATION | -3/test |
| 2.4 | Environment-dependent path reads a variable the test does not set and restore explicitly | VIOLATION | -2/test |
| 2.5 | Global, module cache, fake timer, spy, or mock state is not restored | VIOLATION | -3/test |
| 2.6 | Filesystem/database/queue dependency is shared rather than isolated per test or worker | VIOLATION | -3/test |
| 2.7 | Real-looking credential, token, or secret appears in test code or fixtures | VIOLATION | -4 each |
| 2.8 | External HTTP is simulated with a loose internal spy instead of a boundary stub/fake with explicit responses | VIOLATION | -2/test |

Do not deduct for executed-but-unasserted time/randomness unless it can plausibly change pass/fail behavior. Record a hardening nit instead.

## D3 — Assertion quality (20)

| Id | Finding | Type | Cost |
| --- | --- | --- | ---: |
| 3.1 | Assertion pins call count/order/exact arguments of an owned internal collaborator | VIOLATION | -4/test |
| 3.2 | Eager test combines independent behaviors and has multiple unrelated reasons to fail | VIOLATION | -3/test |
| 3.3 | No meaningful observable assertion, including truthiness-only or only “does not throw” | VIOLATION | -4/test |
| 3.4 | Assertion reads private state or mirrors the production algorithm/structure | VIOLATION | -3/test |
| 3.5 | Test name/comment claims a concrete outcome that no assertion distinguishes | VIOLATION | -3/test |
| 3.6 | Assertion is materially weaker than the contract, such as checking only array length or object existence | VIOLATION | -2/test |

An outgoing request is observable behavior when testing an HTTP client. For one claim, charge either unverified fidelity or an implementation-detail assertion, never both.

## D4 — Coverage completeness and defect sensitivity (30)

| Id | Finding | Type | Cost |
| --- | --- | --- | ---: |
| 4.1 | Public function or public behavior has no test | GAP | -4/behavior |
| 4.2 | Otherwise-tested function omits an error/exception branch | GAP | -4/function |
| 4.3 | Otherwise-tested function omits applicable empty, nullish, malformed, min/max, or off-by-one boundaries | GAP | -3/function |
| 4.4 | Conditional branch is executed but no assertion would fail if the branch were inverted or removed | GAP | -3/branch |
| 4.5 | Test executes code only for coverage and protects no contract behavior | VIOLATION | -3/test |
| 4.6 | Integration/configuration behavior structurally invisible to unit tests has no focused component test | GAP | -3/boundary |

Granularity: a completely untested public function receives exactly one 4.1 finding. Apply 4.2/4.3 only to functions with some tests. One uncovered branch is charged once under 4.1, 4.2, 4.3, or 4.4.

Branch litmus: identify a single realistic mutation and the exact assertion that fails. If neither exists, the behavior is not covered.

## D5 — Structure and conventions (10)

| Id | Finding | Type | Cost |
| --- | --- | --- | ---: |
| 5.1 | Arrange, act, and assert are tangled or repeated acts obscure the subject | VIOLATION | -2/test |
| 5.2 | Name does not describe behavior and scenario | VIOLATION | -1/test, cap -4 |
| 5.3 | Scenario context is absent when the name alone is ambiguous | GAP | -1/test, cap -2 |
| 5.4 | Opaque builder or copied payload hides the inputs relevant to the behavior | VIOLATION | -2 each |
| 5.5 | Same behavior is copy-pasted across data cases instead of `it.each`, `test.each`, or a small loop with named cases | GAP | -1/group |
| 5.6 | Shared fixture/helper is farther scoped than needed or hides teardown ownership | GAP | -1 each, cap -3 |

## D6 — False-green and flakiness risk (10)

| Id | Finding | Type | Cost |
| --- | --- | --- | ---: |
| 6.1 | Shared mutable state or test-order dependency | VIOLATION | -3 each |
| 6.2 | Hard-coded port, path, database key, or unique identifier can collide in parallel runs | VIOLATION | -2 each |
| 6.3 | Real sleep, polling delay, or network timing controls a unit/component test | VIOLATION | -3/test |
| 6.4 | Skipped/todo test lacks a concrete root cause and ticket reference | VIOLATION | -2/test |
| 6.5 | Resource visible to the test is left open or on disk without teardown | VIOLATION | -2 each |
| 6.6 | Promise/callback/stream assertion can finish without being awaited or observed | VIOLATION | -4/test |
| 6.7 | `any`, unsafe cast, or `@ts-ignore` hides a test-fixture or assertion-shape error | VIOLATION | -2/test |

## Verdicts

| Total | Verdict |
| ---: | --- |
| 90–100 | Exemplary |
| 75–89 | Compliant |
| 50–74 | Needs work |
| 0–49 | Non-compliant |
