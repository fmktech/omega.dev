---
type: investigation
symptom: "Two process-heavy tests time out only during the full parallel unit suite"
slug: presubmit-process-heavy-tests-time-out
date: 2026-07-27T18:15:02-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8e
branch: main
repository: fmktech/omega.dev
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-27-workspace-benchmark-reflection-provider-failure.md
---

# Process-heavy tests time out only in the full parallel suite

## Symptom

- **Observed:** `pnpm presubmit` fails in `pnpm test` because the Git-worktree persistence test exceeds 5 seconds and the mutation-fixture calibration exceeds 180 seconds.
- **Expected:** The complete local unit suite passes deterministically after the workspace benchmark changes.
- **Delta:** Both assertions pass alone but cross their fixed wall-clock limits under the default full-suite worker fan-out.

## Reproduction

1. Run `pnpm presubmit` with Vitest's default worker count.
2. Observe:
   ```text
   persistence.test.ts ... maps a Git worktree ... Test timed out in 5000ms
   feedback-skill-transfer-benchmark.test.ts ... calibrates every ... Test timed out in 180000ms
   ```
3. Run the same tests individually:
   ```text
   persistence: 1 passed; tests 3.21s
   feedback calibration: 1 passed; tests 88.77s
   ```

Verified on 2026-07-27.

## Hypotheses

#### H1: The reflection retry implementation changed persistence or fixture-calibration behavior

- **Layer:** code-logic
- **Prediction:** The exact failed assertions also fail when run alone.
- **Verification method:** Run each named test in its own Vitest process.
- **Evidence:**
  ```text
  Test Files 1 passed; Tests 1 passed | 13 skipped; tests 3.21s
  Test Files 1 passed; Tests 1 passed | 4 skipped; tests 88.77s
  ```
- **Verdict:** REJECTED
- **Rationale:** Both behavioral paths produce the expected result without any code change when isolated.

#### H2: Default full-suite worker fan-out causes CPU/process contention that violates fixed wall-clock test limits

- **Layer:** tooling-build
- **Prediction:** Only the parallel full suite exceeds the limits, with duration inflation greater than 2× for the heavy calibration and greater than 1.5× for Git setup.
- **Verification method:** Compare full-suite and isolated durations for the identical test ids.
- **Evidence:**
  ```text
  Full suite: persistence >5.00s; calibration >180.00s
  Isolated: persistence 3.21s; calibration 88.77s
  ```
- **Verdict:** PROVEN
- **Rationale:** Inputs and assertions are identical; removing cross-file concurrency restores both with large timing margin.

#### H3: A leaked benchmark, Vitest, or runner process continues consuming resources after the workspace replay

- **Layer:** state-data
- **Prediction:** A process listing after the failed suite contains a surviving benchmark, Vitest, runner, or `node dist` process.
- **Verification method:** Inspect the process table after all commands terminalize.
- **Evidence:**
  ```text
  ps -axo pid,ppid,etime,command | rg "(vitest|workspace-skill-transfer|omega-runner|node dist)"
  <no matches>
  ```
- **Verdict:** REJECTED
- **Rationale:** No persistent process explains the repeatable full-suite-only slowdown.

## 5 Whys

Symptom: Two correct tests fail presubmit on timeouts.

1. Because their subprocess work exceeds fixed test deadlines during the full suite.
2. Because Vitest runs many process-heavy files concurrently by default.
3. Because the unit command does not bound worker concurrency for this repository's Docker/Git/TypeScript workload.
4. Because process-heavy benchmark calibration was added to the ordinary suite without updating the suite's resource policy.
5. Because test isolation was specified functionally but not as a shared CPU/process-capacity contract for CI and developer machines.

## Falsification

- **Check performed:** Absence test and adjacent-cause search.
- **Result:** The two exact tests pass in fresh isolated Vitest processes, and no leaked process remains afterward. This rejects broken behavior and stale external state. The only changed condition is concurrent suite load.
- **Conclusion:** H2 survives.

## Root Cause

- **Immediate cause:** `package.json` invokes `vitest run src` without a worker bound even though several files launch substantial subprocess workloads.
- **Architectural root:** The repository lacks an explicit resource-concurrency policy for its process-heavy test suite.
- **Rejected H1:** Both exact behavior tests pass alone.
- **Rejected H3:** The post-run process table contains no matching survivor.

## Fix

- Bound the unit-suite worker count in the canonical `pnpm test` command.
- Use the full `pnpm test` command as the regression test; it must pass all files within their existing per-test deadlines without relaxing those deadlines.

## Resolution

- Changed the canonical unit command to `vitest run src --maxWorkers=4`; individual test deadlines and assertions remain unchanged.
- Regression result: 24/24 files and 225/225 tests passed in 87.34 seconds.
- The previously failing mutation calibration completed inside the same bounded-concurrency full-suite run, rather than only in isolation.
