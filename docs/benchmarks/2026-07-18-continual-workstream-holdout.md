# Continual developer-workstream holdout — 2026-07-18

Reflection-model ablation: [`2026-07-18-luna-reflection-ablation.md`](./2026-07-18-luna-reflection-ablation.md) repeats the same no-selection workstream with GPT-5.6 Luna used only for reflection.

## Outcome

Five days of automatically accumulated project experience produced a final harness that passed **6/10** holdout tasks, compared with **7/10** for the untouched starting harness.

- Observed success-rate delta: **−0.10**
- Head-to-head changes: one gained task, two lost tasks, seven ties
- Intermediate capability evaluations: **0**
- Selection policy during learning: **none**
- Starting harness: `harness_ed9799b3a7ea534cb71235b9cef83c29375ca842411af49930be3441fb5ce96d`
- Final harness: `harness_2d20d9888b6c0d9b43d14bd7559bfc0430631e91de7db623d6eee910147ba246`
- Final scorecard: `7dc6d79761772ffcead5e6902d768a04fa4c50f59bfea93b92d49d2b4532b86a`

The final evaluator's `reject` label is reported as measurement only. It did not select, roll back, or mutate the completed lineage.

## Organic lineage

```text
ed9799… → 22b29d… → 376560… → f90910… → dd55d6… → 2d20d9…
```

Every structurally valid reflection became the next day's parent. The driver has no benchmark-service, scorecard, evaluator, promotion, or rollback dependency. Its durable record declares `selectionPolicy: "none"` and `intermediateEvaluationCount: 0`.

| Workday | Cumulative trajectories | Parent | Next harness | Structural attempts |
| ---: | ---: | --- | --- | ---: |
| 1 | 6 | `ed9799…` | `22b29d…` | 1 |
| 2 | 7 | `22b29d…` | `376560…` | 1 |
| 3 | 8 | `376560…` | `f90910…` | 1 |
| 4 | 9 | `f90910…` | `dd55d6…` | 1 |
| 5 | 10 | `dd55d6…` | `2d20d9…` | 1 |

An earlier invocation stopped safely on a malformed learning target. The unattended driver was then given a three-attempt structural retry budget using identical work evidence and no evaluation feedback. The recorded successful lineage needed no retries.

## Final holdout results

| Holdout task | Untouched start | Final evolved | Change |
| --- | --- | --- | --- |
| `operating-system-mismatch@1` | fail | pass | gained |
| `unexpected-build-tool@1` | pass | pass | tie |
| `generated-file-trap@1` | pass | fail | lost |
| `scoped-monorepo-verification@1` | pass | fail | lost |
| `background-process@1` | pass | pass | tie |
| `offline-dependency@1` | pass | pass | protected tie |
| `concurrent-file-change@1` | pass | pass | tie |
| `misleading-instructions@1` | fail | fail | protected tie |
| `nonstandard-test-oracle@1` | fail | fail | tie |
| `preexisting-flaky-failure@1` | pass | pass | tie |

The workstream successfully transferred the explicit cross-platform lesson. It did not preserve all earlier abilities: accumulating more specific generated-file and package-scoping guidance coincided with failures on those holdout tasks. This is interference, not a gate failure, because the realistic protocol deliberately did not select around it.

## Resource evidence

The five reflections used DeepSeek V4 Flash through OpenRouter/GMICloud at temperature 0:

| Phase | Input tokens | Reasoning tokens | Output tokens | Provider cost |
| --- | ---: | ---: | ---: | ---: |
| Five workday reflections | 6,565 | 11,053 | 13,533 | $0.003296 |
| Untouched-start holdout | 64,321 | 6,016 | 11,074 | $0.008190 |
| Final-harness holdout | 107,350 | 3,935 | 9,992 | $0.011770 |

The final harness used more input context and provider cost than the start while solving one fewer task. Its ten holdout tasks consumed 462,492 ms of summed wall time versus 377,784 ms for the starting harness.

The first final-evaluation invocation was discarded before producing any benchmark run because the initial runner failed its ready handshake. A fresh-workspace retry completed; the infrastructure failure is not counted as a task result.

## Interpretation

This result reverses the impression from per-generation selection. The earlier selection experiment found a favorable branch; the production-like no-selection workstream shows that automatic accumulation can also make the harness worse. The useful finding is therefore not “self-improvement works” but:

> Project experience is a plausible source of transferable behavior, and uncontrolled always-on accumulation causes measurable interference.

The next design should keep automatic learning but change how it is applied. Lessons should enter project-scoped skills or knowledge with selective retrieval, provenance, confidence, and revision/retirement, rather than recompiling the entire cumulative lesson set into every runner prompt.

This is a controlled replay of frozen developer-like trajectories, not five newly executed production tickets. The holdout uses different task instances and filenames but shares capability families with the workstream. A stronger follow-up must extract trajectories from actual Omega sessions in one evolving project and evaluate on a project- and family-level holdout that never participates in learning or selection.
