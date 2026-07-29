---
type: investigation
symptom: "A successful candidate session fails its hidden behavioral verifier because the verifier cannot import the completed workspace."
slug: hidden-verifier-cannot-import-workspace
date: 2026-07-27T12:44:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8ebr
branch: main
repository: git@github.com:fmktech/omega.dev.git
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-27-skill-foundry-static-verifier-rejects-correct-behavior.md
  - docs/investigations/2026-07-27-static-baseline-sentinel-blocks-executable-suite.md
---

# Hidden verifier cannot import workspace

## Symptom

- **Observed:** Candidate session `session_a90539c0-ab9e-4e03-a0c4-55aa2d88ccd1` completed successfully, but benchmark run `e3805c8d-6b32-4d7b-818d-7e3ea4f091c5` failed verification.
- **Expected:** The hidden verifier executes against the candidate's completed workspace snapshot.
- **Delta:** Node resolved `./src/storage.js` as `/workspace/.omega-verifier-Z2ZszM/src/storage.js`, which did not exist.

## Reproduction

1. Compile a Skill Foundry fixture whose executable verifier imports `./src/storage.js`.
2. Complete the candidate task successfully.
3. Run the verifier from the launcher's hidden verifier directory.

Captured benchmark diagnostic:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'/workspace/.omega-verifier-Z2ZszM/src/storage.js'
imported from /workspace/.omega-verifier-Z2ZszM/verify.mjs
```

The benchmark report also records `negativeInvariantsPassed=true`, so fixture preservation was not the failure.

## Hypotheses

#### H1: The candidate failed to create `src/storage.js`

- **Layer:** state-data
- **Prediction:** Structural diagnostics report the source file as missing.
- **Evidence:** Both structural diagnostics report `actual:"present"` for `src/storage.js`.
- **Verdict:** REJECTED
- **Rationale:** The completed workspace contains the target module.

#### H2: The sandbox denied read access to the completed workspace

- **Layer:** dependency-integration
- **Prediction:** The verifier reports an access-denied error or cannot read any mounted workspace path.
- **Evidence:** The failure is `ERR_MODULE_NOT_FOUND` at a concrete path inside the mounted `/workspace`; the sandbox is deliberately `workspace-read-only`, not no-access.
- **Verdict:** REJECTED
- **Rationale:** The mount exists and the error is path layout, not permission.

#### H3: The launcher isolates verifier files without exposing a stable workspace snapshot inside that execution root

- **Layer:** code-logic
- **Prediction:** `runExecutableVerifier` creates `.omega-verifier-*`, writes only verifier files there, and executes with that directory as `cwd`.
- **Evidence:** The launcher calls `mkdtemp`, materializes only `verifier.files`, and sets `ProcessSpec.cwd = verifierRoot`. It never mirrors or links the completed workspace into that root.
- **Verdict:** PROVEN
- **Rationale:** Relative imports from hidden verifier files cannot reliably reach the SUT, so the behavioral oracle rejects correct candidates before testing behavior.

## 5 Whys

1. **Why did the behavioral verifier fail?** Its source-module import resolved to a missing path.
2. **Why was that path missing?** The private verifier directory contained only verifier-authored files.
3. **Why did the verifier import from that directory?** ESM relative imports resolve from the verifier file, not from the process working directory or fixture root.
4. **Why was no stable layout defined?** Hiddenness and read-only execution were implemented, but the verifier-to-workspace filesystem contract was left implicit.
5. **Why did tests miss it?** The process double checked verifier visibility and sandbox policy, but never required the completed fixture to be visible from the verifier root.

## Falsification

- **Check performed:** Compare the benchmark report's source diagnostics with the Node import failure.
- **Result:** `src/storage.js` is present in the completed workspace but absent specifically under `.omega-verifier-*`.
- **Conclusion:** Candidate output and sandbox access are not causal; H3 uniquely predicts both observations.

## Root Cause

- **Immediate cause:** `runExecutableVerifier` executes in a directory containing no workspace snapshot.
- **Architectural root:** The trusted verifier boundary lacks an explicit, tested filesystem layout contract.
- **Rejected H1:** The target source file exists.
- **Rejected H2:** The read-only workspace is mounted and addressable.

## Fix

- Mirror the completed workspace snapshot into the private verifier root before overlaying verifier-only files.
- Keep the combined tree read-only and network-disabled during execution.
- Reject verifier-file collisions with snapshot files.
- Document `./<workspace-path>` as the stable import convention and add a recursive fixture-visibility regression test.

