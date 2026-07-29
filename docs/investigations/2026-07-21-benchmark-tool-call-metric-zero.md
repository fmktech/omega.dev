# Benchmark tool-call metric is always zero

## Observed failure

Benchmark session `session_56e6d816-bd82-46bc-8c7b-b3ab6da1cf38` persisted `toolCalls: 0` despite its event log containing file reads, file writes, process starts/observes, and a knowledge write across 19 completed model turns.

## Hypotheses

1. **Model completions omit tool-call content after streaming, so the metric source has no tool evidence.** This predicts completion artifacts containing text only.
2. **The launcher computes tool calls but persistence drops the value.** This predicts a nonzero value in the pre-persistence launcher result.
3. **The launcher never assigns `toolCalls` and inherits zero from its baseline metrics object.** This predicts other explicitly assigned event metrics, such as process starts, are correct while tool calls remain zero.

## Evidence and conclusion

Hypothesis 3 is proven. Persisted `model.completed` events contain their final `tool-call` parts, and `observedBenchmark` derives model turns, process starts, policies, children, harness updates, and skill reads from events. It spreads `zeroMetrics` into the result but never overrides `toolCalls`, leaving it at zero. This falsifies hypothesis 1. No later persistence transform changes metrics, falsifying hypothesis 2.

## Five whys

1. Why was tool-call efficiency reported as zero? The metric remained at its initialized value.
2. Why was it never updated? `observedBenchmark` omitted a tool-call assignment.
3. Why did other metrics work? They each have explicit event-derived overrides.
4. Why did tests miss it? Launcher integration tests asserted outcome and isolation, not observed metric values.
5. Why does it matter? Equivalent-capability promotion and continual-learning reports cannot distinguish a concise harness from one that wastes calls.

## Fix and falsification test

Count final `tool-call` parts in persisted `model.completed` events and assign that value in `observedBenchmark`. A pure regression test will include multiple completions and assert the exact aggregate; if the count remains zero or counts text parts, the fix is incomplete.
