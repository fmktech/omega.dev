---
type: investigation
symptom: "A behaviorally red executable fixture is rejected because a non-authoritative static sentinel is already true."
slug: static-baseline-sentinel-blocks-executable-suite
date: 2026-07-27T09:27:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8ebr
branch: main
repository: git@github.com:fmktech/omega.dev.git
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-21-deepseek-fixture-repair-nonconvergence.md
  - docs/investigations/2026-07-21-partially-solved-synthetic-fixtures.md
  - docs/investigations/2026-07-27-skill-foundry-static-verifier-rejects-correct-behavior.md
---

# Static baseline sentinel blocks executable suite

## Symptom

- **Observed:** Evolution job `25c93297-89e7-43e1-9d72-38ddf506c7bf` produced a private executable verifier, but compilation and three repair turns all failed at `fixtures.0.checks`.
- **Expected:** Positive capability is decided by the executable verifier; static predicates are diagnostic hints and cannot veto a behaviorally valid suite.
- **Delta:** The starting module is a TODO stub that fails its behavioral test, yet the compiler rejects it because the evaluator wrote `{contains:"TODO"}`, which is true before execution.

## Reproduction

1. Run a no-evidence storage-contract evolution with the executable-verifier schema.
2. Inspect the initial evaluator output and three repair child objectives.
3. Apply the static sentinel to starting files and inspect the hidden verifier.

Verified 2026-07-27:

```
checkPasses=[true]
hasExecutableVerifier=true
verifierFiles=["verify.mjs"]

repair 1: fixtures.0.checks
repair 2: fixtures.0.checks
repair 3: fixtures.0.checks
```

The starting `createLocation` returns `undefined`; the verifier immediately evaluates `loc.name`, so its executable baseline exits nonzero.

## Hypotheses

#### H1: The evaluator omitted or malformed the executable verifier

- **Layer:** dependency-integration
- **Prediction:** Compilation fails at `fixtures.0.verifier` or command/file validation.
- **Evidence:** `hasExecutableVerifier=true`, command is `node verify.mjs`, and every error field is `fixtures.0.checks`.
- **Verdict:** REJECTED
- **Rationale:** The executable schema passed validation.

#### H2: The fixture is behaviorally solved before the runner acts

- **Layer:** state-data
- **Prediction:** The starting functions satisfy the hidden runtime assertions.
- **Evidence:** `createLocation`, `deleteLocation`, and `listLots` are async TODO stubs. The first verifier assertion dereferences `loc.name` after `createLocation` returns `undefined`.
- **Verdict:** REJECTED
- **Rationale:** The executable baseline is deterministically red.

#### H3: A legacy per-static-check baseline gate vetoes the new authoritative executable verifier

- **Layer:** code-logic
- **Prediction:** Compilation rejects whenever any static check is true, without considering executable behavior.
- **Evidence:** `compileSkillEvalSuite` executes `checks.value.some((check) => checksPass(files, [check]))` and returns `fixtures.0.checks`. The sole `{contains:"TODO"}` sentinel triggers it even though the executable verifier is red.
- **Verdict:** PROVEN
- **Rationale:** The static proxy retained promotion authority after executable verification was introduced.

## 5 Whys

1. **Why did suite compilation fail?** A static check was true on starting files.
2. **Why did that veto compilation?** The former static verifier required every predicate to begin false.
3. **Why is that no longer valid?** Static predicates no longer decide post-task capability; the executable verifier does.
4. **Why was the old gate retained?** Executable verification was added incrementally without removing proxy-oracle assumptions from compilation.
5. **Why did repair not converge?** The evaluator interpreted `contains TODO` as a baseline marker while the compiler interpreted every check as a required post-task condition.

## Falsification

- **Check performed:** Compare both oracles on the untouched fixture.
- **Result:** The static sentinel is green, but the runtime verifier necessarily fails on `undefined.name` before later assertions. Therefore static-green does not imply behaviorally solved.
- **Conclusion:** H3 survives; H2 is directly contradicted.

## Root Cause

- **Immediate cause:** `compileSkillEvalSuite` still lets static check state reject executable suites.
- **Architectural root:** The migration from proxy checks to behavioral verification left two competing authorities.
- **Rejected H1:** Executable verifier parsing succeeded.
- **Rejected H2:** Starting functions are nonfunctional TODO stubs.

## Fix

- Remove static positive checks from suite validity and final capability decisions.
- Keep negative invariants as the static preservation boundary.
- Require executable verifier presence for all new Skill Foundry fixtures.
- Update the prompt and tests so `checks` are optional diagnostics, not an oracle.

