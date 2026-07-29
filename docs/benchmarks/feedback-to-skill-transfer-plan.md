# Feedback-to-skill transfer benchmark plan

## Claim under test

Repeated corrections can transfer a previously unknown testing skill from the user's judgment into a project harness. After reflection, the evolved harness should produce stronger tests from the same vague request with fewer correction rounds, errors, and unnecessary actions on unseen modules.

## Learning episode

The unevolved harness receives only:

> Create good tests for `src/plan-dispatch.ts`. Do not modify production code.

It works in an isolated repository and finishes a test suite. A trusted evaluator runs native tests twice, strict TypeScript compilation, a source-integrity check, and ten hidden mutations. If any mutation survives, the evaluator acts as the user and returns procedural feedback without showing a patch or test implementation. The same workspace is retried for at most three correction rounds.

The completed trajectory—not merely the final tests—is reflected into a project-scoped candidate skill. Evidence includes the vague request, attempts, observable evaluator outcomes, user-like corrections, and final acceptance. The skill must capture general test-design procedure rather than module names or expected values.

## Sealed transfer

The incumbent and candidate receive three fresh modules with the same vague `Create good tests` request:

1. near transfer: feature-batch activation;
2. generalization: release publication;
3. distant transfer: ordered database migrations.

Each has a calibrated weak seed, a reference suite, and hidden behavioral mutations. Initial attempts receive no evaluator feedback. If an attempt is insufficient, correction may continue only to measure how many simulated user interventions each harness requires. No holdout result is fed into reflection or candidate revision.

## Edge-case gate

| Area | Benchmark evidence |
| --- | --- |
| Empty/nullish/missing | Empty batch mutations in training and holdouts |
| Boundaries | Zero, non-integer, exact maximum, and maximum+1 mutations |
| Invalid input | Invalid quantity/size branches |
| Dependency failure | Rejected writes must surface rather than become false success |
| Concurrency/ordering | Earlier sortable item succeeds, later item fails, and no writes may occur |
| Idempotency/duplicates | Aggregation, rejection, or deduplication according to each module contract |
| Unicode/encoding/timezone | Training injected-clock and UTC-boundary mutations; otherwise N/A |
| Runtime/configuration | Node ESM, built-in `node:test`, strict TypeScript, isolated offline container |

Every reference assertion has a named mutation that makes it fail. Calibration is invalid unless each seed misses at least one mutation and every reference suite kills all of its mutations.

## Scoring

Scoring is lexicographic:

1. executable validity and final mutation detection;
2. first-attempt hidden mutation kills;
3. number of evaluator/user feedback messages required;
4. invalid tool actions (reported separately from intentional red test executions);
5. model turns, tool calls, tokens, cost, and wall time as diagnostic evidence.

Efficiency cannot compensate for lower correctness. A candidate demonstrates transfer only when it is no worse at final correctness and is strictly better in first-attempt defect detection, feedback count, or—after ties—invalid tool actions. Model/provider/reasoning mismatches invalidate a pair.

## Leakage controls

- Initial and holdout prompts contain no rubric, mutation IDs, expected tests, or evaluator output.
- Learning feedback describes the missing reasoning pattern, not the hidden patch.
- Holdout source, mutations, and reference suites are absent from reflection evidence.
- Holdout results never mutate the candidate.
- Raw runs, feedback, reflection, installed skill, route signatures, and resource usage are persisted for audit.
