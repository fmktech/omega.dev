---
type: investigation
symptom: "An HTTP verification loop repeatedly starts a server and curl in separate process tools, but localhost requests never reach the server."
slug: isolated-processes-cannot-share-localhost
date: 2026-07-27T14:15:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8ebr
branch: main
repository: git@github.com:fmktech/omega.dev.git
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-27-runner-lacks-portable-workspace-inventory.md
  - docs/investigations/2026-07-27-initial-runner-does-not-teach-process-observation.md
---

# Isolated processes cannot share localhost

## Symptom

- **Observed:** Generalization candidate `session_1c14e03c-17d3-4cf0-8833-1edab459e1c9` starts a Node HTTP server, observes its port, then repeatedly starts separate `curl` processes against that port. It retries with another server, `localhost`, `127.0.0.1`, and verbose curl while the server remains healthy.
- **Expected:** One focused HTTP verifier starts the server, exercises it, and closes it within a bounded tool call.
- **Delta:** The agent assumes separate process tools share a loopback network, which contradicts the one-isolated-process-per-tool architecture.

## Hypotheses

#### H1: The HTTP server fails to listen

- **Layer:** business-logic
- **Prediction:** Server stdout lacks a port or the server process exits before curl.
- **Evidence:** The server prints ports `33389` and `37869`; the runner repeatedly observes the same process as running.
- **Verdict:** REJECTED
- **Rationale:** The server is alive inside its process sandbox.

#### H2: The generated implementation binds only to an incompatible address

- **Layer:** business-logic
- **Prediction:** Changing from `localhost` to `127.0.0.1` reaches the service.
- **Evidence:** The model retries both hostnames and still cannot connect.
- **Verdict:** REJECTED
- **Rationale:** Address spelling does not cross the isolation boundary.

#### H3: Each process has an isolated network namespace

- **Layer:** config-environment
- **Prediction:** A client started by a separate `process.start` cannot reach a server process via loopback, while a server and client in one Node process can communicate.
- **Evidence:** Every cross-process curl fails across two server ports; the process contract creates one isolated OCI process per tool call with network `none`. The trace never runs server and client in the same process.
- **Verdict:** PROVEN
- **Rationale:** The repeated failure is invariant across ports and loopback names and matches the isolation design exactly.

## 5 Whys

1. **Why does curl fail?** It runs in a different isolated process from the server.
2. **Why does the model expect it to work?** The runner documents process observation but not loopback isolation between process tools.
3. **Why does it keep retrying?** Each new port/host appears like a plausible server bug without the missing environment fact.
4. **Why does this damage the benchmark?** Correct implementation work is censored by irrelevant process-lifecycle calls.
5. **Why is it a harness responsibility?** Isolation topology is stable runtime knowledge that agents should receive before acting.

## Falsification

- **Check performed:** Compare server lifecycle events, attempted addresses, and the OCI sandbox/process contract.
- **Result:** Servers remain running and multiple loopback spellings fail only across separate process handles.
- **Conclusion:** H3 uniquely explains the trace.

## Root Cause

- **Immediate cause:** HTTP server and HTTP client are launched through different isolated process tools.
- **Architectural root:** The runner omits a critical environment invariant: process tools do not share localhost.

## Fix Direction

- Add the invariant to the process protocol and require networked component tests to start server, issue requests, assert, and close within one process.
- Give a concrete Node pattern (`server.listen(0)`, built-in `fetch`, `server.close`) while remaining framework-neutral.
- Add a runner regression test proving the invariant is present in the first model context.
