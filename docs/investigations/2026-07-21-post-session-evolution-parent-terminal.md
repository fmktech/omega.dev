---
type: investigation
symptom: "CLI evolution-start rejects a completed source session with parent-session expected active."
slug: post-session-evolution-parent-terminal
date: 2026-07-21T09:08:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8e
branch: main
repository: fmktech/omega.dev
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/adrs/0010-background-evolution-and-mid-run-activation.md
  - docs/adrs/0012-child-sessions-and-capability-envelopes.md
  - docs/benchmarks/storage-app-holdout-plan.md
---

# Post-session evolution rejects its terminal source

## Symptom

- **Observed:** `evolution-start` using successful training session `session_eccad9a4-8119-4692-968e-89e850ee4973` returned `conflict: parent-session, expected active, actual completed` before creating an evolution job.
- **Expected:** Explicit or automatic post-session reflection can use a completed, failed, or cancelled source as immutable evidence and run evolution/evaluation child sessions linked to it.
- **Delta:** The public API and ADR permit after-session evolution, but the ordinary child lifecycle rejects every terminal parent and terminal session logs reject the lineage events evolution needs.

## Reproduction

```text
omega evolution-start project_67ed... session_eccad... <goal> ... skill synthetic-skill-suite
=> conflict resource=parent-session expected=active actual=completed
```

## Hypotheses

#### H1: Evolution delegates to ordinary child spawning, whose active-parent invariant and terminal-log invariant make post-session evolution structurally impossible

- **Layer:** session/evolution architecture
- **Prediction:** `EvolutionService.start` calls `SessionService.spawnChild` with the completed source; `spawnChild` rejects before launch; even removing that guard alone would fail when policy, handoff, spawn, or completion events append to the terminal parent.
- **Verification:** Trace the exact start path and inspect terminal append behavior.
- **Evidence:**
  ```text
  src/evolution/evolution-service.ts: start -> sessions.spawnChild(parentSessionId = sourceSessionId)
  src/sessions/session-service.ts: if parent.outcome !== null -> parent-session conflict
  src/persistence/session-repository.ts: any append after outcome != null -> session-terminal conflict
  CLI error exactly matches the first guard
  ```
- **Verdict:** PROVEN
- **Rationale:** Both consecutive lifecycle gates contradict the supported post-session call. Removing only the first would deterministically hit the second.

#### H2: The completed source's capability envelope does not grant child spawning

- **Layer:** policy/capabilities
- **Prediction:** The error would be `capability-denied: spawn-child` after parent state validation.
- **Evidence:** The source header contains the `spawn-child` grant, and the observed error is emitted by the earlier active-parent check.
- **Verdict:** REJECTED
- **Rationale:** The capability is present and was never evaluated.

#### H3: Synthetic skill evaluation rejects the request's component-kind envelope

- **Layer:** evolution validation
- **Prediction:** The request would fail with an `evaluationMode` validation error before child spawning.
- **Evidence:** The request selected exactly one `skill` component kind, passed validation, and reached `spawnChild`.
- **Verdict:** REJECTED
- **Rationale:** The observed conflict occurs after synthetic-mode validation succeeds.

## 5 Whys

1. **Why did forced reflection fail?** Evolution could not create its proposal child.
2. **Why not?** It used the source session as an ordinary parent, and ordinary parents must be active.
3. **Why is the source terminal?** The useful feedback episode is deliberately completed before reflection so its evidence is immutable and evaluable.
4. **Why can the lifecycle not represent that?** A terminal session rejects every later event, including policy decisions, handoffs, and child lineage facts.
5. **Why was this not caught earlier?** Existing evolution paths exercised mid-run children or benchmark-specific reflection helpers; no end-to-end test started evolution through the public API from a completed real session.

## Falsification

The request passed goal, component-kind, capability, and incumbent lookup validation before failing at `spawnChild`. The source carries the required `spawn-child` and evolution grants. Therefore changing budget, model route, skill evaluation mode, or evidence artifacts cannot alter the failing state invariant.

Adjacent-cause check: ordinary subagents must remain prohibited after terminal completion. Only evolution and promotion-evaluation roles may create post-terminal lineage. Post-terminal appends must be restricted to governance, handoff, artifact, and child-lineage events; normal model/process/session events remain rejected.

## Root Cause

The system modeled evolution children as ordinary child sessions but only implemented the mid-run half of that decision. The persistence layer treats `session.completed` as an absolute final event, while post-session reflection requires a completed source to append a small, audited lineage tail. The API exposed post-session evolution without a role-scoped exception in either layer.

## Fix

1. Permit `evolution` and `promotion-eval` child roles to spawn from a terminal source; keep ordinary roles active-only.
2. Permit only the post-terminal event kinds required by that lifecycle: policy decision/escalation/resolution, artifact and handoff recording, and child spawned/completed.
3. Preserve the source outcome/completed timestamp while advancing only its event sequence.
4. Add persistence and session regressions, then prove the public daemon/API path from a completed real source.

## Resolution

Implemented a role-scoped terminal-parent exception for `evolution` and `promotion-eval`, plus a seven-event post-terminal governance/lineage allowlist. Ordinary children and operational events remain sealed. Persistence/session regression tests pass, full presubmit passes, and real CLI job `95b506c4-1535-4500-a60f-f02323c0fc4b` created both post-session children from completed session `session_eccad9a4-8119-4692-968e-89e850ee4973`.
