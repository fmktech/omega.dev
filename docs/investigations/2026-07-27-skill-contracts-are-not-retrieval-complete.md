---
type: investigation
symptom: "A candidate skill passes crystallization but the runner rejects it for a task whose objective states the skill's exact operations and HTTP statuses."
slug: skill-contracts-are-not-retrieval-complete
date: 2026-07-27T15:22:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8ebr
branch: main
repository: git@github.com:fmktech/omega.dev.git
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-27-skill-applicability-overfits-project-name.md
  - docs/investigations/2026-07-27-skill-guidance-does-not-bound-execution.md
---

# Skill contracts are not retrieval-complete

## Symptom

- **Observed:** Candidate session `session_23e7e658-c297-4696-8c55-07b14014d30a` sees two installed skill summaries, judges both relevant, calls `skill.read`, receives “Skill did not pass positive applicability,” and then enters an open-ended self-written verifier loop.
- **Expected:** A task objective naming `deleteLocation`, `CONFLICT`, `createLocation`, `listLots`, HTTP 413, and HTTP 404 automatically loads the skill that crystallized those exact contracts.
- **Delta:** The skill exists and the model wants it, but the deterministic selector cannot retrieve it.

## Hypotheses

#### H1: The candidate harness did not install the new skills

- **Layer:** persistence
- **Prediction:** The bootstrap catalog omits candidate components.
- **Evidence:** The model receives and names both new candidate skills and their applicability cues.
- **Verdict:** REJECTED
- **Rationale:** Installation and catalog loading succeeded.

#### H2: Negative applicability excluded the task

- **Layer:** retrieval
- **Prediction:** The runner reports the negative-cue exclusion error.
- **Evidence:** The runner reports the distinct positive-applicability failure; the model also confirms no negative cue matches.
- **Verdict:** REJECTED
- **Rationale:** The failure occurs in positive scoring.

#### H3: Applicability covers the ledger only in aggregate and selector tokenization drops exact HTTP statuses

- **Layer:** evolution-contract/runtime
- **Prediction:** Broad cues overlap one word at a time with the task, while exact numeric statuses cannot contribute to the selector's two-token threshold.
- **Evidence:** Cues such as “storage domain CRUD operations,” “deletion with foreign-key-like constraints,” and “request-size limits” each share at most one retained token with the objective. `cueTokens` discards tokens shorter than four characters, including 413 and 404. Crystallization validates only one behavior-linked cue for the entire multi-operation ledger.
- **Verdict:** PROVEN
- **Rationale:** The selector's computed score is below two despite exact behavioral relevance.

## 5 Whys

1. **Why did the candidate run without its skill?** Automatic selection returned null and manual reads were rejected.
2. **Why did selection return null?** No positive cue reached two retained overlapping tokens.
3. **Why were exact statuses ineffective?** Numeric HTTP statuses are discarded by the token-length filter.
4. **Why could broad cues pass crystallization?** Only one cue must overlap the complete ledger; individual contracts need no retrieval cue.
5. **Why did the execution then loop?** The bounded application protocol lives inside the skill body, which was never injected.

## Falsification

- **Check performed:** Compare bootstrap catalog, task objective, model tool calls, runner errors, and deterministic selector source.
- **Result:** The candidate components are present and semantically selected by the model, but deterministic scoring rejects them exactly as predicted.
- **Conclusion:** H3 explains both failed retrieval and the subsequent unbounded behavior.

## Root Cause

- **Immediate cause:** Multi-contract skills are not required to be retrieval-complete, and HTTP status tokens do not participate in matching.
- **Architectural root:** Crystallization and runtime retrieval use different adequacy thresholds.

## Fix Direction

- Require every observable contract to have at least one behavior-linked applicability cue.
- Require the reflection prompt to include operation/exact-value cues per contract.
- Retain three-digit numeric tokens such as HTTP status codes in runtime matching.
- Regression-test automatic loading from `HTTP 413`/`HTTP 404` objectives, then rerun the full transfer suite.
