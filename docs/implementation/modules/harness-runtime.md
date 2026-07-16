# Module: harness-runtime

## Owns

`src/harness/harness-repository.ts`, `runner-host.ts`, `activation-service.ts`, `initial-harness.ts`, and `harness-runtime.test.ts`.

## Implements

Implement `HarnessRepository`, `RunnerHost`, and `HarnessActivationService`. Store immutable manifests/components, launch the mutable runner through bidirectional JSONL, expose the minimal initial tool set, atomically promote/pin/rollback project pointers, and deliver safe-boundary harness updates. Derive evaluator authority from the incumbent and accept only `PromotableScorecard` for promotion.

## Edge cases and gates

Test malformed/partial runner JSONL, stale tool schema, runner crash, mixed harness versions in one session, active-process version binding, duplicate component objects, invalid parent lineage, activation CAS conflicts, rejected scorecards, rollback, and notification while idle versus inside an active call.

