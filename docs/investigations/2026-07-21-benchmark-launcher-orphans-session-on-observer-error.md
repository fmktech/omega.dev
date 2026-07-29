# Investigation: benchmark launcher orphans a session on observer error

Date: 2026-07-21
Status: resolved

## Symptom

Paired evaluation job `95b506c4-1535-4500-a60f-f02323c0fc4b` became `failed` at `2026-07-21T12:41:20.016Z`, while its candidate benchmark session `session_defaf6d9-fcad-4c15-ab0e-b026c99fd224` remained non-terminal with its runner alive.

## Evidence preserved

- The candidate session's three provider calls all completed; the final `model.completed` is at `12:41:19.854Z`.
- The runner appended `skill.loaded` at `12:41:19.946Z`.
- The evolution job failed 70 ms later, matching the benchmark launcher's next repository poll.
- That poll rejects `skill.loaded` because of the independently proven persistence schema drift.
- `createBenchmarkRunLauncher.execute` returns immediately on a failed repository observation and its outer `catch` only maps thrown errors; neither path cancels a session already started.
- The outer `finally` removes the materialized workspace even while the orphan runner still owns it.

## Hypotheses

1. **Provider/model layer:** the model stream exceeded its deadline and ignored abort.
   Rejected: all three `model.started` records have matching `model.completed` records; the last completed before the job failure.
2. **Evolution layer:** `finishFailed` knew the benchmark session ID but failed to cancel it.
   Rejected as the direct cause: the evolution job only records proposal/evaluator session IDs; the benchmark session ID is encapsulated inside the launcher and never returned on launcher failure.
3. **Benchmark launcher lifecycle:** a post-start error exits without cancelling the owned session.
   Proven: the repository observation error follows an unguarded `return observed`, and cleanup only removes the fixture directory.

## Five whys

1. Why did the benchmark session remain active after the job failed? Because no cancellation was requested for it.
2. Why was cancellation not requested? Because the launcher returned the observer error directly.
3. Why could the caller not clean it up? Because a failed launch result carries no benchmark session ID.
4. Why did the launcher's `finally` not own session cleanup? It only owns fixture-directory deletion; cancellation is implemented only for abort and wall-time branches.
5. Why was this not caught? Launcher lifecycle tests cover explicit abort but not an infrastructure failure after `startBenchmarkTask` succeeds.

## Root cause

`createBenchmarkRunLauncher.execute` lacks a failure guard that terminalizes a benchmark session it has successfully started. Any repository, verifier, artifact, or observation failure after start returns control while the runner/session remains active.

## Falsification condition

This diagnosis is false if a post-start repository observation failure still leaves a non-terminal session after the launcher adds an owned-session failure guard.

## Resolution

The launcher now tracks whether cancellation has been attempted and, in its post-start `finally`, cancels any still-running owned session before returning an infrastructure failure. Explicit abort and wall-time paths remain single-attempt. The regression injects a repository observation failure after start and proves one cleanup cancellation occurs. Full presubmit passes (190 unit tests, conformance, and E2E). The previously orphaned real session was also terminalized after its event log became readable.
