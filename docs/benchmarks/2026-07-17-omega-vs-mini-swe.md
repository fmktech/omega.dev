# Omega vs. mini-swe-style baseline — 2026-07-17

## Outcome

Omega's promoted project harness beat a deliberately lean mini-swe-agent-style baseline on OmegaBench-10:

- Omega: **6/10 passed**
- mini-swe-style baseline: **1/10 passed**
- Candidate-minus-incumbent success-rate delta: **-0.50**
- Head-to-head: **5 Omega wins, 0 baseline wins, 5 ties**
- Promotion decision: **reject**
- Active project harness: unchanged

The automatic gate rejected the baseline because it regressed on `offline-dependency@1`, a protected task. The scorecard allows no protected regressions.

Identifiers:

- Scorecard: `5adb01a2fb1c90c32d5f054d9ec12717d5d384eb4182a818c16a3cfa2d5e20e3`
- Omega harness: `harness_4ff2377aa58ea1cdad304f7af2213831c76cbf517775fbd780926d08362bc46b`
- Baseline harness: `harness_2713d9f414fce252023164b8e5094d19b18e8f572e89c81314654f379bf1ac7b`
- Suite: `omegabench-10@1`

## What was compared

The baseline is a deterministic Omega runner component modeled on the core organization of mini-swe-agent v2.4.5:

- one linear message history;
- one model-visible `bash` tool;
- one fresh local process for every action;
- clipped command output returned to the model;
- retry on malformed action format;
- an exact completion sentinel.

It is not the upstream Python package and this was not a SWE-bench run. The adapter exists so both harnesses can run inside the same Omega daemon with the same fixtures, model route, policy, sandbox, budgets, verifier, and durable evidence format. Its source is [`src/harness/mini-swe-baseline.ts`](../../src/harness/mini-swe-baseline.ts).

Upstream references: [mini-swe-agent repository](https://github.com/SWE-agent/mini-swe-agent), [default agent loop](https://github.com/SWE-agent/mini-swe-agent/blob/main/src/minisweagent/agents/default.py), and [local environment](https://github.com/SWE-agent/mini-swe-agent/blob/main/src/minisweagent/environments/local.py).

## Controlled model route

Both sides used the same capability route for all comparable pairs:

```text
provider: OpenRouter
model: deepseek/deepseek-v4-flash
serving provider: GMICloud
reasoning: high
temperature: 0
context limit: 1,000,000
output limit: 16,384
fallbacks: disabled
```

The OpenRouter credential was injected into the daemon process from the environment. It was not written into the repository, harness component, session log, or benchmark record.

## Pairwise results

| OmegaBench task | Omega | mini-style | Result |
| --- | --- | --- | --- |
| operating-system-mismatch@1 | pass | fail | Omega win |
| unexpected-build-tool@1 | pass | fail | Omega win |
| generated-file-trap@1 | fail | fail | tie |
| scoped-monorepo-verification@1 | pass | pass | tie |
| background-process@1 | pass | fail | Omega win |
| offline-dependency@1 | pass | fail | Omega win; protected regression |
| concurrent-file-change@1 | pass | fail | Omega win |
| misleading-instructions@1 | fail | fail | tie |
| nonstandard-test-oracle@1 | fail | fail | tie |
| preexisting-flaky-failure@1 | fail | fail | tie |

## Capability and efficiency

| Aggregate | Omega | mini-style baseline | Ratio, Omega / baseline |
| --- | ---: | ---: | ---: |
| Passed | 6 | 1 | 6.0x |
| Wall time | 608,927 ms | 122,586 ms | 5.0x |
| Provider cost | $0.057218 | $0.002005 | 28.5x |
| Input tokens | 746,683 | 15,438 | 48.4x |
| Output tokens | 15,854 | 2,509 | 6.3x |
| Model turns | 107 | 25 | 4.3x |
| Process starts | 25 | 24 | 1.0x |

The mini-style baseline is dramatically cheaper and faster, primarily because it fails early. Omega spends substantially more context and model turns, but converts that effort into five additional solved tasks and avoids the protected regression.

## Interpretation

This is strong evidence for a narrow claim: **on OmegaBench-10, under the same DeepSeek V4 Flash route and runtime controls, Omega's evolved project harness is materially more capable than this mini-swe-style baseline.** It is not evidence that Omega broadly outperforms the upstream mini-swe-agent project or its published SWE-bench configurations.

Three limits matter:

1. This is one replicate of ten tasks.
2. Omega's harness was evolved using these task families, so this suite is not a fresh private holdout.
3. The baseline reproduces mini-swe-agent's lean execution organization inside Omega; it does not reproduce every upstream prompt, configuration, deployment detail, or benchmark setup.

More runs on the same ten tasks would improve confidence about variance, but should not be expected to produce further harness improvement by themselves. Evolution only improves the harness when failures generate a new candidate and that candidate clears the paired gate. The next useful experiment is a fresh OmegaBench-B holdout across at least three paired replicates per harness, followed by evolution on a disjoint training suite and one final untouched holdout evaluation.
