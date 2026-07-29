---
type: investigation
symptom: "Both paired arms fail a hidden verifier even though the candidate correctly rejects a referenced deletion without mutating storage."
slug: hidden-verifier-hardcodes-wrong-post-state
date: 2026-07-27T16:08:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8ebr
branch: main
repository: git@github.com:fmktech/omega.dev.git
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-27-skill-contracts-are-not-retrieval-complete.md
  - docs/investigations/2026-07-27-negative-skill-cues-ignore-polarity.md
---

# Hidden verifier hardcodes the wrong post-state

## Symptom

- **Observed:** Candidate session `session_8386335e-46d6-4959-83b3-33d656c240f0` loads the skill, implements a conflict-safe `deleteLocation`, and still fails with `AssertionError: Should not have deleted — 2 !== 1`.
- **Expected:** Rejecting deletion must leave the collection unchanged from its pre-operation state.
- **Delta:** Correct non-mutation is scored as failure.

## Hypotheses

#### H1: `deleteLocation` mutated storage before throwing

- **Layer:** candidate-implementation
- **Prediction:** The written method removes a location before detecting the referencing lot.
- **Evidence:** The method checks `this.lots.some(...)`, constructs an error with code `CONFLICT`, and throws before `findIndex`/`splice` executes.
- **Verdict:** REJECTED
- **Rationale:** Control flow cannot reach mutation on the conflict path.

#### H2: The skill instructed the candidate to keep the wrong state

- **Layer:** learned-guidance
- **Prediction:** The skill permits deletion or omits the non-mutation contract.
- **Evidence:** Its guidance and contract ledger explicitly require throwing `CONFLICT` and not deleting while references exist.
- **Verdict:** REJECTED
- **Rationale:** Candidate code follows the learned contract.

#### H3: The hidden verifier's expected count ignores its own setup

- **Layer:** benchmark-oracle
- **Prediction:** Setup creates two locations but the post-conflict assertion hardcodes one rather than comparing before and after.
- **Evidence:** The verifier calls `createLocation` once, then pushes `{ id: 'loc-1' }` into `locations`, creating two entries. After the rejected delete it asserts `store.locations.length === 1` with message “Should not have deleted.” Runtime reports the correct unchanged length, 2.
- **Verdict:** PROVEN
- **Rationale:** The oracle contradicts its own setup.

## 5 Whys

1. **Why did both arms fail?** The authoritative hidden verifier exited nonzero.
2. **Why did it exit nonzero?** It expected one location after the conflict.
3. **Why is one wrong?** Setup had already created two locations.
4. **Why was this accepted?** Suite validation checks shape, isolation, and executable presence but not state-preservation assertion design.
5. **Why does this break self-improvement?** Promotion feedback becomes anti-signal: correct learned behavior is rejected by a faulty oracle.

## Falsification

- **Check performed:** Read the persisted benchmark report, candidate file-write payload, and exact hidden verifier object.
- **Result:** Candidate control flow preserves state; verifier setup produces length two and then asserts one.
- **Conclusion:** H3 uniquely explains the failure.

## Root Cause

- **Immediate cause:** A no-mutation verifier asserts a hardcoded collection count instead of a before/after snapshot.
- **Architectural root:** Hidden-suite compilation lacks mechanical lint for state-preservation oracles.

## Resolution

- Suite-authoring and bounded-repair prompts now require `before...` snapshots immediately before an operation and after-state comparison for every no-mutation/preservation claim.
- `compileSkillEvalSuite` rejects verifier assertions that pair a hardcoded collection length with deletion/mutation/preservation wording, which routes the validation error through the existing bounded evaluator repair loop.
- Regression coverage in `src/evolution/skill-foundry.test.ts` proves the exact faulty assertion is rejected and a valid before/after snapshot assertion is accepted.
- Verification: the regression was red before the validator, then all 25 focused tests, strict typecheck, and production build passed after the fix.
