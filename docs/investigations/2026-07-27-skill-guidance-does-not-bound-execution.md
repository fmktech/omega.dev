---
type: investigation
symptom: "A candidate loads the correct learned contracts but exhausts 40 model calls while repeatedly rewriting and manually probing the same implementation."
slug: skill-guidance-does-not-bound-execution
date: 2026-07-27T13:47:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8ebr
branch: main
repository: git@github.com:fmktech/omega.dev.git
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-27-synthetic-task-budget-censors-completion.md
  - docs/investigations/2026-07-27-selected-skill-path-cues-cause-transfer-search-loop.md
---

# Skill guidance does not bound execution

## Symptom

- **Observed:** Candidate session `session_d1741da2-05a5-46e6-8beb-3671bd3104cd` loaded the generated storage contract skill, then reached `model-calls limit=40 observed=41` while still editing and starting another test process.
- **Expected:** The selected skill reduces intervention and tool work by turning the learned corrections into a short implementation and verification path.
- **Delta:** The skill carries the right facts but the runner treats it as passive prose. The model repeatedly rediscovers how to satisfy the same HTTP-body contract.

## Hypotheses

#### H1: The generated skill omitted the required contracts

- **Layer:** business-logic
- **Prediction:** The candidate skill lacks the conflict error, direct return, whitespace trim, 413/no-reset, exact 404, or no-auth requirement.
- **Evidence:** Object `f44d8a5e...41c1` contains all six requirements both in prose and in the observable-contract ledger.
- **Verdict:** REJECTED
- **Rationale:** The information exists before the first model turn.

#### H2: The candidate did not retrieve the generated skill

- **Layer:** dependency-integration
- **Prediction:** The benchmark record reports zero skill reads or the model context lacks the skill.
- **Evidence:** Candidate traces use the automatically selected project skill path; previous valid near-transfer records report exactly one skill read, and this run immediately attempts the skill-specific edge cases.
- **Verdict:** REJECTED
- **Rationale:** Retrieval and applicability are working.

#### H3: Passive skill prose has no execution or completion protocol

- **Layer:** architecture
- **Prediction:** The model will implement some contracts, repeatedly revise difficult ones, invent unrelated behavior, and continue until the external budget fires because nothing requires a single contract-derived verifier or a bounded final audit.
- **Evidence:** The session first implemented `deleteLocation` with the wrong error shape, failed to trim `locationId`, invented lot-ID truncation, reset the oversized-body socket, then rewrote `server.js` multiple times and started multiple ad-hoc servers. Its final events are two consecutive full-file rewrites followed by another `node test.js`; no model turn completed naturally before the 41st request was denied.
- **Verdict:** PROVEN
- **Rationale:** The learned facts are present, but the harness provides no mechanism that converts them into a finite work plan and a completion gate.

## 5 Whys

1. **Why did the evolved arm fail?** It exhausted 40 model calls before declaring completion.
2. **Why did it need more calls?** It repeatedly rewrote and manually tested the same 413 behavior.
3. **Why did it rediscover the behavior?** The skill describes outcomes but does not require one fixture-backed verifier covering its ledger.
4. **Why can it keep iterating after the contracts are known?** Runner completion is controlled only by the model returning no tool calls; there is no learned-skill final audit.
5. **Why is that an architectural defect?** Internalization should reduce future developer intervention and unnecessary tool calls, not merely add facts to context.

## Falsification

- **Check performed:** Read the immutable candidate skill and compare it with all 40 model completions and terminal events.
- **Result:** Correct knowledge was loaded, yet the session made contradictory edits and ended only at the call budget.
- **Conclusion:** Missing knowledge and missing retrieval cannot explain the trace; the absent execution/completion protocol can.

## Root Cause

- **Immediate cause:** The runner injects selected skill markdown but gives the model no mandatory contract-derived plan, verifier, or bounded final audit.
- **Architectural root:** Skill internalization currently stores declarative knowledge but not the control loop needed to apply that knowledge efficiently.

## Fix Direction

- Require generated skills to include an executable application checklist and verifier specification derived from each observable contract.
- On automatic skill selection, inject a compact mandatory protocol: inspect once, implement once, run the declared verifier once, repair only failing contracts, then perform one final audit and stop.
- Make completion with a selected skill pass through one runner-managed audit turn so the model explicitly accounts for every contract without re-reading immutable context.
- Keep a hard safety budget, but score actual work below it; do not treat a larger ceiling as the fix.
