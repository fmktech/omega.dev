# Operational internalization benchmark

Date: 2026-07-21  
Overall verdict: **mixed**  
Behavioral internalization: **worked in this replicate**  
Model: `deepseek/deepseek-v4-flash` through OpenRouter  
Authoritative evidence: `~/.omega/benchmarks/operational-internalization/c0fec146329d7aebe4998f80c2937c9727248125cb2b8ef9bd0ac1366312f728.json`

## Direct answer

The harness internalized the environment correction behaviorally, but the expanded benchmark as a whole did not produce a clean win.

After one source episode in which a user corrected macOS `timeout` to `gtimeout`, the candidate:

- retrieved the resulting skill in both fresh macOS sessions;
- used `gtimeout` as its first deadline command in both sessions;
- transferred the rule from a timeout-setting change to a lockout-setting change;
- did not retrieve or apply the macOS skill in the Linux negative control;
- completed all three workspaces correctly, compared with one of three for the incumbent.

However, reflection did not cite the required failing and successful tool-event IDs, so capture provenance failed. The candidate also consumed more model cost. Those independent regressions make the overall verdict `mixed`, not `worked`.

## Dimension report

There is deliberately no aggregate score.

| Dimension | Result | Incumbent | Candidate | Evidence |
| --- | --- | ---: | ---: | --- |
| Capture | failed | — | required event provenance omitted | Concepts were correct, but grounding was false. |
| Crystallization | met | — | 1 skill | Positive and negative applicability were present. |
| Retrieval | improved | 0 | 2/2 | Exactly one relevant read in each macOS session. |
| Application | improved | 0/2 | 2/2 | Candidate used `gtimeout` before any plain `timeout` attempt. |
| Internalization | met | — | 2/2 | Behavior repeated in distinct sessions. |
| Transfer | improved | 0/1 | 1/1 | The generalized lockout task passed. |
| Inhibition | tied/pass | 1/1 | 1/1 | Linux used plain `timeout`; candidate did not read the skill. |
| Correctness | improved | 1/3 | 3/3 | Hidden canonical-source, regeneration, verification, and preservation checks passed. |
| Intervention | not measured | — | — | Sealed holdouts prohibited evaluator correction. |
| Tool validity | improved | 4 errors | 2 errors | Remaining candidate errors were unrelated invocation/read mistakes. |
| Tool economy | tied | 27 calls | 27 calls | No tool-call reduction. |
| Model economy | regressed | 3,716 µUSD | 5,023 µUSD | Candidate cost increased 35%. |
| Latency | improved | 129.6 s | 107.4 s | Aggregate wall time decreased 17%. |
| Durability | met | — | 2 sessions | Both independent macOS session IDs passed application. |
| Scope | met | — | correct | macOS activation and Linux non-activation both held. |

## What was learned

Reflection created `use-gtimeout-on-macos-with-prefixed-gnu-coreutils`. Its guidance says that this macOS ARM64 development host exposes GNU coreutils under prefixed names, so host-shell timeout commands should use `gtimeout`; Linux containers and other hosts are explicit negative applicability cases.

The key result is that retrieval was not counted as internalization by itself. The candidate received application credit only because the first relevant command in both new sessions used the corrected executable. A sequence that tried `timeout`, failed, and then recovered with `gtimeout` would have failed application and internalization.

## Benchmark correction discovered during the run

The original verifier accepted only the literal command `gtimeout 10 ./verify-auth`. Both candidate sessions instead used the behaviorally equivalent and successful `gtimeout 10 sh verify-auth` form. This produced a false `failed` result in the first scoring record:

`~/.omega/benchmarks/operational-internalization/1554600e811a2a4003ee5692323b9886589d631032a904ba9089ec3f5534dff9.json`

The verifier was corrected to accept direct and shell-invoked equivalents. A regression test proves that `timeout` followed by `gtimeout` still fails first-action application. The exact immutable model outputs, command traces, files, route metadata, usage, and timings were then rescored into the authoritative record; no model was rerun and no candidate was changed.

## Limits

- This is one model-marked replicate.
- The Darwin command availability is deterministically emulated at the isolated process boundary; execution still occurs in a network-disabled OCI workspace.
- Durability covers distinct sessions, not a daemon restart or a different physical machine.
- The source feedback episode is frozen rather than generated dynamically from a failed workspace.
- The benchmark covers operational knowledge. Architect workflow and visual-preference internalization remain separate future tracks.

## Reproduction

```sh
pnpm build
pnpm benchmark:operational-internalization

# Deterministically rescore a preserved record after verifier-only changes:
node dist/operational-internalization-benchmark-main.js --rescore <record.json>
```

The benchmark contract is in `docs/benchmarks/operational-internalization-plan.md`.
