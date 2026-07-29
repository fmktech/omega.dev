---
type: investigation
symptom: "The full workspace benchmark aborts before its first workspace when reflection receives a recoverable provider failure"
slug: workspace-benchmark-reflection-provider-failure
date: 2026-07-27T17:49:20-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8e
branch: main
repository: fmktech/omega.dev
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-21-daemon-tool-continuation-http-400.md
  - docs/investigations/2026-07-27-recoverable-model-error-aborts-session.md
---

# Workspace benchmark aborts on recoverable reflection provider failure

## Symptom

- **Observed:** `pnpm benchmark:workspace-skill-transfer 3` exits with code 3 after `workspace-skill-transfer: reflecting...` and `{"kind":"provider-unavailable","reason":"Provider finished the generation with an error","recoverable":true}`. It emits no `compiled` or workspace progress line.
- **Expected:** A recoverable provider failure is retried a bounded number of times and the full three-replicate workspace benchmark proceeds when a later attempt succeeds.
- **Delta:** The launcher treats a recoverable dependency failure as a terminal benchmark result before the first evaluated workspace.

## Reproduction

1. Export the zsh-local credential into the benchmark process.
2. Run `pnpm benchmark:workspace-skill-transfer 3`.
3. Observe the terminal recoverable provider error before any workspace is created.

Verified on 2026-07-27. The immediately preceding one-replicate invocation completed all six workspaces with the same model route and credential; the next three-replicate invocation failed during reflection with the output quoted above.

## Hypotheses

#### H1: The launcher retries structural validation errors but terminates on recoverable reflection provider failures

- **Layer:** code-logic
- **Prediction:** The reflection retry predicate accepts only `validation`, while the terminal path returns code 3 for `provider-unavailable`; workspace execution never starts.
- **Verification method:** Inspect `src/workspace-skill-transfer-benchmark-main.ts:55-65` and compare it with the failing trace.
- **Evidence:**
  ```text
  57 while (!reflected.ok && reflected.error.kind === "validation"
  58   && reflected.error.field?.startsWith("modelOutput") === true && reflectionAttempts < 3) {
  63 if (!reflected.ok) {
  64   process.stderr.write(`${JSON.stringify(reflected.error)}\n`);
  65   return 3;

  workspace-skill-transfer: reflecting with openrouter:deepseek/deepseek-v4-flash
  {"kind":"provider-unavailable","providerId":"openrouter","reason":"Provider finished the generation with an error","recoverable":true,"callerAction":"choose-different-route"}
  Command failed with exit code 3.
  ```
- **Verdict:** PROVEN
- **Rationale:** The observed error cannot enter the only retry branch and is immediately returned by the following terminal branch.

#### H2: The benchmark process has no usable OpenRouter credential

- **Layer:** config-env
- **Prediction:** A direct request and the one-replicate benchmark would both fail locally with `Credential environment variable OPENROUTER_API_KEY is not set`.
- **Verification method:** Export the zsh-local variable without printing it, issue a minimal request, and run the one-replicate benchmark.
- **Evidence:**
  ```text
  {"id":"gen-1785185389-AtR2JhlxB4pMioQCnQbf","error":null,"provider":"GMICloud","model":"deepseek/deepseek-v4-flash","finish_reason":"length"}
  workspace-skill-transfer: compiled 1 skill(s); running 6 isolated workspaces
  "status": "completed"
  ```
- **Verdict:** REJECTED
- **Rationale:** The exported credential authenticated both a direct GMICloud request and a complete benchmark invocation.

#### H3: Workspace concurrency or OCI isolation causes the provider failure

- **Layer:** dependency-integration
- **Prediction:** At least one workspace progress line or container start appears before the provider failure.
- **Verification method:** Inspect ordering of the failing trace and launcher control flow.
- **Evidence:**
  ```text
  workspace-skill-transfer: reflecting with openrouter:deepseek/deepseek-v4-flash
  {"kind":"provider-unavailable",...}
  ```
  `src/workspace-skill-transfer-benchmark-main.ts:76-105` constructs the candidate before the workspace loop, and the `compiled ... running ...` line was absent.
- **Verdict:** REJECTED
- **Rationale:** The failure precedes candidate construction and every OCI workspace operation.

## 5 Whys

Symptom: The full benchmark aborts before the first workspace.

1. Because reflection returned a recoverable provider failure.
2. Because the launcher's retry predicate recognizes only structurally invalid model output.
3. Because provider retry behavior was implemented independently for downstream workspace completions but not for the reflection phase.
4. Because benchmark entry points call the single-attempt reflection primitive directly and each owns partial retry policy.
5. Because bounded retry policy is not represented by a shared reflection orchestration seam, so dependency handling drifts between phases and launchers.

## Falsification

- **Check performed:** Absence and adjacent-cause checks.
- **Result:** With the same credential, pinned provider, model, and source scenario, the immediately preceding invocation returned a valid reflection and completed six workspaces. A direct pinned GMICloud call also succeeded. Therefore the external failure is intermittent, but the launcher deterministically aborts whenever that recoverable result survives the router's internal attempts. Non-provider validation failures still need their existing bounded repair behavior and must not be generalized into infinite retries.
- **Conclusion:** H1 survives. The external outage is a trigger; the missing orchestration policy is the codebase root cause.

## Root Cause

- **Immediate cause:** `src/workspace-skill-transfer-benchmark-main.ts:57-65` excludes recoverable provider errors from the reflection retry predicate and immediately returns code 3.
- **Architectural root:** Reflection retry policy is duplicated or absent at callers rather than provided by a shared bounded orchestration seam.
- **Rejected H2:** The exported credential and direct GMICloud request succeed.
- **Rejected H3:** The failure occurs before candidate compilation and workspace creation.
- **Falsification result:** Identical successful and failed invocations isolate the intermittent provider response as a trigger while preserving the deterministic caller defect.

## Fix

- Add a shared bounded reflection runner that retries only recoverable provider errors and structurally invalid model output, exposes attempt metadata, and returns other failures immediately.
- Make the full workspace benchmark use that runner.
- Add deterministic regression tests for recoverable failure followed by success, exhaustion, and non-recoverable failure.

## Resolution

- Added `runReflectionScenarioWithRetries` in `src/evolution/reflection-benchmark.ts` as the shared bounded orchestration seam. It retries recoverable provider failures with backoff, retries malformed `modelOutput`, preserves attempt/retry evidence, and immediately returns non-recoverable failures.
- Updated `src/workspace-skill-transfer-benchmark-main.ts` to use the shared seam and persist `reflectionRetries` in the authoritative benchmark record.
- Added three regression tests in `src/evolution/reflection-benchmark.test.ts`. The new API and expectations do not exist on the unpatched implementation; all three pass after the fix.
- Focused verification: reflection suite 20/20; TypeScript typecheck and build pass.
- Exact reproduction: `pnpm benchmark:workspace-skill-transfer 3` encountered an invalid first reflection, logged `retrying model-output reflection (2/3)`, then completed all 18 isolated workspace runs. The candidate passed 9/9 paired holdouts with zero regressions.
- Evidence record: `~/.omega/benchmarks/workspace-skill-transfer/30eb98ecb4fb07432bbbf992db8df12b643b3285b11ab5c8f16b339439f4a505.json`.
