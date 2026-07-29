# TypeScript test-quality skill benchmark — 2026-07-20

## Outcome

The project-scoped `write-tests-typescript` skill did **not** demonstrate a reliable capability improvement over the same unassisted author model.

- Incumbent: **26/27** hidden mutations killed across three paired replicates
- Candidate with skill: **26/27** hidden mutations killed
- Pair deltas: **0, −1, +1**
- Candidate skill retrieval: **3/3** correct, with exactly one immutable read per session
- Gemini rubric score: incumbent **99/100** average; candidate **100/100** average
- Promotion result: **reject** because the required executable improvement was not met

The secondary judge nearly saturated for both arms and would have suggested a small candidate advantage. The executable mutation oracle correctly showed that this was noise, not a repeatable increase in defect detection.

## Method

DeepSeek V4 Flash authored tests in six fresh, isolated copies of the same sparse TypeScript repository. Each replicate paired:

1. an incumbent harness with no test-authoring skill; and
2. a candidate harness advertising `write-tests-typescript`, which the agent had to retrieve exactly once.

The order reversed in the second replicate. Both conditions used the same objective, source, written behavioral contract, weak seed test, model route, process tools, file interlocks, limits, and hidden evaluator. Evaluation results were never returned to either author and no candidate was selected between runs.

The primary admission gate required:

- the native `node:test` suite to pass twice;
- strict TypeScript compilation to pass;
- the production source hash to remain unchanged; and
- each of nine single-fault production mutations to be tested independently.

The fixture was calibrated before the paired run. Its sparse seed suite passed and killed **0/9** mutations; a known reference suite passed and killed **9/9**. This proves that the benchmark can distinguish weak from complete tests.

Gemini 3 Flash Preview then classified findings under the mechanical TypeScript test-quality rubric. Omega, rather than the model, applied the rubric's fixed deduction values, caps, floors, total, and verdict. Judge evidence was secondary and could not override executable failures.

## Paired results

| Replicate | Incumbent kills | Candidate kills | Delta | Incumbent judge | Candidate judge | Survivor |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 9/9 | 9/9 | 0 | 100 | 100 | none |
| 2 | 9/9 | 8/9 | −1 | 100 | 100 | candidate: `capacity-atomicity` |
| 3 | 8/9 | 9/9 | +1 | 97 | 100 | incumbent: `maximum-units` |
| **Total / mean** | **26/27** | **26/27** | **0** | **99** | **100** | — |

The candidate's replicate-two atomicity test was not discriminating: after route sorting, the insufficient route failed before any successful reservation. The mutant that changed “check all, then reserve all” into an interleaved check/reserve loop therefore produced the same observation. A useful regression test must arrange an earlier sorted route that succeeds and a later route that fails, then assert that neither route was reserved.

## Model and resource evidence

All authors used OpenRouter `deepseek/deepseek-v4-flash`, served by GMICloud, with high reasoning and temperature 0. All judges used OpenRouter `google/gemini-3-flash-preview`, served by Google. Each incumbent/candidate pair had comparable author route signatures.

| Author condition | Model turns | Tool calls | Input tokens | Output tokens | Provider cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| Incumbent | 21 | 30 | 137,492 | 25,318 | $0.017477 |
| Candidate | 34 | 44 | 220,757 | 23,116 | $0.022069 |

The candidate used **60.6% more input tokens**, **61.9% more turns**, **46.7% more tool calls**, and cost **26.3% more**, without improving aggregate mutation kills. The skill was successfully discoverable, but its generic checklist mostly induced more analysis around behaviors that the explicit fixture contract had already enumerated.

## Interpretation

This is a valid null result, not evidence that skills cannot improve test writing. The task contract already described almost every hidden behavior, so an unassisted capable model was near the benchmark ceiling. The skill mainly repeated a systematic process rather than supplying missing project knowledge. Three replicates also remain too few for small effects, although the symmetric `−1/+1` outcomes give no directional signal worth scaling yet.

The result exposes two design requirements for the skill foundry:

1. promotion must depend on behavioral defects caught, not rubric prose or judge preference;
2. learned skills should encode a specific, reusable testing insight that the base prompt does not already reveal.

The atomicity survivor provides such an insight: for an “all checks before any writes” invariant, the fixture must make at least one earlier operation succeed before a later operation fails. It should become a development lesson, then be evaluated on a new sealed fixture—not added to this skill and re-scored against the same nine mutations.

## Limits and next benchmark

This benchmark uses one synthetic project and one function family. It does not yet establish transfer across Vitest/Jest, React components, databases, HTTP boundaries, timers, or unfamiliar project conventions. Gemini's score is also insensitive near the top of the rubric, which is why it remains diagnostic rather than promotional.

The next version should contain several sealed project fixtures with different testing stacks and bug structures. At least one should withhold important edge cases from the task prose so the skill's discovery process—not contract copying—is measured. Promotion should require improvement across fixture families, preserve negative controls, and retain the same no-feedback paired protocol.

## Durable evidence

- Benchmark record: `~/.omega/benchmarks/typescript-test-quality/cfd1465a1f93bb6f5b136ba83a34c01ac74b5c8f628c2ee0cae1067467c141e5.json`
- Benchmark plan: [`typescript-test-quality-plan.md`](./typescript-test-quality-plan.md)
- Writer skill: [`../../skills/write-tests-typescript/SKILL.md`](../../skills/write-tests-typescript/SKILL.md)
- Grader skill: [`../../skills/grade-tests-typescript/SKILL.md`](../../skills/grade-tests-typescript/SKILL.md)

