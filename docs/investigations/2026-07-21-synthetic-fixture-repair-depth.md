# Synthetic fixture repair depth

## Observed failure

After the evaluator corrected `files` from an array to an object, the same job failed because a generalization invariant required `node:http` in an empty starting file. The second error was discoverable only after the first shape error was repaired.

## Hypotheses

1. **The repaired proposal is actually valid and persistence failed after compilation.** This predicts all checks false and all invariants true on its starting files.
2. **The repaired proposal has another independent static defect, but the lifecycle permits only one validation repair.** This predicts a field-specific compiler rejection that a second feedback turn could correct without seeing candidate or benchmark results.
3. **The evaluator is ignoring validation feedback entirely.** This predicts the first reported `files` shape defect remains unchanged.

## Evidence and conclusion

Hypothesis 2 is proven. The repaired proposal changed every `files` array into the required path-to-content object, falsifying hypothesis 3. Its `src/adapter/http.js` content is empty while an invariant requires it to contain `node:http`, so static compilation correctly rejects `fixtures.1.invariants`, falsifying hypothesis 1. The service immediately fails after the single repair compile.

## Five whys

1. Why did a substantially corrected suite still fail? A second invariant defect remained.
2. Why was it not corrected? The lifecycle performs exactly one repair attempt.
3. Why can one attempt be insufficient? Validation is staged and the first structural error can mask later semantic errors.
4. Why not disclose all errors at once? The compiler returns one typed error and short-circuits, which keeps its contract simple and deterministic.
5. Why did this require human intervention? Repair orchestration assumed one model correction would make the entire untyped proposal valid.

## Fix and falsification test

Run a bounded maximum of three static repair sessions, each receiving only the latest validator error, opportunity, and previous proposal. Candidate text, benchmark execution, scores, and promotion outcomes remain unavailable. A lifecycle test will require two sequential repairs before compilation succeeds; if the job fails or benchmarks before the second repair, the fix is incomplete.
