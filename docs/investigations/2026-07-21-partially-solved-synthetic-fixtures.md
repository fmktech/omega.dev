# Synthetic fixtures can contain most of the reference solution

## Symptom

- **Observed:** evaluator session `session_61aa70a5-e1af-4fe1-aab1-349dfc130c09` returned three starting workspaces containing nearly complete storage implementations. Its negative control asked for another behavior inside the learned storage contract.
- **Expected:** positive fixtures begin before the learned procedure and isolate a small transfer; the negative control matches an explicit exclusion cue and requires none of the learned procedure.
- **Delta:** the compiler rejects only when all checks already pass. A starting fixture may satisfy most checks and still be accepted when one superficial check fails.

## Hypotheses

### H1: Baseline validation is all-or-nothing across the check list

- **Layer:** synthetic suite compiler.
- **Prediction:** a fixture satisfying one of two verifier checks while failing the other is accepted.
- **Evidence:** `parseProposal` calls `checksPass(files, checks)` once and rejects only when the aggregate is true.
- **Verdict:** **PROVEN**.

### H2: Fixture size limits prevent reference solutions

- **Layer:** compiler byte and file bounds.
- **Prediction:** the production proposal would exceed the current 32-file or 256 KiB cap.
- **Evidence:** it uses three files per fixture and remains far below the byte cap while embedding complete domain implementations.
- **Verdict:** falsified.

### H3: Negative-control semantics are stated precisely enough

- **Layer:** evaluator objective.
- **Prediction:** the prompt requires an explicit `doesNotApplyWhen` cue and prohibits positive learned contracts in the negative objective.
- **Evidence:** it only says “adjacent task where the learned behavior must not trigger,” and the model chose empty-name validation from the positive contract.
- **Verdict:** falsified.

## 5 Whys

1. **Why can a candidate appear helpful without transferring the whole procedure?** Most expected output can already exist in the fixture.
2. **Why is that accepted?** One missing check makes the aggregate verifier false.
3. **Why does one false check suffice?** The gate was designed only to reject fully solved fixtures.
4. **Why is the negative control also ambiguous?** It does not bind the model to the opportunity's explicit exclusion cues.
5. **Why did tests miss both cases?** They cover a fully solved baseline and variation count, but not a partially solved baseline or the evaluator's exclusion instruction.

## Falsification check

If every individual verifier check were required to fail before execution, a partially solved fixture could not pass compilation and H1 would be false. The current aggregate check permits it.

## Resolution target

Require every verifier check to be unsatisfied by the untouched fixture; use invariants for content that must already hold. Tell the evaluator that negative control must match at least one explicit exclusion cue and must request none of the positive learned contracts.
