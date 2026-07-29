# Investigation: generated skill benchmark starts from solved fixtures

Date: 2026-07-21
Status: resolved

## Symptom

The first real synthetic skill promotion suite gives both incumbent and candidate complete implementations before either agent acts. The resulting paired score cannot measure whether the candidate skill helps solve the task.

## Evidence preserved

- The evaluator response for `skill-foundry-e49970c91fe7398d8ab00bd2@1` defines full `server.js`, `pipeline.js`, `test.js`, `index.html`, and `package.json` implementations under each fixture's `files` map.
- Seven of eight near-transfer verifier substrings are already present in a complete starting implementation; only a superficial test-style token is absent.
- Every generalization verifier substring is already present in the starting files (6/6).
- Every negative-control verifier substring is already present in the starting files (4/4).
- `compileSkillEvalSuite` stores `{ files: fixture.files }` as the public workspace fixture without checking baseline verifier status.
- The evaluator prompt calls `files` a fixture but never says they are starting inputs rather than reference outputs.

## Hypotheses

1. **Runner layer:** the agent copied hidden verifier answers into the workspace.
   Rejected: the complete files are present in the evaluator's proposal and are materialized before the runner starts; hidden checks remain separate.
2. **Verifier layer:** the checks are too weak but every workspace still requires meaningful implementation.
   Rejected: the generalization and negative-control workspaces pass untouched, while the near-transfer workspace starts with a complete solution and misses only one superficial token.
3. **Skill-foundry generation/validation layer:** the ambiguous prompt encouraged reference solutions and the compiler accepted an already-green baseline.
   Proven: the response contains solutions under `files`, and compilation has no baseline-red gate.

## Five whys

1. Why can an untouched workspace pass? Because complete expected outputs were placed in the fixture; two of three verifier sets are entirely true at materialization time.
2. Why are the expected outputs in the fixture? Because the evaluator interpreted `files` as files to generate, not starting inputs.
3. Why was that interpretation accepted? The prompt does not define baseline semantics.
4. Why did deterministic validation not catch it? The compiler validates shape, size, paths, and check syntax but never evaluates checks against the starting map.
5. Why would retries not solve it reliably? Prompt-only guidance is probabilistic; without a compiler gate another evaluator can emit a solved fixture again.

## Root cause

The synthetic skill-foundry contract does not distinguish starting files from expected outputs and lacks a deterministic baseline-red validation gate. Consequently, a model-generated reference solution becomes the public fixture and already satisfies its hidden verifier.

## Falsification condition

This diagnosis is false if the exact production evaluator proposal compiles after the prompt is clarified and compilation rejects every fixture whose verifier already passes against its starting files.

## Resolution

The evaluator prompt now defines `files` as starting inputs and explicitly forbids reference solutions and completed outputs. The compiler deterministically requires each untouched fixture to fail at least one verifier check and satisfy every negative invariant. Regressions cover both gates, and full presubmit passes (190 unit tests, conformance, and E2E). Replaying the exact production evaluator response now fails closed at `fixtures.1.checks` before any object is stored.
