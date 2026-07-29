# Vague `process.input` schema lets a recoverable model call kill the runner

## Symptom

- **Observed:** Storage benchmark Generation 0 created the application, started an offline `npm install`, and polled it several times. Its next model turn called `process.input` with `{ "stdin": "" }`; the session immediately completed as failed with no `process.input` event and no process completion.
- **Expected:** The model should receive a precise process-control schema. A common legacy stdin form should be canonicalized into the typed protocol instead of producing an invalid runner envelope.
- **Delta:** The model-facing tool schema described `input` only as an unconstrained object, while runner-protocol validation accepts only `{kind:"data",encoding,data}`, `{kind:"close-stdin"}`, or `{kind:"signal",signal}`.

## Hypotheses

### H1 — The model provider failed after the final tool call

- **Layer:** model routing
- **Prediction:** The trace ends with `model.failed`, followed by terminal session failure.
- **Evidence:** Event 98 is a successful `model.completed` with finish reason `tool-calls`; there is no `model.failed` event.
- **Verdict:** REJECTED

### H2 — The running `npm install` exhausted the session or process budget

- **Layer:** budget/process supervision
- **Prediction:** The trace records a process timeout/cancellation or a budget-exceeded error before terminalization.
- **Evidence:** The session used 27 of 128 model calls, 2 of 64 process starts, and only about five minutes of a one-hour wall budget. No process completion or cancellation follows the final call.
- **Verdict:** REJECTED

### H3 — `process.input` crossed the runner boundary with a shape forbidden by the kernel protocol

- **Layer:** harness tool schema / runner protocol
- **Prediction:** The final model response uses an input shape admitted by the advertised schema but rejected by `isProcessInput`, and the embedded runner forwards it unchanged.
- **Evidence:** The advertised schema is `{ input: { type: "object" } }`. Event 98 contains `{input:{stdin:""}}`. `INITIAL_RUNNER.toolRequest` forwards `input.input`; `isProcessInput` accepts only the three discriminated protocol variants.
- **Verdict:** PROVEN

## Root cause — five whys

1. Why did Generation 0 terminate before verification? Because its final runner request was rejected as an invalid protocol envelope.
2. Why was the envelope invalid? Because `process.input.input` contained `{stdin:""}` instead of a supported discriminated control message.
3. Why did the model produce that shape? Because the tool's JSON schema said only that `input` was an object and gave no required discriminator or fields.
4. Why did the embedded runner not recover? Because it forwarded model input verbatim and treated protocol rejection as fatal runner failure.
5. Why was this not caught earlier? Because conformance tests validated kernel rejection but no executable initial-runner test exercised a plausible model-generated legacy stdin shape.

## Fix

Advertise the complete `data | close-stdin | signal` union in the model-facing schema. At the versioned runner boundary, canonicalize `{stdin: string}` to a UTF-8 `data` message and `{close: true}` to `close-stdin`; preserve already-valid typed messages. This does not weaken kernel validation or process authority.

## Falsification condition

This diagnosis is false if an executable initial-runner test shows `{stdin:""}` still crosses the boundary unmodified after the fix, or if a fresh live session sends a valid typed process input and terminalizes at the same boundary without a different recorded error.

