# Continual developer-workstream rerun — 2026-07-20

## Outcome

A fresh five-day, no-selection DeepSeek V4 Flash lineage tied its untouched starting harness at **5/10** OmegaBench-10 tasks.

- Untouched initial harness: **5/10**
- Final evolved harness: **5/10**
- Observed success-rate delta: **0.00**
- Head-to-head changes: **0 gained, 0 lost, 10 ties**
- Comparable pairs: **10/10**
- Intermediate capability evaluations: **0**
- Selection policy during learning: **none**
- Final scorecard decision: **reject** because the configured +0.10 capability threshold was not met

This rerun provides no evidence that cumulative crystallization improved later base-model behavior.

## Frozen lineage

```text
ed9799… → f7d183… → 8e8897… → 7c3f82… → 24412f… → c90a83…
```

Every structurally valid reflection became the next workday's parent. All five reflections succeeded on their first structural attempt. The active project harness remained unchanged.

- Project: `project_e9d86d6069b36ca8d3cc6c24d69d3a0e`
- Initial harness: `harness_ed9799b3a7ea534cb71235b9cef83c29375ca842411af49930be3441fb5ce96d`
- Final harness: `harness_c90a832fc80d2d6389a82abb75b7fe291be25e486bd0cde4bbb59a115a7e377b`
- Scorecard: `f3309d6f6e7c41e4a863d0329467dd50208141578a265e37596a2fb801e6fbfb`

## Final holdout

| Task | Initial | Evolved | Change |
| --- | --- | --- | --- |
| `operating-system-mismatch@1` | fail | fail | tie |
| `unexpected-build-tool@1` | pass | pass | tie |
| `generated-file-trap@1` | fail | fail | tie |
| `scoped-monorepo-verification@1` | fail | fail | tie |
| `background-process@1` | pass | pass | tie |
| `offline-dependency@1` | pass | pass | protected tie |
| `concurrent-file-change@1` | pass | pass | tie |
| `misleading-instructions@1` | fail | fail | protected tie |
| `nonstandard-test-oracle@1` | fail | fail | tie |
| `preexisting-flaky-failure@1` | pass | pass | tie |

## Model and resource evidence

All workday reflections and holdout runs used OpenRouter `deepseek/deepseek-v4-flash`, served by GMICloud, with high reasoning and temperature 0. All paired routes were comparable.

| Phase | Input tokens | Reasoning tokens | Output tokens | Provider cost | Summed wall time |
| --- | ---: | ---: | ---: | ---: | ---: |
| Five reflections | 6,548 | 7,550 | 10,697 | $0.002699 | — |
| Initial holdout | 61,253 | 3,829 | 8,790 | $0.007166 | 430,277 ms |
| Evolved holdout | 90,491 | 3,747 | 8,663 | $0.009174 | 453,471 ms |

The evolved harness used **47.7% more input tokens**, cost **28.0% more**, and consumed **5.4% more summed wall time** without changing a task outcome.

## Replication interpretation

The previous DeepSeek workstream measured 7/10 for the same untouched harness and 6/10 for a different evolved lineage. In this rerun, that untouched harness scored only 5/10. Temperature 0 therefore did not make these provider executions deterministic; a single ten-pair replicate is too noisy to estimate small harness effects reliably.

The rerun does reproduce the more important qualitative finding: injecting the entire cumulative lesson set into every runner prompt did not produce a robust improvement and increased context cost. It neither confirms improvement nor establishes that every learned lesson is useless.

This driver predates the selective synthetic skill foundry. It still compiles cumulative experience into an experience-fed mini-SWE runner, so this result does **not** evaluate per-skill applicability cues, negative retrieval controls, or skill-level promotion. The next continual benchmark should install provisional project skills from naturally observable work outcomes, retrieve them selectively on later workdays, and perform only one sealed final holdout.

## Durable evidence

- Workstream record: `~/.omega/benchmarks/continual-crystallizations/69df54d7ffc4b4e07971df86913e9c369c8fa0192051184d95d371519449fa96.json`
- Final scorecard record: `~/.omega/benchmarks/scorecards/c156b55555c34635810e5eb5dbd99a209ef1538db980c1d8ddbeaac59c666ee6.json`

The long-lived CLI connection ended before the request returned, but the daemon remained healthy, completed all twenty task runs, and atomically persisted the final scorecard. No partial result was used for mutation or selection.
