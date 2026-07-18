# Five-cycle process crystallization benchmark — 2026-07-18

Methodology note: this experiment tests scorecard-driven lineage selection. It does not model production project learning. The no-selection developer-workstream follow-up is [`2026-07-18-continual-workstream-holdout.md`](./2026-07-18-continual-workstream-holdout.md).

## Outcome

Five cumulative process-learning cycles produced **two promoted mutations followed by three rejected mutations**. The retained lineage improved from the repaired, unfed mini-style baseline to the cycle-2 harness, then plateaued:

```text
unfed baseline ──promote──> cycle 1 ──promote──> cycle 2 (retained)
                                                   ├── reject cycle 3
                                                   ├── reject cycle 4
                                                   └── reject cycle 5
```

The evolution gate prevented all three later regressions from entering the retained project harness. No experimental harness replaced the active `omega.dev` harness.

| Cycle | New ordinary-work evidence | Parent → candidate | Passed | Delta | Decision |
| ---: | --- | --- | ---: | ---: | --- |
| 1 | Six initial trajectories | `ed9799…` → `669613…` | 5 → 6 | +0.10 | promote |
| 2 | Cross-platform release check | `669613…` → `4dd426…` | 6 → 8 | +0.20 | promote |
| 3 | Generated SDK client | `4dd426…` → `c4a0a3…` | 6 → 5 | −0.10 | reject |
| 4 | Fresh-process nested workspace | `4dd426…` → `a207cf…` | 7 → 4 | −0.30 | reject |
| 5 | Untrusted customer file | `4dd426…` → `a3aa6f…` | 6 → 3 | −0.30 | reject |

Final retained experimental harness: `harness_4dd4265368093247689eca90f1394677d97c1337f66251fc371f1131d6d1cbaf`.

## What the crystallizer could see

Each cycle added one sanitized work trajectory to the cumulative evidence set. The crystallizer received project context, attempts, ordinary failures, recovery steps, and the locally observed result. It did **not** receive sealed task names, verifier output, scores, scorecards, promotion decisions, or the reasons previous candidates were rejected.

The controller alone used the paired scorecard to retain the candidate or branch again from the incumbent. Therefore cycles 4 and 5 knew the generated-client and nested-workspace work experiences, but did not know that the corresponding mutations had failed evaluation.

The input validator rejected one malformed cycle-3 model response containing an unknown learning target. A retry against identical evidence produced a valid proposal; the invalid proposal was never installed or evaluated.

## Scorecards

| Cycle | Scorecard | Changed sealed outcomes |
| ---: | --- | --- |
| 1 | `8fdd909b9fe9ce9bed13277c924138ea237a1411e57a7774a5d18fa441063ef3` | `nonstandard-test-oracle`: fail → pass |
| 2 | `c37041692569c0ae5d3e5bcf797160bc0b5878563f52ccfd6c639e1b48e3cfeb` | `operating-system-mismatch`: fail → pass; `nonstandard-test-oracle`: fail → pass |
| 3 | `af5699da1626ffda26e72f696143a12133ad6f601a99e248626504ae8f1c3b97` | `background-process`: pass → fail |
| 4 | `3fd6fce21bb130b3643bcab7080ba2f0bedd21aa3e83d1ff8fbdb17eb96acd9b` | `scoped-monorepo-verification`, `background-process`, and `nonstandard-test-oracle`: pass → fail |
| 5 | `4b60649f6e36330cc1fb7aca67ab835cc37591493431ffccee2d21889cf1ed2c` | `operating-system-mismatch`, `scoped-monorepo-verification`, and `offline-dependency`: pass → fail |

All runs used `omegabench-10@1`, OpenRouter, `deepseek/deepseek-v4-flash`, GMICloud serving, temperature 0, and model-marked scorecards.

## Retained-harness stability

Cycle 2's promoted `4dd426…` harness was measured four times: once as the candidate and three times as the incumbent. Its observed scores were **8, 6, 7, and 6 out of 10** (mean 6.75). Seven task outcomes were stable across all four runs. Three varied:

| Task | Passes across four retained-harness runs |
| --- | ---: |
| `operating-system-mismatch@1` | 2/4 |
| `nonstandard-test-oracle@1` | 2/4 |
| `preexisting-flaky-failure@1` | 3/4 |

Consequently, 8/10 is the best paired observation, not a claim that the retained harness deterministically solves eight tasks. The five-cycle result supports selective improvement, but also exposes evaluator variance and the need for replicated promotion decisions.

## Resource evidence

| Cycle | Crystallizer cost | Paired-evaluation cost | Combined run wall time |
| ---: | ---: | ---: | ---: |
| 1 | $0.000395 | $0.015810 | 787,276 ms |
| 2 | $0.000525 | $0.017776 | 864,291 ms |
| 3 | $0.000589 | $0.019717 | 770,069 ms |
| 4 | $0.000520 | $0.022505 | 870,307 ms |
| 5 | $0.000636 | $0.020136 | 969,586 ms |
| **Total** | **$0.002665** | **$0.095944** | **4,261,529 ms** |

Mutation generation consumed 2.7% of the recorded provider cost. Paired isolated evaluation consumed 97.3% and roughly 71 minutes of summed task wall time. The practical scaling constraint is trustworthy evaluation, not lesson generation.

## Interpretation

The experiment went farther than one positive transfer: it exercised cumulative memory, branching from the last accepted generation, invalid-mutation rejection, automatic promotion, and automatic regression containment. It did **not** show monotonic gains. More experience created more specific guidance and larger prompts, but the last three candidates performed worse.

This plateau is not a fundamental ceiling. It is a ceiling of the present search procedure:

- one crystallizer proposal per cycle;
- lessons compiled into an always-on runner prompt rather than selectively retrieved;
- one paired replicate per promotion decision;
- only ten coarse pass/fail tasks;
- the same suite reused for selection at every generation.

Even without exposing evaluation results to the crystallizer, repeatedly selecting on the same sealed suite can overfit the **controller's lineage** to that suite. Process reflection avoids direct answer leakage; it does not eliminate selection bias. The next credible step is to generate several candidates from the same work evidence, use repeated paired runs for the promotion gate, and reserve a project-specific holdout suite that never participates in promotion.

The stronger product conclusion is: project fitting should be aggressive in skills and knowledge, but adoption must remain conservative. A harness can learn everything it observes; only evidence-backed mutations should become the project's next default.
