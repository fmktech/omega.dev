# Oversized synthetic skill fixtures exhaust task budgets

## Symptom

- **Observed:** synthetic suite `skill-foundry-79361bef64752a5e6c2a753e@1` asked its near-transfer and generalization trials to build complete multi-module web applications. Candidate trials exhausted the 12-call task budget and failed even after reading the skill once.
- **Expected:** the three hidden fixtures isolate whether one learned procedure transfers. The full-project replay is the separate end-to-end holdout.
- **Delta:** the evaluator was told only to keep fixtures “tiny”; it still emitted four-file, multi-layer application objectives with 12–13 independent checks.

## Hypotheses

### H1: The synthetic-evaluator contract has no mechanical scope limit

- **Layer:** evaluator objective.
- **Prediction:** the prompt uses qualitative language but does not cap changed files, behaviors, or checks, nor distinguish the synthetic check from the full replay.
- **Evidence:** `skillEvalObjective` says “tiny” but specifies no bounds. The production evaluator emitted complete library and warehouse applications across domain and HTTP layers.
- **Verdict:** **PROVEN**.

### H2: The candidate skill was not retrievable

- **Layer:** benchmark context bootstrap.
- **Prediction:** candidate trials would show zero skill reads.
- **Evidence:** near-transfer and generalization candidate runs each recorded one successful skill read.
- **Verdict:** falsified.

### H3: The provider failed before task execution

- **Layer:** model provider/router.
- **Prediction:** runs would terminate with provider errors before consuming their allowed calls.
- **Evidence:** the trials executed model/tool turns through the 12-call budget and produced workspace changes; failure occurred at task completeness, not provider startup.
- **Verdict:** falsified.

## 5 Whys

1. **Why did the synthetic comparison report no benefit?** Both conditions failed broad application-building objectives within the task budget.
2. **Why were the objectives broad?** Each fixture asked for an entire web app spanning repository, domain, HTTP, entrypoint, and many contracts.
3. **Why did the evaluator generate that scope?** “Keep fixtures tiny” was qualitative and unenforced in the objective.
4. **Why was a full app accepted as a skill fixture?** The contract did not state that synthetic fixtures isolate one procedure while workspace replay owns end-to-end validation.
5. **Why did tests miss it?** Lifecycle tests checked secrecy and variation count, but not explicit fixture-size instructions.

## Falsification check

If the evaluator objective already capped each fixture to a focused one-to-three-file change, limited checks, and prohibited complete-application objectives, H1 would be false. It does not.

## Resolution target

Make the evaluator objective explicitly reserve full-project validation for replay, limit each fixture to one focused procedure over at most three starting files and six checks, and forbid objectives that request a complete application or unrelated layers.
