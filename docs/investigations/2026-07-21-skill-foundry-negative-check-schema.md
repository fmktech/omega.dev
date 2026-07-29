---
type: investigation
symptom: "A parsed reflection candidate exists, but synthetic skill evaluation fails before paired runs."
slug: skill-foundry-negative-check-schema
date: 2026-07-21T09:36:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8e
branch: main
repository: fmktech/omega.dev
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-21-post-session-reflection-source-provenance.md
---

# Skill Foundry prompt and verifier disagree on negative checks

## Symptom

- **Observed:** After reflection parsing succeeded, candidate `harness_628251...` was stored, but the evolution job failed before recording a suite or scorecard.
- **Expected:** The independent evaluator's three-fixture output compiles into a private synthetic suite.
- **Delta:** The prompt advertises `{path,equals?,contains?,absent?}` without defining `absent`. The model used strings such as `{path:"index.html", absent:"require("}` to mean substring absence; the compiler only accepts boolean `absent` meaning the entire file must not exist.

## Hypotheses

#### H1: Ambiguous negative-check syntax makes valid model intent fail schema validation

- **Layer:** skill-foundry prompt/compiler/verifier contract
- **Prediction:** Compiling the exact evaluator output fails at a negative-control invariant whose `absent` value is a string.
- **Evidence:** Exact production-output replay returned `fixtures.2.invariants: Fixture check must define equals, contains, or absent`. Inspection shows string-valued `absent` checks; `parseChecks` discards them because it accepts only booleans.
- **Verdict:** PROVEN

#### H2: Candidate harness persistence failed

- **Layer:** harness repository
- **Prediction:** No child candidate exists after retry.
- **Evidence:** The project harness list contains candidate `harness_628251...` with the new skill component and incumbent parent.
- **Verdict:** REJECTED

#### H3: The evaluator returned malformed or incomplete JSON

- **Layer:** model output extraction
- **Prediction:** Parsing fails at the top-level fixture object or variation count.
- **Evidence:** The compiler reached the third fixture's invariant validation, proving the JSON, three fixtures, file maps, and preceding checks were parsed.
- **Verdict:** REJECTED

## 5 Whys

1. **Why was no suite created?** A negative invariant had no recognized operator.
2. **Why not?** The evaluator used `absent` for substring absence while the compiler reserves boolean `absent` for file absence.
3. **Why did the model choose that?** The prompt names optional fields without their types or semantics and offers no negative-content operator.
4. **Why can't the intended check be represented?** The verifier supports equality, positive containment, and missing files, but no `notContains` assertion.
5. **Why was this not caught?** Fixture tests used only the compiler's internal shape instead of a realistic evaluator response containing negative content invariants.

## Falsification

The exact evaluator output was replayed through production `compileSkillEvalSuite`; failure is deterministic and localized. Candidate existence rejects mutation failure, and the precise nested field rejects top-level JSON/variation hypotheses.

## Root Cause

The synthetic evaluator contract lacks an explicit negative-content assertion and leaves `absent` semantically ambiguous across prompt, compiler, and trusted verifier.

## Fix

Add `notContains: string` end to end. Clarify that `absent: true` means a missing file. Normalize legacy string-valued `absent` to `notContains` so completed evaluator outputs remain retryable. Add compiler and trusted-verifier regressions.

## Resolution

`notContains: string` is implemented end to end, `absent: true` is documented as whole-file absence, and legacy string-valued `absent` is normalized. Compiler and trusted-verifier regressions pass. Replaying the exact evaluator output now advances beyond its former negative-check failure and is rejected later by the independent baseline-red validity gate.
