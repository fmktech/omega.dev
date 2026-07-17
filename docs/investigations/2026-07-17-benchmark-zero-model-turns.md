---
type: investigation
symptom: "A live OmegaBench smoke test failed in 1.389 seconds with zero model turns."
slug: benchmark-zero-model-turns
date: 2026-07-17T10:24:00-03:00
investigator: Foad Kesheh
git_commit: 0ec7d919df4fe179bdfb1220f9867793157e7b90
branch: main
repository: fmktech/omega.dev
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/benchmarks/2026-07-17-deepseek-v4-flash-evolution.md
---

# Benchmark smoke test records zero model turns

## Symptom

- **Observed**: The command below returned a completed `BenchmarkRun` with `outcome: "failed"`, `wallTimeMs: 1389`, `modelTurns: 0`, `processStarts: 0`, and `retries: 1`.
- **Expected**: The mini-style candidate should start DeepSeek V4 Flash, execute bash actions, and reach the hidden verifier.
- **Delta**: The benchmark failed before its first model generation or tool action.

The durable session event is:

```json
{"kind":"model.failed","streamId":"stream_start_failed_runner-1","error":{"kind":"provider-unavailable","providerId":"openrouter","reason":"Credential environment variable OPENROUTER_API_KEY is not set","recoverable":true,"callerAction":"choose-different-route"},"partialArtifactId":null}
```

## Reproduction

1. Keep daemon PID `56209` listening on `127.0.0.1:7337`.
2. Run either the mini-style candidate or the already-promoted Omega harness on one task:

   ```sh
   OMEGA_API_TOKEN=… pnpm cli benchmark omegabench-10@1 unexpected-build-tool@1 <harness-id>
   ```

3. Inspect the persisted session events.

Verified 2026-07-17: candidate session `session_000edbb0-1390-4547-98cb-70698f368cce` and incumbent session `session_fb136900-46b6-4f40-933e-c150d3b1ff93` both failed before a model turn.

## Hypotheses

#### H1: The new mini-style runner emits an invalid model request

- **Layer**: dependency/integration
- **Prediction**: If H1 is true, only the mini candidate will fail before its first turn; the promoted Omega runner will reach OpenRouter under the same daemon.
- **Verification method**: Run `unexpected-build-tool@1` with both harness IDs through the same daemon.
- **Evidence**:

  ```text
  mini candidate: modelTurns=0, processStarts=0, wallTimeMs=1389
  promoted Omega: modelTurns=0, processStarts=0, wallTimeMs=929
  ```

- **Verdict**: REJECTED
- **Rationale**: A different, previously successful runner produced the same pre-generation failure.

#### H2: The daemon process does not contain an exported OPENROUTER_API_KEY

- **Layer**: configuration/environment
- **Prediction**: If H2 is true, the interactive zsh can hold a shell-local key while child processes and daemon PID `56209` report it absent.
- **Verification method**: Check presence without printing the credential in zsh, a Node child, a pnpm Node child, and the daemon environment.
- **Evidence**:

  ```text
  OPENROUTER_API_KEY=present
  node_child_key=missing
  pnpm_child_key=missing
  daemon_key=missing
  ```

- **Verdict**: PROVEN
- **Rationale**: `.zshrc` assigns the variable but does not export it. The shell can read it; spawned Node processes cannot.

#### H3: OpenRouter or GMICloud rejected the request because of availability or rate limiting

- **Layer**: external dependency
- **Prediction**: If H3 is true, a request reaches the provider and returns provider HTTP/stream evidence, with a generation attempt rather than a local credential lookup failure.
- **Verification method**: Inspect the first terminal model event and aggregate usage.
- **Evidence**:

  ```text
  reason="Credential environment variable OPENROUTER_API_KEY is not set"
  modelTurns=0
  inputTokens=0
  outputTokens=0
  costUsdMicros=0
  ```

- **Verdict**: REJECTED
- **Rationale**: The provider registry failed locally before any OpenRouter request.

## 5 Whys

Symptom: The benchmark failed before its first model turn.

1. **Why?** The model router returned `provider-unavailable`.
2. **Why?** `OPENROUTER_API_KEY` was absent from the daemon's injected environment.
3. **Why?** The variable in `.zshrc` was shell-local rather than exported.
4. **Why?** Sourcing `.zshrc` made a presence check pass but did not make the value inheritable by `node` or `pnpm` children.
5. **Why?** Daemon readiness validates the API bearer token and listener, while provider credentials are intentionally checked only when their adapter starts a generation.

## Falsification

- **Check performed**: Adjacent-cause and cross-harness test.
- **Result**: The promoted Omega runner failed identically, eliminating candidate protocol behavior. A direct child-process check showed the key missing even though the parent zsh saw it. The provider was never contacted.
- **Conclusion**: H2 survived; H1 and H3 do not explain the evidence.

## Root Cause

- **Immediate cause**: Daemon PID `56209` lacks an exported `OPENROUTER_API_KEY`, exactly matching the provider registry failure in `src/models/provider-registry.ts`.
- **Architectural root**: Provider credentials are process-only by design and provider-specific readiness is lazy. A shell-local assignment is therefore indistinguishable from a usable credential until a model call.
- **Rejected H1**: The incumbent runner is a direct counterexample.
- **Rejected H3**: Zero usage and the local missing-credential message prove no provider request occurred.

## Fix

- Operationally restart the daemon only after `export OPENROUTER_API_KEY` in the launching shell.
- Preserve the process-only credential design; do not read `.zshrc` from Omega.
- Existing regression test: `src/models/model-routing.test.ts` — “reads credentials only from the injected environment.”
- Before the benchmark, assert the key is inherited by a Node child without printing its value.

## Resolution

- Restarted the daemon after explicitly exporting the existing shell variable and added a child-process presence assertion to the launch command.
- Repeated the candidate smoke test: DeepSeek V4 Flash was served by GMICloud, produced two model turns, consumed 1,113 input tokens and 185 output tokens, and started two processes. The task-level verifier failed, but the zero-turn credential symptom was eliminated.
- No product code changed for this incident. Process-only credential injection remains intact, and the existing missing-environment regression test remains green.
