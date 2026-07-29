# Investigation: valid `skill.loaded` event rejected as malformed

Date: 2026-07-21
Status: resolved

## Symptom

Cancelling benchmark session `session_defaf6d9-fcad-4c15-ab0e-b026c99fd224` fails with `protocol-error` / `Stored session event is malformed`.

## Evidence preserved

- The session `events.jsonl` is 83,520 bytes, ends with a newline, and contains 12 non-empty lines.
- Every line parses as JSON and has the required top-level event fields.
- Sequence 12 has payload kind `skill.loaded`.
- `PersistedEventPayload` includes `skill.loaded` in `src/contracts/index.ts`.
- The separate `EVENT_KINDS` allowlist in `src/persistence/session-repository.ts` omits `skill.loaded`.

## Hypotheses

1. **Storage layer:** a provider interruption left a truncated or invalid JSONL line.
   Rejected: all 12 lines parse and the file has a terminating newline.
2. **Persistence schema layer:** the event is contract-valid but rejected by a stale handwritten kind allowlist.
   Proven: sequence 12 is `skill.loaded`; the contract contains it and the persistence allowlist does not.
3. **Client/API layer:** `session.cancel` decoded a valid repository result incorrectly.
   Rejected: the diagnostic is produced by `parseSessionEvent` before an API response is constructed.

## Five whys

1. Why could the session not be loaded? Because sequence 12 was classified as malformed.
2. Why was it classified as malformed? Because `EVENT_KINDS.has("skill.loaded")` returned false.
3. Why did the allowlist not recognize a legal event? Because persistence duplicates the contract's discriminants manually.
4. Why was the drift not caught? Because repository round-trip tests did not cover every persisted event variant.
5. Why can the defect recur? Because the duplicated runtime allowlist has no compile-time or exhaustive-test relationship to `PersistedEventPayload`.

## Root cause

The persistence parser maintains a stale handwritten event-kind allowlist independent of the contract union. `skill.loaded` was added to the contract and emitted by the runner, but not added to that parser allowlist.

## Falsification condition

This diagnosis is false if a repository round trip still rejects `skill.loaded` after the parser derives or exhaustively validates the contract-supported event kinds.

## Resolution

`PERSISTED_EVENT_KINDS` now lives beside the contract union and is checked with an exhaustive `Record<PersistedEventPayload["kind"], true>` constraint. Persistence derives its runtime set from that registry. A repository regression round-trips `skill.loaded`; full presubmit passes (190 unit tests, conformance, and E2E), and the preserved real session loaded and terminalized through `cancel-session` without a protocol error.
