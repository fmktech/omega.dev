---
type: investigation
symptom: "A relevant canonical skill is excluded because a negative cue containing 'not trim whitespace' matches a positive objective containing 'trims whitespace'."
slug: negative-skill-cues-ignore-polarity
date: 2026-07-27T15:44:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8ebr
branch: main
repository: git@github.com:fmktech/omega.dev.git
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-27-skill-contracts-are-not-retrieval-complete.md
  - docs/investigations/2026-07-27-raw-skill-delta-bypasses-reflection-contract.md
---

# Negative skill cues ignore polarity

## Symptom

- **Observed:** Near-transfer candidate session `session_38252a19-7652-4520-b980-529f46aecdbe` passes the hidden verifier in 8 turns and 9 tool calls versus the incumbent's 21/21, but records zero skill reads and is correctly reclassified `skill-not-loaded`.
- **Expected:** The objective's positive requirement “listLots trims locationId whitespace” must not match a negative cue “listLots may … not trim whitespace.”
- **Delta:** Opposite statements are treated as the same exclusion.

## Hypotheses

#### H1: Positive applicability did not reach the selector threshold

- **Layer:** retrieval-scoring
- **Prediction:** No positive cue shares two retained tokens with the objective.
- **Evidence:** `deleteLocation` plus `lots`, and `HTTP` plus exact status/boundary cues, independently meet the threshold.
- **Verdict:** REJECTED
- **Rationale:** The positive side is sufficient after the previous fixes.

#### H2: The canonical skill was absent from bootstrap

- **Layer:** context
- **Prediction:** The model cannot name or attempt to read the candidate component.
- **Evidence:** The session sees the skill summary, explicitly judges it relevant, and attempts `skill.read`.
- **Verdict:** REJECTED
- **Rationale:** Catalog bootstrap succeeds.

#### H3: Negative-cue tokenization retains words under explicit negation

- **Layer:** retrieval-logic
- **Prediction:** `isExcluded` uses polarity-blind `cueTokens` for the negative cue, so `listLots`, `return`, `trim`, and `whitespace` cross the overlap ratio.
- **Evidence:** Source does exactly that. The objective-side tokenizer is polarity-aware, but cue-side matching is not. Four of six retained cue tokens overlap, exceeding the 0.6 exclusion threshold.
- **Verdict:** PROVEN
- **Rationale:** The exact cue/objective pair deterministically reproduces exclusion.

## 5 Whys

1. **Why was a passing candidate run classified as failed?** It did not load the required skill.
2. **Why did automatic loading fail?** The skill was placed in `excludedSkillIds`.
3. **Why did a negative cue match?** Negated terms were counted as affirmed terms.
4. **Why is only one side polarity-aware?** `isExcluded` receives affirmed objective tokens but calls plain `cueTokens` on the exclusion itself.
5. **Why does this matter to self-improvement?** Learned negative applicability becomes more likely to suppress the exact positive contract it is meant to distinguish.

## Falsification

- **Check performed:** Recompute positive scores and negative overlap from the stored frontmatter and session objective, then inspect the selector implementation.
- **Result:** Positive selection qualifies; only the polarity-blind negative cue prevents loading.
- **Conclusion:** H3 uniquely explains the zero-read run.

## Root Cause

- **Immediate cause:** Negative applicability cues are tokenized without negation scope.
- **Follow-up evidence:** After polarity-aware tokenization, a repaired cue split by a comma—`listLots does not filter or does not trim whitespace from locationId, or returns wrapped array`—still retains `listLots`, `return`, and `array`. Those three tokens are 60% of the affirmed negative cue and therefore still exclude the positive objective `listLots ... returns the raw array`.
- **Architectural root:** Applicability matching has asymmetric semantic normalization and an overly permissive fuzzy threshold for non-anchor hard exclusions.

## Fix Direction

- Apply affirmed/polarity-aware token extraction to negative cues as well as objectives.
- Require at least 80% token agreement for non-anchor hard exclusions; authentication, network, framework, SQL/database, and installation anchors remain immediate exclusions.
- Preserve hard exclusions for affirmed anchors such as authentication/framework requirements.
- Regression-test the exact `not trim whitespace` versus `trims whitespace` pair and the existing authentication exclusion.
- Upgrade the active runner and rerun the full suite.
