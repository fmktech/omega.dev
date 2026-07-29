# Investigation: valid synthetic suite fails before first persisted run

Date: 2026-07-21
Status: resolved

## Symptom

Fresh evolution job `d1a0e51a-20a5-4a6d-906a-1770758c512f` compiled the new baseline-red suite, stored candidate `harness_8f331e0f…`, entered `evaluating` at `13:06:48.129Z`, and failed at `13:06:57.993Z`. No `BenchmarkRun` for the suite was persisted.

## Hypotheses

1. **Fixture/materialization layer:** the evaluator produced a compiler-valid file map that cannot be materialized or registered as a runnable workspace.
   Prediction: no benchmark session exists, or its workspace setup failed before `session.started`.
2. **Session/runner layer:** the first benchmark session started but failed due to policy, capability, runner startup, or model-route constraints.
   Prediction: a new promotion-eval session exists with a terminal failure and diagnostic event/artifact.
3. **Verifier/observation layer:** the session completed, but verifier parsing, artifact recording, or observation failed before the `BenchmarkRun` record was persisted.
   Prediction: the session is terminal and its event log reaches runner/model completion; no orphan remains because the launcher failure guard terminalized it.

## Hypothesis results

1. **Fixture/materialization — rejected.** A promotion-eval session was created for the materialized workspace, and an exact bind-mount permission probe succeeded as container user `1000:1000`.
2. **Session/runner startup — proven, specifically the fixed ready-handshake window.** The failed session contains only `session.started` and `session.completed:failed`, so launch failed before the runner event. `RunnerHost` permits only 100 polls × 10 ms (about one second) for Docker to create the container and emit `runner.ready`. The same exact header, workspace record, incumbent harness, image, user, mount, and runner source handshook in 306 ms when replayed. Retrying the frozen suite succeeded; its runner took 442 ms and the first `BenchmarkRun` persisted. This combination proves a transient startup outside the one-second window, not deterministic task or harness invalidity.
3. **Verifier/observation — rejected.** The failed session never reached `runner.started` or `model.started`; the retry subsequently reached verification with the identical suite.

## Evidence to collect

- Sessions and workspaces created after `13:06:48Z`.
- Their terminal states and compact event-kind/timestamp sequences.
- Diagnostic artifacts and daemon output around `13:06:57Z`.
- Materialized fixture lifetime and any launcher error exposed by direct reproduction.

## Root cause

`RunnerHost.start` uses a nominal one-second, poll-count-based ready-handshake limit for an OCI container launch. Normal observed starts already consume 306–442 ms, so modest Docker daemon or host load can exceed the limit. The host then kills a healthy-but-slow runner and the evolution job treats the infrastructure transient as a terminal benchmark failure.

## Five whys

1. Why did evaluation fail before its first run? The benchmark session could not record `runner.started`.
2. Why not? The runner did not emit `runner.ready` inside the fixed polling window.
3. Why is that window unreliable? It is only about one second and includes OCI container creation, not merely JavaScript initialization.
4. Why did a manual retry work? The frozen fixture, harness, route, and verifier were valid; Docker startup timing changed.
5. Why was this not caught? The runner-host fake emits readiness synchronously, so tests exercise protocol correctness but no realistic startup latency.

## Falsification

The diagnosis is false if a runner that becomes ready after the old one-second window still fails after the host uses a bounded wall-clock startup deadline large enough for local OCI variance.

## Resolution

Runner readiness now uses a 15-second wall-clock deadline instead of 100 nominal polls, remains bounded, and includes the bounded stderr tail in timeout diagnostics. A delayed-ready fake that crosses the old one-second boundary fails before the change and succeeds after it. The same frozen real suite persisted its first benchmark run on retry. Full presubmit passes (192 unit tests, conformance, and E2E).
