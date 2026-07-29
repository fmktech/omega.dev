---
type: investigation
symptom: "A real Omega daemon session completes its first model tool call, then OpenRouter returns HTTP 400 on the continuation turn."
slug: daemon-tool-continuation-http-400
date: 2026-07-21T08:29:48-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8e
branch: main
repository: fmktech/omega.dev
status: resolved
hypotheses_formed: 4
hypotheses_rejected: 3
hypotheses_proven: 1
related:
  - docs/benchmarks/2026-07-21-operational-internalization.md
---

# Daemon tool continuation returns HTTP 400

## Symptom

- **Observed:** Three real daemon sessions terminated on a single recoverable OpenRouter `provider-unavailable` event—two after a successful `file.read`, and one on its first model request. An otherwise identical fourth session later completed successfully with no code, route, prompt, tool, or configuration change.
- **Expected:** The runner should append the assistant tool call and corresponding tool result, request the next model turn, receive a textual answer, and complete the session successfully.
- **Delta:** The first model call and kernel tool execution work, but the model continuation constructed by the deployed runner is rejected before producing a token.

Verbatim persisted event sequence from `session_8161ef73-25fa-458c-aee9-574c15e09f09`:

```text
sequence 5: model.completed ... finishReason="tool-calls" ... toolName="file.read"
sequence 6: model.started streamId="055abe45-9501-47fc-b0aa-7efdd9516b01"
sequence 7: model.failed ... kind="provider-unavailable" ... reason="Provider returned HTTP 400"
sequence 8: session.completed outcome="failed"
```

## Reproduction

Environment:

- daemon: PID 22981, `node dist/main.js`, cwd `/Users/fkesheh/projects/omega.dev`
- API: `127.0.0.1:7337`
- active harness: `harness_4ff2377aa58ea1cdad304f7af2213831c76cbf517775fbd780926d08362bc46b`
- route: OpenRouter `deepseek/deepseek-v4-flash`, serving provider GMICloud, high reasoning, temperature 0
- workspace: `/Users/fkesheh/projects/omega.dev`

Recipe:

1. Start a task whose first action is `file.read`.
2. Watch the append-only session events.
3. Observe the successful first completion and tool request.
4. Observe HTTP 400 on the immediately following model turn.

Verified twice on 2026-07-21:

```text
session_d901dcf8-e0f3-4e4a-a216-c77d6913b617: file.read + harness.status → second model turn HTTP 400
session_8161ef73-25fa-458c-aee9-574c15e09f09: file.read only → second model turn HTTP 400
```

The second reproduction removes `harness.status`, its large manifest, and parallel tool calls from the input.

After restarting onto the current build, the same task produced both outcomes:

```text
session_7c8aa8fa-fe9f-4580-8adb-00e44419c956: first model request → HTTP 400 → session failed
session_0c08ab47-fbbe-4443-abc5-e7cfa5c01477: file.read → continuation → textual answer → session succeeded
```

## Hypotheses

#### H1: The runner forwards the kernel's `Result` envelope as tool output instead of the successful value, producing a continuation shape rejected by this OpenRouter model route

- **Layer:** code-logic / dependency integration
- **Prediction:** The deployed runner tool result contains `{ok:true,value:...}` while the working benchmark loop sends the value directly. A minimal continuation using the wrapped envelope will fail and the same continuation using the unwrapped value will succeed.
- **Verification method:** inspect `INITIAL_RUNNER.runTools`, compare it with the working benchmark loop, then issue isolated current-router continuations with wrapped and unwrapped tool results.
- **Evidence:**
  ```text
  src/harness/initial-harness.ts runTools: const result=reply.result??reply
  src/app/runner-protocol.ts file.read: result: await context.files.read(...)
  src/evolution/typescript-test-quality-benchmark.ts: executeTool(...) returns the tool payload directly
  ```
- **Verdict:** REJECTED
- **Rationale:** Isolated requests through the current built router completed successfully with both the direct tool value and `{ok:true,value:...}` envelope. The envelope is undesirable protocol coupling, but it did not cause the observed failures.

#### H2: DeepSeek V4 Flash through OpenRouter cannot continue after tool calls

- **Layer:** dependency / provider capability
- **Prediction:** Every continuation with this route should fail, including the standalone TypeScript and workspace benchmark loops.
- **Verification method:** compare the daemon failure with preserved live benchmark records using the same route and multi-turn tools.
- **Evidence:**
  ```text
  operational internalization record c0fec146... completed six multi-turn workspace runs
  route: deepseek/deepseek-v4-flash through OpenRouter/GMICloud
  candidate macOS runs each read a skill, edited a file, ran processes, and completed naturally
  ```
- **Verdict:** REJECTED
- **Rationale:** The same model route successfully completed repeated tool continuations outside the daemon runner.

#### H3: The long-running daemon is executing stale adapter code incompatible with the current repository build

- **Layer:** tooling-build / configuration
- **Prediction:** A continuation sent through a freshly constructed router from the current build will succeed with the same runner-shaped messages, while the daemon fails.
- **Verification method:** run the identical continuation through the current built router, then restart only after preserving daemon state and compare.
- **Evidence:**
  ```text
  daemon PID 22981 predates the current build and remains attached to /dev/ttys075
  both failures were produced by that same long-running process
  ```
- **Verdict:** REJECTED
- **Rationale:** The freshly restarted daemon failed on its first request, then the same fresh daemon completed the identical task. Version skew cannot explain divergent outcomes from the same build.

#### H4: The shared production model path emits recoverable provider failures immediately and the runner converts every emitted failure into a terminal session failure

- **Layer:** architecture / control flow
- **Prediction:** Intermittent provider responses will produce intermittent terminal sessions even when the request is valid; identical requests will sometimes succeed, and production code will contain no bounded retry between the provider error and `session.completed: failed`.
- **Verification method:** repeat the exact daemon task without changing inputs, inspect the router and runner failure paths, and compare them with the benchmark model loop.
- **Evidence:**
  ```text
  identical production task: three terminal HTTP 400 failures followed by one successful two-turn completion
  src/models/model-router.ts: provider events are yielded directly; no retry is applied
  initial runner modelEvent: event.kind === "failed" immediately calls finish("failed")
  src/evolution/reflection-skill-transfer-benchmark.ts: completeWithRetries makes up to three attempts for recoverable provider failures
  OpenRouter adapter classifies the HTTP response as recoverable provider-unavailable
  isolated continuation probe: direct and Result-wrapped tool outputs both succeeded
  isolated full-tool-catalog probe: all tools, first half, and second half all succeeded
  ```
- **Verdict:** PROVEN
- **Rationale:** The same valid production request both failed and succeeded without any input change, while the production path has no recovery behavior despite receiving a typed recoverable error. The benchmark path explicitly supplies the missing recovery and therefore does not exhibit the same terminal fragility.

## 5 Whys

1. **Why did a routine harness task fail?** The runner received one `model.failed` event and immediately completed the session as failed.
2. **Why did one provider event terminate the session?** The runner treats every model failure identically and ignores `recoverable` and `callerAction`.
3. **Why was recovery not performed before the runner saw the failure?** `ModelRouter.stream` forwards provider events directly and has no bounded retry policy.
4. **Why do benchmarks appear more reliable than the deployed harness?** Benchmark modules independently implement `completeWithRetries`, while the production daemon uses the unretried shared router.
5. **Why did retry behavior diverge?** Recoverability is represented in the contract as data but was never made an invariant of the shared routing seam, allowing individual consumers to implement—or omit—it.

## Falsification

The strongest competing explanation was a malformed continuation. It was falsified in three ways:

1. A minimal continuation completed with both the direct file payload and the runner's `{ok:true,value:...}` payload.
2. Requests carrying the full production catalog of 15 tool schemas completed successfully, excluding deterministic schema or request-size rejection.
3. The identical real daemon task later completed its `file.read` continuation successfully without a code, prompt, route, or configuration change.

Adjacent cause check: a non-recoverable validation, capability, protocol, or budget failure must still surface immediately. The fix is limited to bounded retries for `provider-unavailable` and `provider-rate-limited` failures before any output has been emitted; it must not replay a partially emitted response because that could duplicate text or tool calls.

## Root Cause

The shared production model router does not operationalize its own typed recoverability contract. It passes transient `provider-unavailable` and `provider-rate-limited` failures straight to the runner, which terminates the session on every `model.failed` event. Benchmark callers concealed this omission by carrying private retry loops. Consequently, one intermittent OpenRouter/backend response becomes a terminal developer session even though the same request succeeds moments later.

## Fix

Add a bounded retry policy at the shared `ModelRouter` seam:

- retry only recoverable `provider-unavailable` and `provider-rate-limited` failures;
- retry start failures and stream failures only when the failed attempt emitted no externally visible deltas, usage, tool calls, or completion;
- honor provider retry metadata within the remaining request timeout;
- retain a single public stream identity and emit the terminal failure only after attempts are exhausted;
- cancel the active provider attempt and stop retrying when the caller aborts;
- add deterministic regression tests for recoverable start failure, recoverable empty-stream failure, exhausted retries, partial-stream failure, non-recoverable failure, and cancellation.

## Resolution

Implemented bounded clean-stream recovery in `src/models/model-router.ts` and regression coverage in `src/models/model-routing.test.ts`.

Verification on 2026-07-21:

```text
pnpm vitest run src/models/model-routing.test.ts: 11/11 passed
pnpm typecheck: passed
pnpm presubmit: passed
real daemon session_ec51da01-e398-4d78-88c0-085908ddd6e9:
  file.read README.md + file.read package.json + process.start + process.observe
  three consecutive model/tool continuations completed without a terminal provider failure
```

The smoke session was deliberately cancelled after proving the continuation path because the offline sandbox caused Corepack to retry discovery of an unavailable pnpm binary. That environment behavior is separate from the model recovery defect and is useful evidence for the continual-learning benchmark.
