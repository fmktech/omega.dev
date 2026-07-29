---
type: investigation
symptom: "A promoted-looking reflection skill solves near-transfer storage tasks but is never loaded for an Inventory service with the same observable HTTP contracts."
slug: skill-applicability-overfits-project-name
date: 2026-07-27T15:30:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8ebr
branch: main
repository: git@github.com:fmktech/omega.dev.git
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-27-skill-guidance-does-not-bound-execution.md
  - docs/investigations/2026-07-27-runner-lacks-portable-workspace-inventory.md
---

# Skill applicability overfits the source project name

## Symptom

- **Observed:** The candidate reads its learned skill exactly once and passes two near-transfer storage tasks, but reads zero skills and fails the first Inventory-service generalization task. The incumbent also fails.
- **Expected:** A project skill may keep project-scoped paths, while its applicability cues identify equivalent behavior: exact HTTP status/body contracts, direct return shapes, input normalization, and side-effect ordering.
- **Delta:** The skill catalog excludes the very holdout intended to test behavioral transfer.

## Hypotheses

#### H1: The crystallized skill omitted the learned behavior

- **Layer:** model-output
- **Prediction:** The skill body lacks the exact 413, 404, direct-return, normalization, or conflict semantics.
- **Evidence:** The stored skill contains every required contract verbatim in its guidance and observable-contract ledger.
- **Verdict:** REJECTED
- **Rationale:** The knowledge exists; retrieval is the failing stage.

#### H2: Runtime skill selection is generally broken

- **Layer:** runtime
- **Prediction:** Neither near-transfer nor generalization sessions read the candidate skill.
- **Evidence:** Both successful near-transfer candidate sessions record exactly one skill read. The generalization candidate records zero.
- **Verdict:** REJECTED
- **Rationale:** Selection works when lexical cues match.

#### H3: Reflection emits source-name applicability and an explicit cross-project exclusion

- **Layer:** evolution-contract
- **Prediction:** The generated frontmatter keys applicability to `storage-app`, location/lot names, or exact source paths, and rejects a different project/service even when behavior matches.
- **Evidence:** `appliesWhen` includes “modifying or extending the storage-app HTTP API”; `doesNotApplyWhen` includes “working on a different project or service.” The Inventory holdout uses the same observable contracts under different domain names and therefore scores no admissible skill.
- **Verdict:** PROVEN
- **Rationale:** The catalog metadata mechanically prevents behavioral transfer.

## 5 Whys

1. **Why did the candidate not improve the Inventory task?** It never loaded the learned skill.
2. **Why was the skill not loaded?** Its positive cues are source-project/domain terms and its negative cues exclude other services.
3. **Why did crystallization accept those cues?** The prompt asks for concrete applicability but does not require behavior-linked, name-independent cues.
4. **Why did validation not catch it?** It checks only that applicability arrays are non-empty.
5. **Why is this an evolution-loop defect?** Promotion is supposed to measure transfer, but the candidate representation can encode a lookup policy that makes transfer impossible before evaluation starts.

## Falsification

- **Check performed:** Compare stored skill frontmatter with near-transfer/generalization objectives and benchmark skill-read counters.
- **Result:** Near-transfer lexical matches produce one read and success; the behaviorally equivalent renamed holdout produces zero reads. The skill body itself is complete.
- **Conclusion:** H3 uniquely explains the failure.

## Root Cause

- **Immediate cause:** Generated applicability is lexical and source-identity-bound.
- **Architectural root:** The reflection contract does not distinguish project-scoped installation/paths from behavior-scoped retrieval cues.

## Fix Direction

- Require at least one positive applicability cue grounded in the observable-contract ledger.
- Forbid project/repository/service identity alone as a skill trigger or exclusion.
- Keep `relevantPaths` project-scoped; make `appliesWhen` portable across renamed modules that expose the same behavior.
- Reject invalid reflections before candidate creation, then rerun near-transfer, renamed generalization, and negative-control holdouts.
