# Investigation: session model-call budget is not cumulative

Date: 2026-07-21
Status: resolved

## Symptom

Synthetic candidate session `session_8d6a77a8-3bd9-4297-a13e-021626b857c9` persisted 24 `model.started` / `model.completed` turns even though its immutable capability envelope sets `maxModelCalls: 12`.

## Hypotheses

1. **Metrics layer:** `modelTurns` double-counts deltas or artifacts rather than actual model calls.
   Rejected: the append-only session log itself contains 24 distinct `model.started` events and 24 completions.
2. **Benchmark configuration layer:** the task accidentally received a higher model-call budget than requested.
   Rejected: the persisted session header contains `maxModelCalls: 12`.
3. **Dispatch/router enforcement layer:** the limit is checked as a per-request boolean but no cumulative session ledger is consulted.
   Proven: `ModelRouter.stream` rejects only when `capabilities.maxModelCalls < 1`; `RunnerProtocolDispatcher` starts every matching request without reading prior `model.started` events.

## Five whys

1. Why did the candidate make 24 calls under a limit of 12? Every request carried the same unchanged envelope and passed the same `12 < 1` check.
2. Why was prior use ignored? Neither the router nor dispatcher maintains or reads session consumption.
3. Why is the envelope insufficient by itself? It is an immutable upper bound, not a mutable counter.
4. Why should accounting use the session log? The log already durably records each accepted `model.started`, survives daemon restart, and is the benchmark's semantic trace.
5. Why was this not caught? Model tests validate zero/nonzero and per-request output limits, while dispatcher tests issue only one model request.

## Root cause

The model-call budget has no cumulative accounting seam. Enforcement treats `maxModelCalls` as permission for each individual request rather than the maximum accepted calls in one session.

## Falsification

The diagnosis is false if a dispatcher with one prior `model.started` event still invokes the provider when `maxModelCalls` is one after durable ledger enforcement is added.

## Resolution

Before accepting `model.start`, the dispatcher now reads the append-only session ledger and counts prior `model.started` events. At the limit it returns and persists a typed `budget-exceeded` failure without invoking the provider. This survives daemon restarts and serializes naturally with the runner request pump. The regression proves a session with one accepted call under a limit of one cannot start another provider stream. Full presubmit passes (192 unit tests, conformance, and E2E); real-run verification remains the next benchmark step.
