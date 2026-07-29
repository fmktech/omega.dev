---
type: investigation
symptom: "Both paired arms are terminated at the same 24-turn ceiling immediately before final verification, so the benchmark cannot measure skill impact."
slug: synthetic-task-budget-censors-completion
date: 2026-07-27T13:09:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8ebr
branch: main
repository: git@github.com:fmktech/omega.dev.git
status: superseded
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-21-synthetic-evaluation-budget-coupling.md
  - docs/investigations/2026-07-21-model-call-budget-not-cumulative.md
---

# Synthetic task budget censors completion

## Symptom

- **Observed:** Incumbent and candidate each recorded exactly 24 completed model turns, then failed with `budget=model-calls`, `limit=24`, `observed=25`. After raising the first bound to 32, the harder HTTP generalization pair also reached exactly 32 while still verifying.
- **Expected:** The budget is high enough for ordinary task completion, while metrics retain the actual efficiency difference.
- **Delta:** Both arms are scored as verification failures at the ceiling, hiding whether either near-complete workspace would pass.

## Hypotheses

#### H1: The OCI wall-time limit terminates both runs

- **Layer:** config-environment
- **Prediction:** Terminal errors name `wall-time` or processes are cancelled at 300 seconds.
- **Evidence:** Both terminal events explicitly name `model-calls`; neither names wall time.
- **Verdict:** REJECTED
- **Rationale:** A different budget dimension fired first.

#### H2: Provider HTTP failures consume the final retry budget

- **Layer:** dependency-integration
- **Prediction:** The terminal trace contains a provider-unavailable event immediately before failure.
- **Evidence:** The terminal failure is deterministic `budget-exceeded`; the filtered pair contains no terminal provider error.
- **Verdict:** REJECTED
- **Rationale:** Provider availability did not end these sessions.

#### H3: The fixed synthetic call ceiling is below this model/task workload

- **Layer:** config-environment
- **Prediction:** Both sessions hit exactly 24 turns while still issuing task-relevant file/process calls, and the default is exactly 24.
- **Evidence:** At 24 turns, incumbent's final turns read/write source and candidate observes/starts verification. At the provisional 32-turn bound, both HTTP generalization arms again terminate on their next relevant verification turn. The configured ceiling exactly matches both terminal counts.
- **Verdict:** PROVEN
- **Rationale:** The benchmark ceiling, not behavioral completion, determines both outcomes.

## 5 Whys

1. **Why are both arms reported as failed?** Their 25th model request is denied.
2. **Why is a 25th request needed?** The cheap model uses multiple explicit file/process round trips and must observe final verification.
3. **Why is 24 the ceiling?** It was chosen before the executable, SHA-interlocked real-workspace workload was observed end to end.
4. **Why does this invalidate comparison?** Identical ceiling failures collapse potentially different final capabilities into the same zero.
5. **Why not simply remove limits?** Bounded evaluation remains necessary; the limit should exceed normal completion and metrics should penalize actual usage.

## Falsification

- **Check performed:** Inspect terminal events, completed-turn counts, last tool calls, and the configured synthetic budget.
- **Result:** Both arms terminate at exactly the configured call ceiling while still making relevant progress.
- **Conclusion:** H3 uniquely explains the paired censoring.

## Root Cause

- **Immediate cause:** The synthetic model-call ceiling was set at or below the observed completion workload (first 24, then a provisional 32).
- **Architectural root:** A safety ceiling is being used as an implicit performance target, making the evaluator unable to distinguish slow completion from non-completion.
- **Rejected H1:** Wall time did not fire.
- **Rejected H2:** Provider availability did not fire.

## Fix

- Raise the bounded workspace budget to 40 model calls, 480 seconds, 360k input tokens, 64k output tokens, and 40 process starts. This is headroom above the observed 32-turn HTTP workload, not an efficiency target.
- Keep both paired arms on the identical budget and retain actual turns/cost/latency in the scorecard.
- Revisit the ceiling from observed completion percentiles, not promotion outcomes.

## Supersession

The 40-call rerun disproved the assumption that headroom alone would restore a valid comparison. Candidate session `session_d1741da2-05a5-46e6-8beb-3671bd3104cd` also consumed the larger ceiling while repeatedly revising the same contract. The remaining root cause is documented in `2026-07-27-skill-guidance-does-not-bound-execution.md`.
