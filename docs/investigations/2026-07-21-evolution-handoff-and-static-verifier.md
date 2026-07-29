# Evolution handoff and synthetic verifier investigation

## Observed failure

The completed 18-arm skill-foundry run rejected the candidate with a zero success-rate delta. One inspected near-transfer candidate produced the learned repository/domain split, including `crypto.randomUUID()` in `src/domain/repository.js`, but the hidden verifier required the literal `node:crypto` in `src/domain/storage.js`.

## Hypotheses

1. The candidate did not retrieve the generated skill.
2. Evolution and evaluation children were told that the completed parent session was evidence, but the built-in runner never loaded the supplied handoff artifact into model context.
3. The candidate retrieved the skill, but the generated static verifier encoded an implementation placement that was not an authoritative learned contract.

## Evidence and conclusion

Hypothesis 1 is falsified for the inspected positive run: its benchmark metrics record one skill read, and its model transcript contains the `skill.read` call.

Hypotheses 2 and 3 are proven. `RunnerStart` carries `handoffArtifactId`, while the built-in runner goes directly from `context.bootstrap` to `model.start` and never reads that artifact. Separately, the candidate wrote the learned ID-generation responsibility to `src/domain/repository.js`; the hidden check looked only for `node:crypto` in `src/domain/storage.js`. The benchmark report persisted only booleans, so this mismatch was not visible without reconstructing the private fixture and model transcript.

## Five whys

1. Why was a behaviorally plausible candidate rejected? The verifier demanded a source substring in a particular file.
2. Why did the verifier demand that placement? Synthetic fixtures can express only static file predicates, and the evaluator inferred placement from an incomplete evidence view.
3. Why was the evidence view incomplete? Child sessions received a handoff ID, but the runner did not put the handoff contents into model context.
4. Why was diagnosis slow? Benchmark reports stored only aggregate pass/fail booleans.
5. Why did the gate appear healthy? Pairing, isolation, and accounting worked, masking that the measurement itself was under-specified.

## Fix and falsification plan

- Load the supplied handoff once before the first model turn and label it as prior-session evidence, while preserving the existing no-handoff path.
- Persist per-check verifier and invariant diagnostics in the private benchmark report.
- Tighten synthetic fixture instructions so a check may pin a token to a path only when that exact placement is explicit in the supplied evidence; otherwise verify a less placement-sensitive contract.
- Falsification: a runner with no handoff must retain the old bootstrap sequence; a runner with a handoff must issue exactly one bounded `artifact.read` before `model.start`; a failing verifier must identify the failed predicate without exposing it to the task-solving session.
