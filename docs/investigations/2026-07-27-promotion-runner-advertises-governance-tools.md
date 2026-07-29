---
type: investigation
symptom: "A bounded promotion worker leaves the coding task to inspect harness status and the local marketplace."
slug: promotion-runner-advertises-governance-tools
date: 2026-07-27T12:57:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8ebr
branch: main
repository: git@github.com:fmktech/omega.dev.git
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-27-initial-runner-does-not-teach-process-observation.md
  - docs/investigations/2026-07-27-zero-grant-proposal-runner-advertises-tools.md
---

# Promotion runner advertises governance tools

## Symptom

- **Observed:** Promotion session `session_46c86aa5-4979-40f7-ab2b-cb76403c428c` correctly learned start→observe, read `src/storage.js`, then called `harness.status` at sequence 94 and `marketplace.search` at sequence 97.
- **Expected:** A sealed synthetic workspace worker edits and verifies the fixture with only file/process capabilities; promotion governance stays in the daemon.
- **Delta:** Irrelevant no-capability tools remain model-visible and consume the bounded model-call budget.

## Hypotheses

#### H1: The task objective asks the worker to inspect marketplace state

- **Layer:** state-data
- **Prediction:** The public objective mentions harnesses, marketplace artifacts, or governance.
- **Evidence:** The objective only requests storage API behavior in `src/storage.js`.
- **Verdict:** REJECTED
- **Rationale:** The calls are unrelated to the public task.

#### H2: The generated project skill instructs marketplace discovery

- **Layer:** state-data
- **Prediction:** Only the candidate calls governance tools after loading the skill.
- **Evidence:** The observed session is the incumbent harness and loads no candidate skill.
- **Verdict:** REJECTED
- **Rationale:** The behavior occurs before candidate-specific guidance exists.

#### H3: `visibleTools` exposes the complete initial tool catalog to non-zero-grant promotion sessions

- **Layer:** code-logic
- **Prediction:** Only zero-grant proposal children are filtered; workspace promotion workers receive marketplace, harness, knowledge, and evolution tools.
- **Evidence:** `visibleTools` returns `tools` for every session except the zero-grant proposal branch. `harness.status` and `marketplace.search` require no denied capability before model selection and appear in live calls.
- **Verdict:** PROVEN
- **Rationale:** The model can select irrelevant control-plane actions because the runner advertises them as valid task tools.

## 5 Whys

1. **Why did the coding worker inspect governance state?** Those tools were present in its model tool catalog.
2. **Why were they present?** `visibleTools` filters proposal-only children but not workspace promotion sessions.
3. **Why is capability enforcement insufficient?** Model-visible no-capability reads can be valid at the kernel while still being irrelevant and costly for this role.
4. **Why does this harm evolution?** Promotion tasks have a 24-call ceiling, so irrelevant actions displace implementation and verification turns.
5. **Why did tests miss it?** Tool-surface tests cover zero-grant proposal children, not non-zero-grant promotion workers.

## Falsification

- **Check performed:** Compare the objective, harness condition, live tool calls, and the runner's `visibleTools` branch.
- **Result:** Neither objective nor candidate skill requests governance; the unfiltered role is sufficient to make both tools available.
- **Conclusion:** H3 survives and both content hypotheses are contradicted.

## Root Cause

- **Immediate cause:** Promotion workspace sessions inherit the full agent/control-plane tool surface.
- **Architectural root:** Capability authorization and model-facing relevance filtering are treated as the same concern.
- **Rejected H1:** The public objective is code-only.
- **Rejected H2:** The incumbent has no candidate skill.

## Fix

- Restrict non-zero-grant `promotion-eval` sessions to file and process tools.
- Omit `skill.read` when automatic retrieval already loaded every applicable skill.
- Keep proposal-only evidence rules unchanged.
- Add an exact role-scoped tool-list regression test and rerun the paired benchmark.

