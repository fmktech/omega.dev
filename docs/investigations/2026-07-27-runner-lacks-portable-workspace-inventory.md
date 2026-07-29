---
type: investigation
symptom: "A promotion task repeatedly starts find, ls, and shell processes after already discovering the complete one-file workspace."
slug: runner-lacks-portable-workspace-inventory
date: 2026-07-27T13:56:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8ebr
branch: main
repository: git@github.com:fmktech/omega.dev.git
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-27-skill-guidance-does-not-bound-execution.md
  - docs/investigations/2026-07-27-initial-runner-does-not-teach-process-observation.md
---

# Runner lacks portable workspace inventory

## Symptom

- **Observed:** Candidate session `session_3c27c090-9238-4fba-a363-c4ce08bf4571` ran a successful `find` and read `src/storage.js`, then issued five more listing/environment commands (`find`, malformed `ls`, malformed duplicated `find`, `which node npm npx`, and `sh -c ls -la`) before implementation.
- **Expected:** Workspace discovery is deterministic, platform-neutral, and paid once; the model spends tool calls on the task.
- **Delta:** The initial runner tells the model to use a subprocess for directory discovery, forcing a cheap model to choose and debug platform-sensitive commands.

## Hypotheses

#### H1: The first listing process failed

- **Layer:** dependency-integration
- **Prediction:** The first process exits non-zero or produces no stdout.
- **Evidence:** Process `70ae747a-9e28-4664-bfcb-e8f4a080e89a` produced a 17-byte stdout range and exited; the next model action correctly read `src/storage.js`.
- **Verdict:** REJECTED
- **Rationale:** The initial inventory succeeded.

#### H2: Skill applicability caused repeated retrieval

- **Layer:** business-logic
- **Prediction:** Repeated calls are `skill.read` or absent-path file reads driven by `relevantPaths`.
- **Evidence:** The repeated calls are process commands for generic workspace and runtime discovery. Skill retrieval happened automatically once.
- **Verdict:** REJECTED
- **Rationale:** Skill retrieval is not the repeated operation.

#### H3: Workspace inventory is missing from the harness context

- **Layer:** architecture
- **Prediction:** The model must synthesize shell commands to learn the file tree and will retry alternative command shapes when the minimal fixture violates its expectation of a package manifest or test suite.
- **Evidence:** `context.bootstrap` exposes instructions and knowledge/skill catalogs but no file inventory. The runner prompt explicitly directs directory listing through `process.start`. The trace cycles among Unix commands even after the correct result.
- **Verdict:** PROVEN
- **Rationale:** The harness delegates a deterministic filesystem fact to probabilistic, platform-specific tool use.

## 5 Whys

1. **Why did the candidate burn discovery calls?** It repeatedly tried shell listing commands.
2. **Why did it use shell commands?** `file.read` intentionally reads only files and the runner provides no directory inventory.
3. **Why did retries continue after success?** The model expected more project files and had no authoritative signal that the returned inventory was complete.
4. **Why is this harmful to evolution?** Tool noise consumes the same budget used to measure learned-skill efficiency.
5. **Why is it a harness defect?** File inventory is deterministic context that the harness can supply once without depending on OS commands or model judgment.

## Falsification

- **Check performed:** Correlate model tool calls with process exit events and inspect the context bootstrap contract.
- **Result:** The first listing succeeded, skill retrieval was not repeated, and no authoritative inventory exists in bootstrap context.
- **Conclusion:** H3 uniquely explains the unnecessary cross-platform discovery loop.

## Root Cause

- **Immediate cause:** The runner requires shell subprocesses for directory discovery.
- **Architectural root:** Deterministic environment context is not compiled into the initial model context, so the agent relearns it through fallible actions every session.

## Fix Direction

- Add a bounded, sorted repository-relative file inventory to `context.bootstrap`.
- State that the inventory is authoritative for session start and should be refreshed only after the agent itself creates files.
- Stop instructing the model to discover the initial tree with platform-specific commands.
