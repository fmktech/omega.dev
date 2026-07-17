# DeepSeek V4 Flash evolution run — 2026-07-17

[Open the interactive evolution showcase](omega-evolution-showcase.html).

## Outcome

Omega completed its first end-to-end, project-scoped evolution cycle and automatically promoted the candidate harness.

- Evolution job: `5c25eaeb-66a8-416f-b22d-c3e58db831c5`
- Scorecard: `6df1d3e8364a8ba652739e602d5d71d13a4ff262b6be5f2b536c0577b9c00e1d`
- Incumbent: `harness_f5247ca5943a0ce82f59b826c2ec21db846a5901b6073203ebbb8ba3fbb34f9b`
- Promoted candidate: `harness_4ff2377aa58ea1cdad304f7af2213831c76cbf517775fbd780926d08362bc46b`
- Comparable pairs: 10 of 10
- Success rate: 4/10 incumbent, 5/10 candidate
- Observed effect: +0.10, meeting the +0.10 minimum threshold
- Decision: promote

The active harness pointer for the `omega.dev` project was updated to the candidate immediately after promotion.

## Controlled route

Both sides of every pair used the same material route settings:

```text
model: deepseek/deepseek-v4-flash
OpenRouter serving provider: GMICloud
reasoning: high
temperature: 0
context limit: 1,000,000
output limit: 16,384
fallbacks: disabled
quantization: undisclosed on both sides
```

The route role labels differ (`main-coder` and `promotion-evaluator`) because each side is launched through a distinct control-plane role. Their material model and serving settings match. GPT-OSS-20B was used only for cheap automatic execution-policy filtering and is not capability evidence.

Nemotron 3 Ultra Free was attempted first, but the provider idle-timed out. No Nemotron result was compared with this DeepSeek series.

## Pairwise results

| OmegaBench task | Incumbent | Candidate | Change |
| --- | --- | --- | --- |
| operating-system-mismatch@1 | pass | fail | regression |
| unexpected-build-tool@1 | pass | pass | unchanged |
| generated-file-trap@1 | fail | fail | unchanged |
| scoped-monorepo-verification@1 | fail | fail | unchanged |
| background-process@1 | fail | pass | improvement |
| offline-dependency@1 | pass | pass | unchanged |
| concurrent-file-change@1 | pass | pass | unchanged |
| misleading-instructions@1 | fail | pass | improvement |
| nonstandard-test-oracle@1 | fail | fail | unchanged |
| preexisting-flaky-failure@1 | fail | fail | unchanged |

The candidate changed only the runner component. It crystallized concrete instructions to preserve exact formats, invoke scripts through their declared interpreter, edit generated sources rather than outputs, use scoped monorepo verification, and orchestrate background service readiness/probing/cleanup within one isolated process.

## Resource evidence

| Aggregate | Incumbent | Candidate |
| --- | ---: | ---: |
| Wall time | 669,298 ms | 752,110 ms |
| Provider cost | $0.059208 | $0.058514 |
| Input tokens | 724,866 | 705,198 |
| Reasoning tokens | 6,202 | 7,163 |
| Output tokens | 18,596 | 22,596 |
| Model turns | 119 | 142 |
| Process starts | 33 | 38 |

Capability is lexicographically prior to efficiency under ADR-0015, so the +10 percentage-point improvement promoted despite higher wall time, model turns, and process starts.

## Feedback-loop defects found and fixed

Running the real loop exposed integration failures that deterministic tests had not revealed:

- evolution children inherited the main model route instead of the harness-mutator route;
- proposal-only children retained write/process authority;
- a final model completion could race session completion and be absent from durable evidence;
- mutation parsing rejected a valid JSON object preceded by explanatory prose;
- generated runner components referenced a non-existent file rather than using a content-addressed inline entrypoint;
- a long paired HTTP request could outlive the client connection, so evaluation was moved into the durable evolution job;
- the comparator rejected any changed component set, even though that change is the experiment;
- the incumbent and candidate initially used incomparable route/provider selection settings.

The runtime now resolves child routes by role, attenuates proposal-child capabilities, persists terminal model completions before delivery, extracts balanced JSON proposals, stores runnable inline components, supports durable evolution retry/observe, compares changed harnesses while holding external conditions fixed, and pins both sides to the same OpenRouter provider settings.

## Interpretation

This is evidence that the feedback loop can generate, evaluate, and activate a useful harness mutation. It is not yet broad evidence of general improvement: the sample is ten tasks, one paired replicate, and the effect landed exactly on the promotion boundary with one new regression. Additional replicates and fresh project suites should be used before advertising the candidate globally in the local marketplace.
