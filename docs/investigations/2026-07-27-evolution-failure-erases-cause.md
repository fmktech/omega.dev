---
type: investigation
symptom: "An evolution job fails after a candidate benchmark session completes, but the persisted job contains no failure cause."
slug: evolution-failure-erases-cause
date: 2026-07-27T13:24:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8ebr
branch: main
repository: git@github.com:fmktech/omega.dev.git
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-27-hidden-verifier-hardcodes-wrong-post-state.md
---

# Evolution failure erases its cause

## Symptom

- **Observed:** Job `2c3a29fe-8962-4fb6-8569-dac71d368836` changed from `evaluating` to `failed` at `2026-07-27T16:21:02.667Z`. Its candidate session `session_a6ff4fad-da40-43e9-80e9-a734c4df6991` completed successfully at `16:21:02.592Z`, no candidate benchmark record was persisted, and the returned job has no error or failure field.
- **Expected:** A failed asynchronous evolution job retains the structured `EvolutionError` that caused it to fail, so the caller and retry loop can distinguish benchmark, provider, validation, I/O, and lifecycle failures.
- **Delta:** Only `state: "failed"` survives; the causal error is discarded.

## Reproduction

1. Start the canonical synthetic skill evolution from source session `session_fb500169-821a-47da-868c-16d79df89725`.
2. Allow the first incumbent and candidate near-transfer sessions to complete.
3. Fetch the job after the candidate session terminates.
4. Observe `state: "failed"`, `scorecardId: null`, no candidate run record, and no failure value.

Verified on 2026-07-27: the persisted job update time is 75 ms after candidate `session.completed`, while the job JSON exposes no cause.

## Hypotheses

#### H1: The candidate failed because it did not load the candidate skill

- **Layer:** state-data
- **Prediction:** The candidate session should contain no `skill.loaded` event.
- **Verification method:** Inspect the persisted candidate `events.jsonl`.
- **Evidence:** Sequence 3 is `{"kind":"skill.loaded","componentId":"component_2510..."}`.
- **Verdict:** REJECTED
- **Rationale:** The intended candidate-only skill was loaded before model work.

#### H2: The candidate task session itself ended unsuccessfully

- **Layer:** integration
- **Prediction:** The terminal session event should be failed or cancelled.
- **Verification method:** Inspect the terminal event and session record.
- **Evidence:** Sequence 53 is `session.completed` with `outcome: "succeeded"`; the session record is completed/succeeded.
- **Verdict:** REJECTED
- **Rationale:** The asynchronous evolution failed after the task session succeeded.

#### H3: The asynchronous scorecard error is deliberately discarded by the evolution state transition

- **Layer:** code-logic
- **Prediction:** The `!scorecard.ok` branch calls a failure transition without passing `scorecard.error`, and the job contract has nowhere to persist it.
- **Verification method:** Read `src/evolution/evolution-service.ts` and `src/contracts/index.ts`.
- **Evidence:** `execute()` handles `if (!scorecard.ok) { ... await finishFailed(id); return; }`; `finishFailed()` only calls `update(job, { state: "failed" })`; `EvolutionJob` has no failure field.
- **Verdict:** PROVEN
- **Rationale:** Every byte of the underlying structured error is lost on this path by construction.

## 5 Whys

1. Why can the implementation loop not diagnose the candidate failure? The job has no causal error.
2. Why does it have no causal error? `finishFailed` persists only the terminal state.
3. Why can it persist only state? `EvolutionJob` has no structured failure field and `update` cannot patch one.
4. Why was this missed? Synchronous API errors were modeled, but failures occurring after an accepted asynchronous start were treated as state only.
5. Why does this block self-improvement? A self-improving loop cannot classify or correct a failed evaluation without durable machine-readable feedback.

## Falsification

- **Check performed:** Adjacent-cause search. A verifier failure or failed candidate session could explain a rejected benchmark, but either would still yield benchmark evidence or a non-succeeded terminal outcome.
- **Result:** The candidate loaded the skill and completed successfully, while the exact `!scorecard.ok` branch discards its error regardless of its kind.
- **Conclusion:** H3 survives; it is the direct cause of the missing diagnostic even though a deeper benchmark error remains to be exposed afterward.

## Root Cause

- **Immediate cause:** `finishFailed` and its caller discard the structured `EvolutionError` returned by `runSkillPaired`.
- **Architectural root:** The durable async job model represents terminal failure as a bare state instead of state plus causal data.
- **Rejected H1:** A persisted `skill.loaded` event proves candidate activation.
- **Rejected H2:** The terminal session record proves the candidate runner succeeded.

## Fix

- Add an optional nullable structured failure field to `EvolutionJob` for backward-compatible persisted-job loading.
- Make failure transitions retain their `EvolutionError`, especially the scorecard path.
- Add a regression proving a benchmark-service failure remains visible through `evolution.get`.

## Resolution

- `EvolutionJob` now carries a backward-compatible optional `failure` value.
- Every asynchronous failure transition supplies its structured `EvolutionError`; retries clear stale failures.
- Persisted-job validation accepts old jobs without the field and validates new structured failures.
- `src/evolution/evolution-benchmarks.test.ts` proves a paired-evaluation error survives persistence and service recreation.
- Verification: 26 focused tests passed, followed by strict TypeScript checking and a production build.
