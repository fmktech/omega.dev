# Invalid synthetic evaluator proposals cannot self-correct

## Symptom

- **Observed:** evaluator sessions completed successfully but evolution jobs failed before evaluation because their fixture proposals violated deterministic compiler rules. Job `2382d1fb-090a-4228-9c6d-58316d44a5cd` used focused fixtures but produced baseline invariants with whitespace that was not present and checks already satisfied by starting files.
- **Expected:** compiler failures are safe, local feedback about the evaluator's own proposal—not benchmark results—and should permit one bounded correction turn.
- **Delta:** the service marks the entire evolution failed on the first `compileSkillEvalSuite` error and discards the actionable validation field/message.

## Hypotheses

### H1: Evolution has no evaluator repair transition

- **Layer:** evolution orchestration.
- **Prediction:** a failed suite compilation immediately calls `finishFailed` without spawning or resuming an evaluator.
- **Evidence:** `execute` branches directly from `if (!compiled.ok)` to `finishFailed(id)`.
- **Verdict:** **PROVEN**.

### H2: The compiler cannot explain the failure

- **Layer:** suite validation.
- **Prediction:** invalid results would contain only an opaque internal error.
- **Evidence:** compilation returns structured validation errors with exact fields such as `fixtures.0.invariants` and `fixtures.2.checks` plus corrective messages.
- **Verdict:** falsified.

### H3: Repairing a proposal would leak benchmark outcomes

- **Layer:** evaluator isolation.
- **Prediction:** the feedback would require incumbent/candidate scores or hidden execution results.
- **Evidence:** failure occurs before any benchmark run; repair needs only the evaluator's own proposal and static schema/baseline validation error.
- **Verdict:** falsified.

## 5 Whys

1. **Why did evolution stop despite a usable skill proposal?** Its independently generated suite failed static validation.
2. **Why could the evaluator not correct it?** Its session had already completed and the orchestrator had no repair transition.
3. **Why did the job fail immediately?** Compile errors are routed directly to terminal failure.
4. **Why is that wasteful?** The structured validation error precisely describes a local, bounded correction.
5. **Why did tests miss it?** Lifecycle tests supply a valid evaluator proposal and assert exactly two child sessions.

## Falsification check

If the service spawned one isolated correction child with the original proposal and compiler error, recompiled its response, and never exposed candidate/results, H1 would be false. It currently does not.

## Resolution target

Permit exactly one evaluator-repair child after a static suite-compilation failure. Persist the replacement evaluator session IDs, keep the same evaluator capabilities and isolation, expose only the prior proposal plus validation field/message, and fail closed if the repaired proposal remains invalid.
