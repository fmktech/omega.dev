---
type: investigation
symptom: "A candidate that completed its focused verifier is marked failed because one subsequent OpenRouter request returned a recoverable HTTP 400."
slug: recoverable-model-error-aborts-session
date: 2026-07-27T14:32:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8ebr
branch: main
repository: git@github.com:fmktech/omega.dev.git
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-21-openrouter-tool-continuation-http-400.md
  - docs/investigations/2026-07-27-skill-guidance-does-not-bound-execution.md
---

# Recoverable model error aborts session

## Symptom

- **Observed:** Candidate session `session_07bbe140-3d02-411d-b633-d0885d086b7d` wrote its implementation, ran and observed `verify.mjs`, then received `provider-unavailable`, `Provider returned HTTP 400`, `recoverable: true`, `callerAction: choose-different-route`. The next event is `session.completed` with failure.
- **Expected:** A bounded runner retries a transient/recoverable provider failure without changing task context, and records the retry in metrics.
- **Delta:** One provider response is treated as a behavioral candidate failure, corrupting the paired signal.

## Hypotheses

#### H1: The task model exhausted its session budget

- **Layer:** config-environment
- **Prediction:** The terminal error is `budget-exceeded` and names model calls/tokens/wall time.
- **Evidence:** The terminal error is `provider-unavailable`, explicitly recoverable, after only a small number of turns.
- **Verdict:** REJECTED
- **Rationale:** No budget dimension fired.

#### H2: The verifier process failed and the runner correctly ended the task

- **Layer:** business-logic
- **Prediction:** The terminal session event follows a failed process or a model-declared stop.
- **Evidence:** The verifier process was observed and completed; the terminal event follows a fresh `model.started` and `model.failed` provider event.
- **Verdict:** REJECTED
- **Rationale:** Infrastructure failure, not verifier outcome, ended the session.

#### H3: The runner unconditionally aborts on every model failure

- **Layer:** architecture
- **Prediction:** Initial runner source handles `event.kind === "failed"` by immediately calling `finish("failed")` without checking `recoverable` or retrying.
- **Evidence:** `modelEvent` contains exactly that unconditional branch. The session trace transitions directly from recoverable model failure to failed completion.
- **Verdict:** PROVEN
- **Rationale:** Source and runtime behavior match one-to-one.

## 5 Whys

1. **Why was the candidate marked failed?** The latest model request returned HTTP 400.
2. **Why did one request end the session?** The runner treats every model failure as terminal.
3. **Why is recoverability ignored?** No bounded provider-retry state exists in the initial runner.
4. **Why does this invalidate promotion?** Provider noise is charged to only one paired arm as behavioral failure.
5. **Why should retry live in the runner?** The runner owns the conversation turn and can safely replay the unchanged model request while preserving route and benchmark comparability.

## Falsification

- **Check performed:** Inspect terminal events, budgets, process lifecycle, and the runner's `modelEvent` failure branch.
- **Result:** The only terminal cause is a recoverable provider error, and the runner has no retry path.
- **Conclusion:** H3 uniquely explains the false failure.

## Root Cause

- **Immediate cause:** `modelEvent(failed)` always calls `finish("failed")`.
- **Architectural root:** Provider availability is not isolated from task correctness in the execution loop.

## Fix Direction

- Retry an unchanged model turn at most twice when the model error is recoverable.
- Reset the retry counter after a completed model turn.
- Ignore stale failed events whose stream ID is no longer active.
- Preserve hard failure for non-recoverable errors or exhausted retries.
