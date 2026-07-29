# Empty provider `finishReason: error` bypasses clean retry

## Symptom

- **Observed:** Storage feedback Round 4 ended after an empty OpenRouter response with zero usage, no content, no first token, and `finishReason: "error"`.
- **Expected:** A provider-side error before any visible output should enter the model router's bounded clean-retry path.
- **Delta:** The OpenRouter adapter translated the SDK finish event into `model.completed`; the router retries only `model.failed`, so the initial runner terminalized the session.

## Hypotheses

### H1 — Session capability or wall-time budget was exhausted

- **Layer:** session budgeting
- **Prediction:** The trace shows a budget error after many model/process operations or elapsed wall time near the configured limit.
- **Evidence:** The session ended at event 35 after seconds, with only a handful of model turns against limits of 128 calls and one hour.
- **Verdict:** REJECTED

### H2 — A malformed runner tool request caused protocol termination

- **Layer:** runner protocol
- **Prediction:** The last model completion contains a tool call whose mapped runner request violates protocol validation.
- **Evidence:** The last completion contains no content and no tool call. It is a provider finish event with reason `error`.
- **Verdict:** REJECTED

### H3 — The adapter misclassifies a provider error finish as successful completion

- **Layer:** OpenRouter adapter / model router
- **Prediction:** The persisted response has no visible output and zero usage but is recorded as `model.completed`; adapter code maps SDK `finishReason: "error"` directly into a completion instead of yielding a recoverable failure.
- **Evidence:** Artifact `artifact_c6ed3f2c-0a5b-41d3-a643-fc86e41492b0` contains empty content, zero tokens, no first token, and `finishReason: "error"`. `openrouter-adapter.ts` maps that value into `completed`; `model-router.ts` only retries pre-visible `failed` events.
- **Verdict:** PROVEN

## Root cause — five whys

1. Why did a transient provider error fail the whole feedback session? Because the runner received a terminal completion with reason `error`.
2. Why did the runner receive a completion rather than a recoverable failure? Because the adapter treats every SDK finish event as completion, including `error`.
3. Why did the model router not retry it? Because bounded clean retry is intentionally keyed to recoverable `failed` events before visible output.
4. Why is that distinction important? Retrying after visible text or tool calls could duplicate side effects, while this response had no visible output and is safe to retry.
5. Why was the case untested? Existing retry tests cover SDK `error` stream parts and HTTP failures, but not an SDK `finish` part whose reason is `error`.

## Fix

Translate an OpenRouter SDK finish event with mapped reason `error` into a recoverable `provider-unavailable` failure after recording usage. The model router will retry it only when no output has become visible; after visible output it will forward the failure without retry, preserving side-effect safety.

## Falsification condition

This diagnosis is false if a boundary test with an empty `finishReason: error` does not trigger one bounded clean retry, or if a failure after visible output is retried and duplicates output.

