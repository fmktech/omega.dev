# GPT-5.6 Luna reflection ablation — 2026-07-18

## Outcome

Changing only the five reflection calls from DeepSeek V4 Flash to GPT-5.6 Luna did **not** improve the final always-on harness.

In the direct paired comparison:

- DeepSeek-reflection harness: **6/10**
- Luna-reflection harness: **5/10**
- Observed Luna delta: **−0.10**
- Direct scorecard: `a8d810b32d87953e8b7a09d2438b7b28fc01a057e407ff744b6d975fe3faf182`

The initial harness, five cumulative work trajectories, no-selection lineage protocol, holdout suite, task-solving model, policy, and budgets were unchanged. Only the `crystallizer` route changed to [`openai/gpt-5.6-luna`](https://openrouter.ai/openai/gpt-5.6-luna-20260709). OpenRouter recorded OpenAI as the serving provider for all five Luna reflections.

## Direct paired results

| Holdout task | DeepSeek reflection | Luna reflection | Change |
| --- | --- | --- | --- |
| `operating-system-mismatch@1` | fail | fail | tie |
| `unexpected-build-tool@1` | pass | pass | tie |
| `generated-file-trap@1` | fail | fail | tie |
| `scoped-monorepo-verification@1` | pass | fail | Luna regression |
| `background-process@1` | pass | fail | Luna regression |
| `offline-dependency@1` | pass | pass | tie |
| `concurrent-file-change@1` | pass | pass | tie |
| `misleading-instructions@1` | fail | fail | tie |
| `nonstandard-test-oracle@1` | fail | pass | Luna gain |
| `preexisting-flaky-failure@1` | pass | pass | tie |

Luna transferred the repository-owned oracle lesson, but lost scoped-monorepo and background-process behavior. A separate Luna-versus-untouched-baseline run scored 5/10 versus 7/10 (`e1f3208691e16ad09badb8d784d983f2cd44220629f1ad1ba11a56994f6ed4c2`). In that run Luna solved portability, demonstrating run variance; the direct pair above is the primary model-ablation evidence.

## Reflection behavior

Both no-selection lineages completed five valid generations with one structural attempt per generation.

| Five-reflection aggregate | DeepSeek V4 Flash | GPT-5.6 Luna | Luna / DeepSeek |
| --- | ---: | ---: | ---: |
| Input tokens | 6,565 | 5,992 | 0.91x |
| Reasoning tokens | 11,053 | 8,539 | 0.77x |
| Output tokens | 13,533 | 11,007 | 0.81x |
| Provider cost | $0.003296 | $0.073299 | 22.24x |
| Final lessons | 10 | 9 | 0.90x |
| Final guidance characters | 1,532 | 1,618 | 1.06x |

Luna's final reflection was more consolidated: it grouped related work trajectories into cross-cutting lessons such as repository-owned verification and canonical generated-file sources. It produced fewer lessons but slightly more guidance text. Qualitative coherence did not translate into better always-on execution.

## Runtime cost after reflection

In the direct holdout, both harnesses used the unchanged DeepSeek task-solving route:

| Holdout aggregate | DeepSeek reflection | Luna reflection | Luna / DeepSeek |
| --- | ---: | ---: | ---: |
| Provider cost | $0.008594 | $0.011201 | 1.30x |
| Input tokens | 80,956 | 100,767 | 1.24x |
| Summed wall time | 332,395 ms | 391,215 ms | 1.18x |

The Luna-generated harness was less capable and more expensive to run. The extra runtime cost is caused by the resulting always-on guidance and its interaction with task behavior, not by using Luna during holdout tasks.

## Interpretation

The bottleneck is not simply reflection-model intelligence. Luna wrote stronger-looking abstractions and recovered one capability, but compiling all crystallized guidance into every task prompt still created interference.

This reinforces the architectural direction from the continual-workstream result:

- store lessons separately with provenance and scope;
- retrieve only lessons relevant to the current repository state and objective;
- track natural downstream evidence per lesson;
- revise, lower confidence, or retire lessons that correlate with corrections or regressions;
- keep core runner mutations rarer than skill and knowledge updates.

A more capable reflector may become valuable after selective retrieval exists. Under the current always-on compiler, GPT-5.6 Luna costs substantially more without producing a better final harness.
