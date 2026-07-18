# Reflection component benchmark — 2026-07-18

## Outcome

The reflection component can extract useful project learning from realistic developer conversations, but it is not yet reliable enough to apply every proposal without structural validation.

DeepSeek V4 Flash scored **79/100** across ten hidden-rubric scenarios for **$0.002264**. It made the correct evolve/no-change decision in all ten cases, avoided every prohibited contradiction, and correctly routed eight cases. No coding agent, tool, or downstream task run participated in this benchmark.

GPT-5.6 Luna produced no comparable result: OpenRouter returned HTTP 404 before its first scenario. The failure was recorded independently and did not discard the completed DeepSeek run.

Production reflection is restored to `deepseek/deepseek-v4-flash`. Luna is not a production dependency.

Durable raw record: `~/.omega/benchmarks/reflections/28001e891a8c7ac152f28260157bfeb07fcd4f44fea42f6c63cd7cb08a870545.json`

## What was tested

Each scenario is an ordered transcript of user messages, assistant attempts, corrections, and tool outcomes. The reflector receives the public transcript and project context. It never receives the hidden rubric or a downstream benchmark score.

| Scenario | Expected learning destination | DeepSeek |
| --- | --- | ---: |
| Generated configuration source, regeneration, and scoped verifier | skill | 8/10 |
| User rejects a stale green test in favor of the contract | runner | 8/10 |
| Customer text is data rather than instruction authority | policy | 7/10 |
| Supervise, await readiness, use, terminate, verify cleanup | skill | 9/10 |
| Jira connector plus its external-access contract | tool | 10/10 |
| Explicitly temporary compatibility workaround | no change | 10/10 |
| Nonstandard outbox-only mutation architecture | knowledge | 7/10 |
| Linux/rootless-Podman/fresh-shell local environment | knowledge | 7/10 |
| Never apply production migrations from an agent session | policy | 8/10 |
| Guided and verified api-client release procedure | skill | 5/10 |

The suite therefore tests the distinction the product needs:

- durable project and environment facts become project knowledge;
- ordered, repeatable procedures become skills;
- hard side-effect boundaries become policy;
- always-on project decision rules become runner guidance;
- missing executable capabilities become tools;
- expiring exceptions produce no harness change.

## Hidden scoring contract

The ten-point evaluator checks the decision, lesson-count bound, destination, exact evidence citations, three independently specified concepts, and absence of contradictory guidance. The no-change case separately rewards the decision, empty lessons, recognition of temporariness, and rejection of generalization.

The rubric is deterministic and never serialized into the model prompt. The tests also passed a mutation check: temporarily bypassing evidence validation caused the negative scorer test to fail from an expected 3 points to 5, proving the test detects that defect.

## Detailed findings

| Dimension | Result |
| --- | ---: |
| Correct evolve/no-change decision | 10/10 |
| Correct destination | 8/10 |
| Within scenario lesson bound | 9/10 |
| Exact required evidence set | 6/10 |
| Required durable concepts | 19/26 |
| Contradiction-free | 10/10 |

The hard-rule and external-access cases worked conceptually:

- The hard production-migration rule became a policy lesson containing all three required ideas: never agent-apply, verify offline, and reserve apply authority for the deployment controller.
- The strengthened Jira case scored 10/10. Its tool proposal preserved typed operations, runtime-only credentials, an idempotency key, cursor pagination, `Retry-After`, and the prohibition on arbitrary curl.

DeepSeek still missed exact provenance in four scenarios, usually citing the user's final confirmation instead of the tool event proving the successful outcome. This is useful language but weaker evidence for autonomous evolution. Proposed updates should therefore require both instruction evidence and observed-outcome evidence before installation.

The most important semantic miss was the nonstandard architecture scenario. DeepSeek abstracted the concrete outbox-only architecture into a generic skill to read architectural documentation. That is reasonable advice, but it loses the exact project fact and places it in the wrong layer. This supports storing concrete facts first and deriving reusable skills separately, rather than allowing one abstraction to replace its source knowledge.

The guided release scenario exposed the same lossy-abstraction problem more sharply. DeepSeek chose the correct `skill` destination but emitted generic guidance to capture verified procedures as skills; it omitted the changeset, generation, scoped test, pack, tarball inspection, and no-publish steps, earning zero of three procedure concepts. A skill proposal must preserve the executable sequence, not merely state that a sequence should be remembered.

The preview-process case exceeded its one-lesson bound by splitting a single lifecycle into both a skill and runner rule. Even good lessons need consolidation so that repeated reflection does not grow an unbounded harness.

## Runtime retrieval follow-up

The retrieval gap exposed by this benchmark was implemented immediately afterward. Before its first model call, the initial runner now receives deterministically discovered scoped `AGENTS.md` documents and compact catalogs for project knowledge and installed skills. Full knowledge and skill documents remain selectively loaded through `knowledge.read` and `skill.read`.

Retrieval relevance is still model-selected in this first slice. A later benchmark should measure catalog recall and whether the runner opens the right document before acting; semantic ranking and automatic path-derived prefetch remain evolvable context-compiler work.

## Interpretation

This benchmark is closer to ordinary development than promotion from hidden task results: evolution sees only what the developer and tools revealed during the work. The hidden rubric measures the reflector after the fact but is never fed back into that reflection.

The result supports a two-stage evolution path:

1. Reflect from the session into evidence-linked candidate knowledge, skill, runner, tool, or policy updates.
2. Deterministically validate scope, destination, provenance, size, and contradictions before automatic installation.

The next meaningful benchmark should replay sanitized real project sessions and measure whether later tasks retrieve and follow the installed item. It should not tune prompts on these ten scenarios or promote from their hidden scores.
