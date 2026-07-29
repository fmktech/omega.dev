# Synthetic evaluation budget coupling

## Observed failure

A production synthetic-skill paired run gave each workspace arm the reflection request budget (`maxProcessStarts: 1`, `maxModelCalls: 12`). The incumbent spent its only process start on `ls -la`, all later process starts were rejected, and the session ended with `budget-exceeded` after 12 model turns without implementing or verifying the task.

## Hypotheses

1. **The task fixture was malformed or missing the files named by its objective.** If true, the first successful process output or fixture object should show an unusable workspace.
2. **The runner failed to account for a completed process and treated a concurrency limit as permanently consumed.** If true, the task budget should allow multiple starts while the process supervisor rejects starts after a prior process exits.
3. **The reflection synthesis budget was copied directly into every generated benchmark task.** If true, the compiled suite task budget should exactly equal the evolution request budget, including its proposal-oriented single-process limit.

## Evidence and conclusion

Hypothesis 3 is proven. The event trace for `session_4831ed92-3146-4716-a990-449b673fb5d2` records a successful `ls -la` process followed by repeated `process.start` attempts and terminal `budget-exceeded`. `compileSkillEvalSuite` assigns `input.budget` to every task, and `evolution-service` passes `diagnosing.request.budget` as that input. Hypothesis 1 is falsified by the successful listing of the expected fixture. Hypothesis 2 is falsified because `maxProcessStarts` is intentionally a cumulative task budget, not a concurrency limit.

## Five whys

1. Why did the benchmark arm fail without editing? It exhausted its process-start and model-call budgets during discovery.
2. Why was only one process start available? The generated task inherited `maxProcessStarts: 1`.
3. Why did it inherit that value? The compiler reused the evolution request's proposal budget as the workspace execution budget.
4. Why were those budgets shared? The initial contract modeled one budget and did not distinguish proposal synthesis from trial execution.
5. Why was this not caught? Unit fixtures supplied a generous budget and asserted fixture structure, but no lifecycle test used a deliberately tiny proposal budget and checked the resulting task budget.

## Fix and falsification test

Give synthetic workspace trials an explicit daemon-configured budget independent of the evolution proposal budget. Add a lifecycle regression test that starts evolution with a one-process proposal budget and asserts all compiled task budgets use the configured synthetic-task budget. If task budgets still equal the tiny proposal budget, the diagnosis is false or the fix is incomplete.
