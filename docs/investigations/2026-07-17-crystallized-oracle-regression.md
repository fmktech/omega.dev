---
type: investigation
symptom: "The experience-fed mini-style harness failed nonstandard-test-oracle@1 while its unfed parent passed the same paired task."
slug: crystallized-oracle-regression
date: 2026-07-17T22:06:00-03:00
investigator: Foad Kesheh
git_commit: 055b825749109636851b777c8339163da0e90d4c
branch: main
repository: fmktech/omega.dev
status: resolved
hypotheses_formed: 4
hypotheses_rejected: 3
hypotheses_proven: 1
related:
  - docs/testing/crystallization-benchmark-plan.md
  - docs/investigations/2026-07-17-benchmark-zero-model-turns.md
---

# Crystallized project guidance regresses the oracle transfer task

## Symptom

- **Observed**: Scorecard `77a2654ca0d39891384cb5c2b0288dd65d8c206f4403a2b230a4c66759dc6966` records `nonstandard-test-oracle@1` as passed for unfed harness `harness_2713d9f414fce252023164b8e5094d19b18e8f572e89c81314654f379bf1ac7b` and failed for experience-fed harness `harness_4e0210234fe4327b0b894b34ed2325332d387bfd86437d02bfe647e0149b9a8c`.
- **Expected**: The fed candidate should preserve the parent's capability and ideally benefit from the process-derived lesson “Use repository's authoritative checker to guide fixture regeneration.”
- **Delta**: Parent passed 1/10 and candidate passed 0/10, producing a -0.10 success-rate delta and rejection.

## Reproduction

1. Generate a crystallization proposal from the six frozen daily-work trajectories with DeepSeek V4 Flash on GMICloud.
2. Compile the proposal into a mini-style candidate derived from the unfed baseline.
3. Run the sealed paired suite:

   ```sh
   pnpm cli paired omegabench-10@1 \
     harness_2713d9f414fce252023164b8e5094d19b18e8f572e89c81314654f379bf1ac7b \
     harness_4e0210234fe4327b0b894b34ed2325332d387bfd86437d02bfe647e0149b9a8c
   ```

4. Read the durable scorecard. Verified 2026-07-17: parent oracle session `session_7ac42c22-7e70-4daa-9a32-584af63f05c7` passed with 11 model turns and 10 process starts; candidate oracle session `session_8aeca5ee-2303-418d-bb44-655e81c0eaf9` failed with 2 model turns and 2 process starts.

## Hypotheses

#### H1: The extra always-on guidance causes premature completion by making the model believe the task is solved after recognizing a familiar pattern

- **Layer**: code-logic / prompt behavior
- **Prediction**: The candidate oracle trace will finish after fewer inspections or edits than the parent and will call the completion sentinel before producing `answer.dat = 42` or running `./oracle` successfully.
- **Verification method**: Compare model completions, bash commands, process output, and final diff artifacts for the paired oracle sessions.
- **Evidence**:

  ```text
  candidate seq=5  calls=1 commands=ls -la
  candidate seq=15 calls=3 commands=cat answer.dat || cat oracle || cat TESTING.md
  candidate failed: provider-unavailable Tool results are missing for tool calls call_b707d310a394409c8e89f652, call_fcc0fba4792c444db7a74e57.
  ```

- **Verdict**: REJECTED
- **Rationale**: The candidate did not complete prematurely. Its second action was a valid three-call inspection, followed immediately by a protocol-level model failure.

#### H2: GMICloud intermittently fails to honor the bash tool schema, creating an observation artifact unrelated to crystallized guidance

- **Layer**: dependency / integration
- **Prediction**: Failed parent and candidate traces will contain plain-text action attempts or format-retry messages without corresponding bash tool calls, while the passing parent oracle trace will contain valid bash tool calls.
- **Verification method**: Inspect recorded model content and runner events across one passing and multiple fast-failing sessions on both harnesses.
- **Evidence**:

  ```text
  candidate seq=15 calls=3 commands=cat answer.dat || cat oracle || cat TESTING.md
  parent seq=16 calls=3 commands=cat verify.ps1 || cat README.md || cat AGENTS.md
  ```

- **Verdict**: REJECTED
- **Rationale**: GMICloud emitted correctly structured bash tool calls on both sides. The subsequent error explicitly reports missing results for two accepted call IDs rather than malformed tool output.

#### H3: The candidate executes appropriate commands but the isolated process or fixture verifier loses their filesystem effects

- **Layer**: state-data / process integration
- **Prediction**: The candidate trace will show a successful write of `answer.dat`, a successful `./oracle`, and a final diff containing `42`, yet the private verifier will still fail.
- **Verification method**: Compare process output, final diff artifact, report artifact, and private verifier result for the candidate session.
- **Evidence**:

  ```text
  candidate process starts: ls -la; cat answer.dat
  candidate next event: model.failed, missing results for cat oracle and cat TESTING.md
  candidate final verifier outcome: failed
  ```

- **Verdict**: REJECTED
- **Rationale**: The candidate never wrote `answer.dat` or ran `./oracle`; no successful filesystem change was lost below the model layer.

#### H4: The mini-style runner records all parallel tool calls but executes and answers only the first, making the next model request invalid

- **Layer**: code-logic / model integration
- **Prediction**: Whenever a completion contains three tool calls, the session will start one process, then OpenRouter will reject the next request because two assistant tool-call IDs have no tool-result parts.
- **Verification method**: Compare the runner implementation with both candidate and unfed-parent event sequences.
- **Evidence**:

  ```text
  src/harness/mini-swe-baseline.ts runner source:
  messages.push({role:"assistant",content:event.completion.content});
  executeCall(calls[0]);

  candidate:
  seq=15 calls=3 commands=cat answer.dat || cat oracle || cat TESTING.md
  failed: provider-unavailable Tool results are missing for tool calls call_b707d310a394409c8e89f652, call_fcc0fba4792c444db7a74e57.

  unfed parent:
  seq=16 calls=3 commands=cat verify.ps1 || cat README.md || cat AGENTS.md
  failed: provider-unavailable Tool results are missing for tool calls call_75443504d331400ba19ea1be, call_45997bcdcf5d4015a9c746fa.
  ```

- **Verdict**: PROVEN
- **Rationale**: The implementation and two independent traces match the predicted one-result/two-missing-result failure exactly.

## 5 Whys

Symptom: The experience-fed candidate lost the oracle task and most pairs failed quickly.

1. **Why?** Its second completion contained three bash calls, but only `cat answer.dat` ran; the next model request failed because results for `cat oracle` and `cat TESTING.md` were missing.
2. **Why?** The adapter stores the complete assistant content and then calls `executeCall(calls[0])`, deliberately discarding every remaining call.
3. **Why?** The first mini-style adapter assumed the upstream one-action-per-turn behavior while exposing an AI SDK tool schema that permits multiple calls in one completion.
4. **Why?** The adapter test covered a single completion sentinel but no multi-call completion or assistant/tool-result cardinality invariant.
5. **Why?** The baseline was treated as a prompt/organization comparison, but protocol adaptation is executable harness behavior and requires its own conformance cases.

## Falsification

- **Check performed**: Absence test for crystallized guidance. An unfed-parent session on `operating-system-mismatch@1` emitted three valid bash calls in one completion.
- **Result**:

  ```text
  parent seq=16 calls=3 commands=cat verify.ps1 || cat README.md || cat AGENTS.md
  failed: provider-unavailable Tool results are missing for tool calls call_75443504d331400ba19ea1be, call_45997bcdcf5d4015a9c746fa.
  ```

- **Conclusion**: The same failure occurs without crystallized guidance and survives the counter-hypothesis check. Guidance may change how often the model emits parallel calls, but it is not the protocol defect.

## Root Cause

- **Immediate cause**: `src/harness/mini-swe-baseline.ts` preserves every assistant tool call but executes only `calls[0]`, violating the model conversation requirement that every tool call receive a result before the next generation.
- **Architectural root**: The mini-style behavioral adapter imported a one-action assumption without enforcing it at the model boundary or supporting the AI SDK's multi-call output shape, and its conformance test omitted that boundary case.
- **Rejected H1**: The candidate did not submit early; it failed immediately after a valid three-call inspection.
- **Rejected H2**: The provider emitted valid typed calls and named the exact missing result IDs.
- **Rejected H3**: No requested edit or oracle process occurred, so filesystem persistence was never exercised.
- **Falsification survived**: An unfed parent reproduced the same three-call/missing-results sequence.

## Fix

- Execute every tool call from one completion sequentially, collect one result for each call ID, append the assistant message once and the complete tool-result message once, then request the next model turn.
- Treat the completion sentinel as a terminal action only when it is the sole call in the completion; reject or error mixed completion batches rather than silently dropping work.
- Add a runner conformance regression test that sends two ordinary bash calls in one completion and proves both process requests occur before the next model request.

## Resolution

- Refactored the mini-style adapter to execute every call in a completion sequentially, collect all results, and make the next model request only after the result cardinality matches the assistant call cardinality.
- Mixed completion-sentinel batches now fail closed instead of silently discarding ordinary calls.
- Added the regression test `returns one result for every bash call before requesting another model turn` in `src/harness/harness-runtime.test.ts`.
- Mutation proof: substituting the legacy first-call-only behavior made the test fail because it observed `model.start` where the second `process.start` was required; restoring the fix made it pass.
- Clean live reproduction: scorecard `8fdd909b9fe9ce9bed13277c924138ea237a1411e57a7774a5d18fa441063ef3` completed all 20 runs with no missing-tool-result model failures. The fed harness passed the oracle task and the unfed parent failed it.
- Full repository presubmit is recorded in the benchmark report after the live run.
