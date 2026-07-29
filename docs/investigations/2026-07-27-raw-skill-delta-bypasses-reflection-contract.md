---
type: investigation
symptom: "A synthetic skill evolution creates a candidate SKILL.md with no catalog frontmatter despite strict reflection applicability validation."
slug: raw-skill-delta-bypasses-reflection-contract
date: 2026-07-27T15:33:00-03:00
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
  - docs/investigations/2026-07-27-skill-contracts-are-not-retrieval-complete.md
---

# Raw skill delta bypasses the reflection contract

## Symptom

- **Observed:** Candidate `harness_b4b31f1c…` contains one skill object beginning `# Storage App Corrections Skill` with no YAML frontmatter. Its benchmark candidate session records no `skill.loaded` event.
- **Expected:** Skill-only synthetic evolution compiles a validated reflection proposal into canonical frontmatter, observable-contract ledger, bounded protocol, and companion lessons.
- **Delta:** The candidate skips the canonical compiler completely.

## Hypotheses

#### H1: The canonical skill renderer lost frontmatter

- **Layer:** rendering
- **Prediction:** `createReflectionSkillCandidate` produced the object but omitted its header.
- **Evidence:** Canonical renderer tests pass and prior reflection candidates contain valid frontmatter. This candidate component entrypoint is plain `SKILL.md`, not the canonical `skills/<name>/SKILL.md` path.
- **Verdict:** REJECTED
- **Rationale:** The canonical renderer was not used.

#### H2: Context bootstrap failed to parse otherwise valid frontmatter

- **Layer:** context
- **Prediction:** The stored object contains a `---` header but catalog parsing rejects it.
- **Evidence:** The object starts directly with a Markdown heading and contains ad-hoc `AppliesWhen` prose only in its body.
- **Verdict:** REJECTED
- **Rationale:** There is no catalog metadata to parse.

#### H3: Skill evolution accepts a raw component delta after reflection parsing fails

- **Layer:** evolution-control-flow
- **Prediction:** `childMutation` tries reflection parsing and then falls through to generic `parseDelta`, allowing a skill document to bypass validation.
- **Evidence:** Source implements exactly that fallback. The evolution prompt explicitly offers either raw component JSON or reflection JSON, and the model chose the raw form.
- **Verdict:** PROVEN
- **Rationale:** The fallback explains the stored shape and missing retrieval metadata exactly.

## 5 Whys

1. **Why was no skill loaded?** The candidate's skill catalog entry has no applicability metadata.
2. **Why is metadata absent?** The object is raw model-authored Markdown, not canonical compiled output.
3. **Why was raw Markdown accepted?** A failed reflection parse falls through to generic component-delta parsing.
4. **Why did the model choose that format?** The prompt presents raw component JSON as the primary answer and reflection as optional.
5. **Why is this dangerous to the loop?** The benchmark can spend all paired runs evaluating a candidate that was never structurally capable of retrieval.

## Falsification

- **Check performed:** Compare candidate manifest entrypoint/object bytes with `childMutation`, the evolution prompt, and canonical renderer output.
- **Result:** Every observable difference follows the raw-delta branch; no renderer or context failure is needed.
- **Conclusion:** H3 is the unique root cause.

## Root Cause

- **Immediate cause:** Synthetic skill evolution has two mutation paths with unequal validation.
- **Architectural root:** The daemon does not enforce one canonical representation boundary for learned skills.

## Fix Direction

- For skill-only synthetic evolution, require reflection JSON and reject raw component deltas.
- Remove the conflicting raw-component option from that child prompt.
- Keep generic component deltas for non-synthetic/manual component evolution.
- Regression-test that a raw `SKILL.md` proposal reaches `failed` without creating a candidate or starting paired evaluation.
