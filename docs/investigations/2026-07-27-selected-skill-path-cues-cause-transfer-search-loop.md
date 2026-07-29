---
type: investigation
symptom: "A candidate with the correct behavioral skill uses more tools than the incumbent because it searches for source-project paths absent from the transfer fixture."
slug: selected-skill-path-cues-cause-transfer-search-loop
date: 2026-07-27T13:08:00-03:00
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
  - docs/investigations/2026-07-27-promotion-runner-advertises-governance-tools.md
---

# Selected skill path cues cause transfer search loop

## Symptom

- **Observed:** In the first filtered-tool pair, candidate `session_27b9489e-bfa2-43de-93e1-ecece62885ca` used 31 tool calls and 13 process starts; incumbent `session_02c74d64-8b04-429e-97d8-fb7b34515c7a` used 25 and 6. Both reached 24 model turns.
- **Expected:** The candidate uses the learned behavioral contracts to require less discovery and fewer corrections.
- **Delta:** The candidate repeatedly listed `src/routes/`, `src/middleware/`, and `src/` although the blinded workspace exposed `src/server.js`.

## Hypotheses

#### H1: Candidate degradation is caused by redundant skill reads

- **Layer:** code-logic
- **Prediction:** Candidate events contain a model-issued `skill.read` after automatic loading.
- **Evidence:** Sequence 3 records one automatic `skill.loaded`; the role-filtered tool catalog contains no `skill.read`, and no later skill read occurs.
- **Verdict:** REJECTED
- **Rationale:** The one-read rule is working in this run.

#### H2: Candidate degradation is caused by governance-tool wandering

- **Layer:** code-logic
- **Prediction:** Candidate events contain marketplace, harness, evolution, or knowledge calls.
- **Evidence:** The role-scoped catalog exposes only six file/process tools, and every recorded candidate call is in that set.
- **Verdict:** REJECTED
- **Rationale:** Control-plane tool filtering is working.

#### H3: Historical `relevantPaths` are presented as authoritative current-layout instructions

- **Layer:** state-data
- **Prediction:** The installed skill names absent source paths, the selected-skill wrapper labels the whole skill authoritative, and the candidate probes those paths before using actual workspace files.
- **Evidence:** Skill frontmatter lists `src/routes/locations.js`, `src/routes/lots.js`, `src/middleware/payloadLimit.js`, and `src/app.js`; the transfer fixture uses `src/server.js`. The system wrapper says “authoritative,” and the first candidate command is `ls ... src/routes/ src/middleware/ src/`.
- **Verdict:** PROVEN
- **Rationale:** Retrieval metadata from the learned project is incorrectly elevated into a claim about the holdout's physical layout.

## 5 Whys

1. **Why did the candidate use more discovery calls?** It repeatedly searched for paths that do not exist in the transfer fixture.
2. **Why those paths?** They are the selected skill's `relevantPaths`.
3. **Why did it treat them as required?** The runner labels the entire selected skill authoritative without separating behavioral contracts from retrieval metadata.
4. **Why is that wrong for transfer?** `relevantPaths` decide applicability in the source project; generalized work may place analogous behavior elsewhere.
5. **Why did the benchmark reveal it?** Its changed-path fixture correctly tests whether the skill transfers a procedure rather than memorizing layout.

## Falsification

- **Check performed:** Inspect the exact skill markdown, candidate tool trace, tool surface, and skill-read events.
- **Result:** The first probed paths exactly match absent skill frontmatter paths, while both alternative loop sources are absent.
- **Conclusion:** H3 uniquely predicts the candidate-only overhead.

## Root Cause

- **Immediate cause:** The selected-skill prompt conflates path applicability cues with current workspace facts.
- **Architectural root:** Skill metadata has no model-facing distinction between retrieval evidence and portable behavioral guidance.
- **Rejected H1:** No redundant skill read occurred.
- **Rejected H2:** No governance tools were available.

## Fix

- State that `relevantPaths` are historical retrieval cues, not guaranteed current paths.
- Make behavioral contracts authoritative only when current repository instructions and code do not contradict them.
- Require one workspace inspection, then mapping to observed analogous files; prohibit repeated probing of absent skill paths.
- Preserve exact paths when the current workspace actually contains them.

