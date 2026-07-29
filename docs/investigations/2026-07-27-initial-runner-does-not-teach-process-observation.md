---
type: investigation
symptom: "Benchmark agents repeatedly start processes, ignore their output handles, guess workspace paths, and exhaust the model-call budget."
slug: initial-runner-does-not-teach-process-observation
date: 2026-07-27T12:51:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8ebr
branch: main
repository: git@github.com:fmktech/omega.dev.git
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-21-model-call-budget-not-cumulative.md
  - docs/investigations/2026-07-21-process-input-schema-kills-runner.md
---

# Initial runner does not teach process observation

## Symptom

- **Observed:** Near-transfer incumbent `session_e060021d-8f7a-4ad0-ac18-f86dff735bbb` exhausted its 24-call budget. Candidate `session_8a13ce05-9b1a-43f4-8702-8cdccb592b5f` repeated the same discovery loop before cancellation.
- **Expected:** One workspace listing process is started, observed to completion, and used to choose targeted file reads.
- **Delta:** A successful `process.start` returned a handle, but the next turns started more processes or guessed `/`, `/home/user`, and file paths without observing stdout.

## Reproduction

Incumbent event sequence:

```text
17 process.start bash -c "ls -laR /"
20 file.read "/"
23 process.start bash -c "pwd && ls -la" cwd=/home/user
29 process.start find ...
32 process.start pwd cwd=/
83 model.failed budget=model-calls observed=25 limit=24
```

Candidate event sequence:

```text
12 process.start ls -la
13 process.started <handle>
16 process.start ls -la .. cwd=/
```

No `process.observe` occurs between the candidate's two starts.

## Hypotheses

#### H1: The process supervisor loses or withholds command output

- **Layer:** dependency-integration
- **Prediction:** The agent calls `process.observe`, but the returned slices are empty or inaccessible.
- **Evidence:** The candidate never calls `process.observe` after receiving the successful handle.
- **Verdict:** REJECTED
- **Rationale:** Output retrieval is never attempted.

#### H2: The generated skill causes the bad discovery loop

- **Layer:** state-data
- **Prediction:** Only the candidate with the new skill shows repeated starts and guessed paths.
- **Evidence:** The incumbent without the skill exhibits the same pattern and reaches the model-call ceiling.
- **Verdict:** REJECTED
- **Rationale:** The failure predates skill selection and is shared runner behavior.

#### H3: The initial runner exposes asynchronous process tools without teaching their required lifecycle and path mapping in the system prompt

- **Layer:** code-logic
- **Prediction:** Tool metadata mentions observation, but `bootstrapPrompt` omits start→observe instructions, exact handle reuse, offsets, and `/workspace` conventions.
- **Evidence:** `process.start.description` says “Use process.observe,” while `bootstrapPrompt` contains no process lifecycle or sandbox path guidance. Live traces show the exact resulting misuse.
- **Verdict:** PROVEN
- **Rationale:** The model receives a handle-only result without an operational protocol at the instruction level, then treats starts as foreground command results.

## 5 Whys

1. **Why did the runner exhaust its turn budget?** It repeatedly launched discovery commands without consuming their output.
2. **Why was output not consumed?** `process.start` is asynchronous and returns only a handle; the model did not call `process.observe`.
3. **Why did the model not observe?** The system prompt never describes the mandatory lifecycle or provides a concrete call shape.
4. **Why did it guess `/` and `/home/user`?** The prompt also omits that file tools use repository-relative paths and sandbox processes see the repository at `/workspace`.
5. **Why did existing tests miss this?** They validate runner protocol shapes, but not the operational guidance delivered to the model.

## Falsification

- **Check performed:** Compare traces across an incumbent and a skill-bearing candidate, then inspect the actual prompt and tool metadata.
- **Result:** Both conditions reproduce the loop; the tool metadata has a one-sentence hint, but the system prompt lacks the lifecycle and path contract entirely.
- **Conclusion:** Skill content and process-runtime output are not causal; H3 uniquely explains the shared behavior.

## Root Cause

- **Immediate cause:** `bootstrapPrompt` fails to teach asynchronous tool usage.
- **Architectural root:** Wire-level tool correctness was tested without a model-facing protocol contract for multi-call tools.
- **Rejected H1:** Observation was never attempted.
- **Rejected H2:** The incumbent reproduces the failure without the new skill.

## Fix

- Add concise mandatory start→observe guidance, exact process-ID reuse, offset paging, and completion handling to the system prompt.
- State repository-relative file semantics and the sandbox `/workspace` mapping; prohibit root/home discovery guesses.
- Tell the model that an automatically selected immutable skill is already loaded and must not be read again.
- Add system-prompt regression assertions and rerun the real paired benchmark.

