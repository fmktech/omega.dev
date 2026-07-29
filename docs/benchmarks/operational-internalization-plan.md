# Operational internalization benchmark plan

## Claim under test

After a user corrects one environment-specific command failure, Omega can crystallize the correction into a scoped harness component and apply it before the same class of failure on fresh tasks. The lesson must persist across sessions and remain inactive in an explicitly incompatible environment.

This benchmark reports independent dimensions. It does not average them into a capability score.

## Learning evidence

The source episode is a completed developer exchange:

1. the user asks the agent to run a verifier with a deadline on a macOS development host;
2. the agent tries GNU `timeout`;
3. the tool reports that `timeout` is unavailable;
4. the user explains that this host provides GNU coreutils as `gtimeout`;
5. the agent reruns successfully with `gtimeout`;
6. the user asks the harness to retain the host-scoped correction.

Reflection may see this episode. Holdout execution evidence may not revise the candidate.

## Holdouts

1. **Near transfer, macOS:** update one authentication setting and run its verifier with a deadline.
2. **General transfer, macOS:** update another authentication setting and run the same verifier with a deadline in a fresh session.
3. **Negative control, Linux:** perform a third change in an explicitly Linux environment where ordinary `timeout` is correct and `gtimeout` is wrong.

The incumbent and candidate receive identical objectives and workspace files. The candidate additionally receives the compact catalog for the learned immutable skill. A relevant skill may be read once per fresh session; repeated reads fail.

## Observable dimensions

| Dimension | Passing evidence |
| --- | --- |
| Capture | Reflection cites the failed command and the user's successful correction. |
| Crystallization | Candidate contains a bounded skill with applicability and negative-applicability cues. |
| Retrieval | Exactly one relevant skill read on each macOS holdout. |
| Application | The candidate's first deadline command uses `gtimeout`, with no preceding `timeout` failure. |
| Internalization | Application passes in both independent macOS sessions. |
| Transfer | The generalized lockout task passes, not only the near timeout-setting task. |
| Inhibition | The Linux task does not retrieve the macOS skill or invoke `gtimeout`. |
| Correctness | Canonical config, regenerated output, verifier, and unrelated files all pass hidden checks. |
| Intervention | Holdouts require no evaluator/user correction. |
| Tool validity | Failed or invalid tool calls are reported per condition. |
| Tool economy | Tool calls and process starts are reported per condition. |
| Model economy | Tokens and equivalent model cost are reported per condition. |
| Latency | Wall time is reported per run. |
| Durability | The learned behavior passes in two distinct session IDs. |
| Scope | macOS activates the lesson; Linux does not. |

Verdicts are `worked`, `mixed`, or `failed`. `Worked` requires every required behavioral dimension to pass and no correctness, inhibition, or scope regression. Resource dimensions remain independent observations and cannot compensate for behavioral failure.

## Edge-case taxonomy

| Row | Applies? | Cases |
| --- | --- | --- |
| Empty/null/missing | Apply | Missing installed skill must not count as retrieval; absent command evidence fails application. |
| Boundary values | Apply | Exactly one skill read is valid; zero fails relevant retrieval and more than one is rejected. |
| Invalid input | Apply | Unknown environment profile is rejected by the scorer. |
| Dependency failure | Apply | macOS `timeout` deterministically returns command-not-found; `gtimeout` runs the verifier. |
| Concurrency/ordering | Apply | Correct command must be the first deadline command, so a failed Linux command followed by recovery does not count as internalized. |
| Idempotency/duplicates | Apply | Each immutable skill can be read only once per session. |
| Unicode/encoding/timezone | N/A | The contract contains ASCII command names and no temporal or encoded business data. |

## Mutation checks

- Replace the candidate's first `gtimeout` with `timeout`: application and internalization must fail.
- Retrieve the macOS skill on Linux: inhibition and scope must fail.
- Skip regeneration: correctness must fail.
- Edit generated output directly: correctness must fail.
- Count a recovery command as first-attempt success: the ordering assertion must fail.
- Collapse dimensions into one positive aggregate: verdict tests must fail.
