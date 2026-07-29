---
type: investigation
symptom: "Post-session evolution creates its child but runner startup fails with budget-exceeded."
slug: evolution-runner-startup-budget
date: 2026-07-21T09:18:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8e
branch: main
repository: fmktech/omega.dev
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-21-post-session-evolution-parent-terminal.md
  - docs/benchmarks/storage-app-holdout-plan.md
---

# Evolution proposal runner fails its startup budget

## Symptom

- **Observed:** After the terminal-parent lifecycle fix, `evolution-start` created evolution child `session_bda72df3-6e7e-480d-8324-a5f0a51576d3`, then returned an internal diagnostic containing `Runner startup failed: budget-exceeded`.
- **Expected:** The proposal-only child can launch its runner and use model/file-read budgets while retaining a zero tool-process budget.
- **Delta:** The child header has ample wall time, model calls, and token budgets but `maxProcessStarts: 0`; failure occurs before `runner.started`.

## Reproduction

```text
omega evolution-start ... 600000 12 300000 80000 0 1 "" skill synthetic-skill-suite
=> child state failed, events: session.started, session.completed
=> diagnostic: Runner startup failed: budget-exceeded
```

## Hypotheses

#### H1: Runner infrastructure startup is incorrectly charged as a tool process start

- **Layer:** runner/process budget integration
- **Prediction:** `RunnerHost.start` delegates to the same process supervisor budget used by `process.start`, and the proposal child deliberately attenuates `maxProcessStarts` to zero.
- **Verification:** Trace runner launch through the host and budget accounting; compare with the child header and tool process path.
- **Evidence:** `RunnerHost.start` calls `ProcessSupervisor.start(spec, session.capabilityEnvelope)`. That method rejects when `previousStarts >= maxProcessStarts` before any other validation. Both `evolutionChildCapabilities` and `skillEvalChildCapabilities` deliberately set `maxProcessStarts: 0`. A red process-runtime test reproduces the failure with the same envelope.
- **Verdict:** PROVEN

#### H2: The child exhausts wall-time or token budget while constructing startup context

- **Layer:** context/budget accounting
- **Prediction:** startup performs a budget reservation for input/output or elapsed time that exceeds the header's 300k/80k/600s limits.
- **Verification:** Inspect the exact budget-exceeded producer and startup reservation values.
- **Evidence:** The persisted child had 600 seconds, 300k input tokens, and 80k output tokens remaining. The exact first failing branch is the process-count check; no model reservation occurs in runner startup.
- **Verdict:** REJECTED

#### H3: The zero-process proposal capability is translated into a generic capability denial reported as budget-exceeded

- **Layer:** policy/capability translation
- **Prediction:** the runner executable is absent from a start-process grant or denied by policy, and the error mapping collapses that denial into `budget-exceeded`.
- **Verification:** Trace startup error mapping and compare the actual child grants.
- **Evidence:** Capability validation occurs after the process-count rejection and returns `capability-denied`, not `budget-exceeded`. It is a second latent problem for proposal/evaluator children, but it did not produce the observed error.
- **Verdict:** REJECTED

## 5 Whys

1. **Why did the proposal runner fail?** Its infrastructure process was rejected as tool process number one against a zero-tool budget.
2. **Why was runner startup charged there?** `RunnerHost` uses the public tool-process `start` operation.
3. **Why is that incorrect?** `maxProcessStarts` describes runner-requested tools, while every session necessarily needs one daemon-owned runner process.
4. **Why would raising the budget be insufficient?** The runner would consume one slot from every task and zero-process children would next fail start-process/process-input capability checks.
5. **Why was it not caught?** Runner-host tests used a permissive fake and process tests never launched infrastructure under a zero-tool envelope.

## Falsification

The diagnostic identifies the process budget, not wall time or tokens. The persisted child envelope and branch order prove those budgets cannot produce this result. Capability validation is adjacent but later, so merely adding a start-process grant or process-input grant would not falsify the failing process-count condition.

## Root Cause

Daemon-owned runner infrastructure and runner-controlled stdin share the same supervisor entry points and accounting as agent-requested tools. Consequently the runner consumes a tool slot, requires tool-only capabilities, and makes valid zero-tool evolution/evaluation sessions impossible.

## Fix

Add an explicit `ProcessSupervisor.startRunner` infrastructure seam. It must respect global concurrency, wall time, workspace containment, sandboxing, and credential availability, but must not consume `maxProcessStarts` or require/authorize agent tool-process capabilities. Mark runner records internally so kernel JSONL input is not mistaken for agent `process.input`. Keep public `start` and input behavior unchanged for tools. Add runner-host and process-runtime regressions.

## Resolution

Added the explicit `ProcessSupervisor.startRunner` seam and internal runner/tool ownership. Runner startup and kernel JSONL input no longer consume or require tool-process capabilities; global concurrency, wall time, workspace containment, sandboxing, and credential availability remain enforced. Tool start/input behavior is unchanged. Runner-host/process-runtime regressions and full presubmit pass. In the real CLI rerun, zero-tool builder and evaluator runners both started and completed successfully.
