---
type: investigation
symptom: "A correct reflection loses the contradiction-free point for explicitly prohibiting a forbidden command"
slug: reflection-scorer-negation-false-positive
date: 2026-07-27T18:19:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8e
branch: main
repository: fmktech/omega.dev
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/benchmarks/2026-07-19-reflection-skill-transfer.md
  - docs/benchmarks/2026-07-19-workspace-skill-transfer.md
---

# Reflection scorer treats prohibitions as recommendations

## Symptom

- **Observed:** The final real-workspace run scores reflection 9/10 with `contradictionFree:false` even though its guidance says `Never edit runtime/defaults.json directly or run npm test for auth changes`.
- **Expected:** Explicitly prohibiting the rubric's forbidden behavior earns the contradiction-free point.
- **Delta:** Lexical occurrence is scored as semantic endorsement regardless of polarity.

## Reproduction

1. Run `pnpm benchmark:workspace-skill-transfer 3`.
2. Inspect record `30eb98ec...f4a505.json`.
3. Observe the quoted prohibition and `contradictionFree:false` in the same reflection result.

## Hypotheses

#### H1: The contradiction scorer uses polarity-blind substring matching

- **Layer:** code-logic / observation
- **Prediction:** `scoreReflection` rejects a proposal whenever forbidden text appears, even when immediately governed by `never` or `do not`.
- **Verification method:** Inspect the scorer and apply it to the recorded guidance.
- **Evidence:**
  ```text
  src/evolution/reflection-benchmark.ts:464
  const contradictionFree = !rubric.forbiddenClaims.some((claim) =>
    allText.toLocaleLowerCase("en-US").includes(claim.toLocaleLowerCase("en-US")));

  guidance: "Never edit runtime/defaults.json directly or run npm test for auth changes"
  forbidden claim: "edit runtime/defaults.json directly"
  score: contradictionFree=false
  ```
- **Verdict:** PROVEN
- **Rationale:** The matcher has no polarity or historical-context branch; the forbidden substring occurs inside an explicit prohibition.

#### H2: The reflection actually recommends editing generated output

- **Layer:** state-data
- **Prediction:** Its actionable guidance directs the runner to write `runtime/defaults.json` or prefer `npm test`.
- **Verification method:** Read the complete persisted proposal.
- **Evidence:**
  ```text
  "edit config/service.toml, run tools/render-config ... then run ./verify-auth"
  "Never edit runtime/defaults.json directly or run npm test"
  ```
- **Verdict:** REJECTED
- **Rationale:** Both the positive procedure and negative boundary are correct.

#### H3: Parsing changed the model's negated sentence before scoring

- **Layer:** dependency-integration
- **Prediction:** The persisted `proposal.lessons[].guidance` omits or moves the negator.
- **Verification method:** Compare persisted proposal text with the scored object in the same record.
- **Evidence:**
  ```text
  persisted guidance retains the exact leading token "Never"
  persisted dimensions contain "contradictionFree": false
  ```
- **Verdict:** REJECTED
- **Rationale:** The semantic polarity reaches the scorer intact.

## 5 Whys

Symptom: A correct reflection receives 9/10.

1. Because the forbidden phrase appears inside an explicit prohibition.
2. Because contradiction detection is raw substring matching.
3. Because the first deterministic rubric modeled vocabulary but not polarity or historical narration.
4. Because measurement simplicity was favored without a fixture for `never/do not <forbidden behavior>`.
5. Because evaluator validity was not protected by mutation-like positive and negative language pairs.

## Falsification

- **Check performed:** Adjacent-cause check.
- **Result:** The same proposal's executable candidate passed all nine workspace holdouts, used canonical writes in 6/6 relevant cases, and never wrote generated output directly. This independent behavioral evidence contradicts the scorer's claim that the guidance endorses the forbidden behavior.
- **Conclusion:** H1 survives.

## Root Cause

- **Immediate cause:** `scoreReflection` treats lexical occurrence as endorsement.
- **Architectural root:** The rubric lacks polarity-paired evaluator fixtures and versioned semantic handling.
- **Rejected H2:** The actionable guidance explicitly requires the canonical source/regenerate/verify workflow.
- **Rejected H3:** Parsing preserves the negator.

## Fix

- Score contradiction only from actionable lesson text, not historical reflection narration.
- Treat explicit clause-local prohibition (`never`, `do not`, `must not`, `avoid`) as non-contradictory while retaining positive forbidden recommendations as failures.
- Add paired regression cases and bump the workspace benchmark record version before collecting a fresh series; do not rescore prior records.

## Resolution

- Added clause-local polarity handling for `never`, `do not`, `must not`, `should not`, `cannot`, `avoid`, `forbidden`, and `prohibited`, with contrast markers such as `but` restoring positive polarity.
- Evolve decisions score contradiction from actionable lesson titles/guidance; historical narration cannot create a false contradiction. No-change decisions continue scoring their reflection because they intentionally have no lessons.
- Added three polarity-paired regressions: explicit prohibition passes, a post-`but` recommendation fails, and a forbidden no-change generalization fails.
- Bumped the workspace record to version 5 with `reflectionScorerVersion: 2`; v4 evidence was not rescored.
- Fresh v5 evidence: reflection 10/10; candidate 9/9 workspace holdouts; 6/6 relevant reads; 3/3 correct non-reads; zero regressions; tool calls down 53.9%; provider cost down 21.6%.
- Authoritative record: `~/.omega/benchmarks/workspace-skill-transfer/668f7016c6c2ede3ca0eb61a672af07349767ab3836434f8ef75d2d8e9d51685.json`.
