---
type: investigation
symptom: "Evolution children succeed, but a no-artifact post-session reflection job becomes failed while mutating."
slug: post-session-reflection-source-provenance
date: 2026-07-21T09:27:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8e
branch: main
repository: fmktech/omega.dev
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-21-post-session-evolution-parent-terminal.md
  - docs/investigations/2026-07-21-evolution-runner-startup-budget.md
---

# Post-session reflection cannot cite its source session

## Symptom

- **Observed:** Evolution job `95b506c4-1535-4500-a60f-f02323c0fc4b` created both children; builder and independent evaluator completed successfully; the job then changed from `diagnosing` to `failed` without a candidate or scorecard.
- **Expected:** A completed source session is sufficient provenance for post-session reflection even when no extra evidence artifact IDs are supplied.
- **Delta:** The model returned a valid evolve reflection with `sourceIds: []`, exactly matching the prompt's statement that the allowed artifact list was `none`.

## Hypotheses

#### H1: The prompt permits a completed conversation as evidence but the parser requires at least one explicit artifact ID

- **Layer:** evolution prompt/provenance validation
- **Prediction:** Replaying the exact final builder text through `parseReflectionProposal(text, [])` returns a source-reference validation error.
- **Evidence:** The exact replay returned `modelOutput.lessons.0.sourceIds: Reflection lesson cites unknown or missing evidence references`. `evolutionObjective` says completed project conversations may be reflected, but tells the child to cite only explicit artifact IDs (`none`) and supplies a placeholder artifact in its example.
- **Verdict:** PROVEN

#### H2: The independent fixture proposal is malformed

- **Layer:** skill-foundry evaluator parsing
- **Prediction:** `compileSkillEvalSuite` rejects before candidate mutation.
- **Evidence:** The job never obtained a candidate and `execute` calls `mutate` before compiling the evaluator output. Builder reflection parsing therefore fails first. Evaluator returned all three named variations in one JSON object.
- **Verdict:** REJECTED

#### H3: The children actually failed and the job only lagged behind their terminal state

- **Layer:** session lifecycle
- **Prediction:** At least one child record or event log has a non-success terminal outcome.
- **Evidence:** Both child logs end in `session.completed:succeeded`; each has a final `model.completed` with `finishReason: stop` and a recorded model-response artifact.
- **Verdict:** REJECTED

## 5 Whys

1. **Why did mutation fail?** Its reflection proposal had no accepted source reference.
2. **Why was the source list empty?** The API request had no extra evidence artifacts and the prompt said only those IDs could be cited.
3. **Why should that still work?** The evolution request always names a completed source session, which is the primary evidence for post-session learning.
4. **Why was the source session excluded?** Provenance validation modeled only auxiliary artifacts, despite the candidate schema already storing `sourceSessionId` separately.
5. **Why was this missed?** Lifecycle tests always supplied a conversation artifact ID; there was no no-artifact completed-session case.

## Falsification

The exact provider output, not a reconstructed fixture, was passed to the production parser and produced the specific source-reference error. Child outcome, model completion, JSON extraction, and evaluator ordering were independently checked. Changing model budget or retry timing cannot make an empty allowed artifact set satisfy a non-empty citation invariant.

## Root Cause

The source session is mandatory in `EvolutionRequest` and persisted in skill provenance, but it is neither presented nor accepted as a lesson source ID. The prompt/parser contract therefore makes artifact-free post-session reflection impossible.

## Fix

Treat `sourceSessionId` as the primary allowed evidence source. Prompt the child to cite it, accept it in parsing, and normalize an empty source list to that session for compatibility with already-completed children. Keep unknown references rejected. Add an end-to-end evolution lifecycle regression with no auxiliary artifacts.

## Resolution

The source session is now prompted and accepted as primary evidence; empty legacy source lists normalize to it, while unknown references remain rejected. Detailed skill guidance is bounded at 4,096 characters so a complete procedure is not lossily rejected. No-artifact lifecycle and multi-step guidance regressions plus full presubmit pass. Retrying the unchanged production outputs parsed the reflection and stored candidate `harness_5dae27be1f83064c307197bff8555cfd2fce99f4b2faaa7bef64c33a95e0b843`.
