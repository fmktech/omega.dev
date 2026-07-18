# Process crystallization benchmark — 2026-07-17

Follow-up: [`2026-07-18-five-cycle-crystallization.md`](./2026-07-18-five-cycle-crystallization.md) extends this experiment through five cumulative mutation-and-evaluation cycles.

## Outcome

An experience-fed mini-style project harness passed **6/10** sealed tasks, compared with **5/10** for its unfed parent.

- Observed success-rate delta: **+0.10**
- Head-to-head: **1 fed win, 0 regressions, 9 ties**
- Promotion-gate decision: **promote**
- Active `omega.dev` harness: unchanged; the experiment's mini-style parent was not the active Omega harness
- Scorecard: `8fdd909b9fe9ce9bed13277c924138ea237a1411e57a7774a5d18fa441063ef3`
- Unfed parent: `harness_ed9799b3a7ea534cb71235b9cef83c29375ca842411af49930be3441fb5ce96d`
- Experience-fed candidate: `harness_6696133e68b6c4918c52ec8e7d35a740aca017d83553f91817833d5c39d17453`

The unique transfer win was `nonstandard-test-oracle@1`. The source evidence described a different binary-fixture project and a different repository-owned checker. DeepSeek crystallized the procedure “use the repository's authoritative check and correct the generator rather than hand-editing derived data.” The fed harness transferred that lesson to the unrelated `answer.dat`/`./oracle` task; the unfed harness did not solve it.

## Leakage-resistant setup

Before evaluation, the crystallizer received six frozen project-work trajectories containing only:

- project context and objective;
- attempted commands and ordinary failures;
- repository guidance discovered during work;
- the recovery procedure;
- the locally observed result.

The source trajectories use different filenames, tools, and objectives from the sealed suite. Input validation rejects OmegaBench identifiers, scorecards, hidden-verifier references, promotion decisions, protected-task references, and benchmark outcomes before any model call. Evaluation results never become later crystallizer input.

Evidence SHA: `61d83beb59add3e40a34afa2a2d18ff97bb38ba4ad47f456fb9323ef9cc2017d`

The crystallizer used:

```text
provider: OpenRouter
model: deepseek/deepseek-v4-flash
serving provider: GMICloud
reasoning: high
temperature: 0
input tokens: 1,023
reasoning tokens: 1,238
output tokens: 1,506
provider cost: $0.000395
```

It produced four skills, one project-knowledge lesson, and one policy lesson. Phase one records the selected destination but compiles every lesson into an always-on project-experience section in the runner so the transfer effect is executable. Native lazy loading from distinct knowledge and skill components remains future runtime work.

## Pairwise results

| Sealed task | Unfed parent | Experience-fed | Change |
| --- | --- | --- | --- |
| operating-system-mismatch@1 | fail | fail | tie |
| unexpected-build-tool@1 | pass | pass | tie |
| generated-file-trap@1 | fail | fail | tie |
| scoped-monorepo-verification@1 | fail | fail | tie |
| background-process@1 | pass | pass | tie |
| offline-dependency@1 | pass | pass | protected tie |
| concurrent-file-change@1 | pass | pass | tie |
| misleading-instructions@1 | fail | fail | protected tie |
| nonstandard-test-oracle@1 | fail | pass | positive transfer |
| preexisting-flaky-failure@1 | pass | pass | tie |

## Resource evidence

| Aggregate | Unfed parent | Experience-fed | Fed / parent |
| --- | ---: | ---: | ---: |
| Passed | 5 | 6 | 1.20x |
| Wall time | 312,431 ms | 474,845 ms | 1.52x |
| Provider cost | $0.006504 | $0.009306 | 1.43x |
| Input tokens | 53,720 | 86,094 | 1.60x |
| Reasoning tokens | 3,082 | 3,097 | 1.00x |
| Output tokens | 7,553 | 8,242 | 1.09x |
| Model turns | 61 | 65 | 1.07x |
| Process starts | 78 | 76 | 0.97x |

The fed harness was more capable but not more efficient. It spent materially more wall time, cost, and context for one additional solved task. Capability is lexicographically prior under the current promotion policy, so +10 percentage points with no protected regression met the gate.

## Defect discovered by the experiment

The first paired attempt was invalid as learning evidence. It scored the unfed parent 1/10 and the fed candidate 0/10 because the mini-style adapter recorded all parallel bash calls from a model completion but executed only the first. The next model request then failed because the remaining call IDs had no results.

An unfed session reproduced the same failure, disproving guidance as the cause. The adapter now executes all calls sequentially and returns a result for every call before continuing. A behavioral regression test was demonstrated red under the old behavior and green under the fix. See [`../investigations/2026-07-17-crystallized-oracle-regression.md`](../investigations/2026-07-17-crystallized-oracle-regression.md).

## Interpretation

This is positive evidence for the proposed doctrine:

> Experience supplies the learning; sealed evaluation decides whether to retain it.

The experiment shows that process-only reflection can produce a project-scoped harness change that transfers to a different task without receiving benchmark answers. It does not yet prove that every destination works. In particular:

- the project-specific generated-file knowledge did not transfer to a different generated API fixture;
- the policy lesson did not solve the sealed instruction-boundary task;
- the oracle procedure did transfer when represented as a skill;
- the always-on compilation used in phase one cannot measure retrieval quality or context savings.

The result is one ten-task replicate over synthetic work trajectories. The next benchmark should consume sanitized real project sessions, materialize lessons into their native destinations, evaluate selective retrieval, and run at least three paired replicates on a fresh project-specific holdout.
