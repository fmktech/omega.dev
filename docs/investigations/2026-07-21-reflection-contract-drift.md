# Reflection drifts from exact developer contracts

## Symptom

- **Observed:** candidate skill `no-auth-locations-and-lots-storage-app-node-built-ins` changed the supplied `createLot(locations,lots,locationId,name)` contract to `createLot(locations,lots,name,locationId)` and changed stable `VALIDATION`/`NOT_FOUND` codes to `VALIDATION_ERROR`/entity-specific codes.
- **Expected:** exact signatures and literals stated in the evolution goal must be preserved verbatim in the crystallized guidance.
- **Delta:** the reflection prompt asks for actionable guidance but contains no explicit fidelity audit for exact identifiers, argument order, constants, commands, or paths.

## Hypotheses

### H1: The synthesis prompt does not distinguish exact constraints from paraphrasable guidance

- **Layer:** evolution child objective.
- **Prediction:** the objective requests completeness but never directs a verbatim audit of signatures/literals.
- **Evidence:** inspection of `evolutionObjective` confirms no such rule, while the generated skill altered both an argument order and code literals from the goal.
- **Verdict:** **PROVEN**.

### H2: The reflection compiler reordered parameters or renamed codes

- **Layer:** reflection skill compiler.
- **Prediction:** the builder artifact is correct but the stored Markdown differs.
- **Evidence:** the builder's guidance already contains the wrong order/names; the compiler preserves it.
- **Verdict:** rejected.

### H3: The source feedback itself specified the altered contracts

- **Layer:** training evidence.
- **Prediction:** the evolution goal asks for `name,locationId` and entity-specific codes.
- **Evidence:** the persisted goal explicitly says `locationId,name` and `VALIDATION, NOT_FOUND, CONFLICT`.
- **Verdict:** rejected.

## Root cause

The reflection model is invited to synthesize natural-language guidance without a final exact-contract audit, so it semantically paraphrases details that are actually API invariants.

## 5 Whys

1. **Why did the skill encode the wrong API?** Reflection reordered and renamed exact details.
2. **Why could it treat them as flexible?** The prompt called all content “guidance.”
3. **Why was there no exactness boundary?** The objective lacked a rule for signatures/literals/paths.
4. **Why was the compiler unable to catch it?** Generic project contracts cannot be inferred safely after generation.
5. **Why did tests miss it?** Lifecycle tests checked valid structure and provenance, not that prompt instructions demand verbatim preservation.

## Falsification condition

This diagnosis is false if, after adding an explicit authoritative-contract audit to the synthesis objective, the model still changes the same signatures and literals.
