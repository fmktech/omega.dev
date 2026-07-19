# Reflection-to-skill transfer benchmark plan

## Behavioral contract

This benchmark measures one production-shaped learning loop without using evaluation results as learning input:

1. A crystallizer sees only a completed developer conversation and returns a reflection proposal.
2. The production skill crystallizer compiles that proposal into an immutable, project-scoped candidate harness.
3. Incumbent and candidate receive the same later project tasks through the same pinned model route.
4. The candidate sees only the compact installed-skill catalog initially and must use `skill.read` to retrieve the full procedure.
5. A hidden deterministic rubric scores whether the later response applies the procedure. It is never included in reflection, catalog, skill, or task prompts.

This is a retrieval-and-application component benchmark, not a Promotion Eval and not yet a full workspace execution benchmark. It must never activate the candidate or feed scores back into reflection.

## Primary behaviors

- A relevant later task causes the candidate to retrieve the installed skill and apply every required project procedure.
- The incumbent receives no synthetic skill and provides the counterfactual baseline.
- An unrelated later task does not cause the candidate to retrieve or apply the skill.
- Every pair records the actual model, route, serving provider, quantization, generation identifier, tokens, cost, and ordering.
- A route/provider/quantization mismatch invalidates the pair instead of producing a comparative claim.
- A `no-change`, malformed, ungrounded, or non-skill reflection creates no candidate and no downstream comparison.
- The output record retains reflection evidence SHA, proposal, compiled skill component/object hashes, and per-run raw responses for audit.

## Edge-case taxonomy

| Taxonomy row | Decision | Cases |
| --- | --- | --- |
| Empty / null / missing | Apply | empty catalog; no-change reflection; completion with no text; completion without terminal event |
| Boundary values | Apply | one skill lesson; maximum four reflection lessons remains parser-owned; one irrelevant holdout; turn one permits skill selection and turn two removes tools to require a final plan; no final answer becomes a failed run rather than aborting the series |
| Invalid input | Apply | malformed final JSON; unknown evidence reference; wrong reflection target; unexpected tool name or component ID |
| Dependency failure | Apply | model start/stream provider failures receive at most two bounded retries recorded in evidence; non-provider failures surface immediately; object-store failure is covered by production crystallizer tests |
| Concurrency / ordering | N/A | benchmark pairs are deliberately sequential; order is alternated and recorded to expose order effects |
| Idempotency / duplicate delivery | Apply | repeated semantic lesson must not create another candidate; production crystallizer test owns this assertion |
| Unicode / encoding / timezone | Apply | production skill slug fallback/normalization remains covered separately; benchmark evidence uses UTF-8 and explicit ISO timestamps |

## Holdout shape

Two relevant tasks reuse the project's learned generated-auth configuration workflow with different requested values. They require the canonical source edit, regeneration command, auth-scoped verifier, preservation of the web workspace, and no direct edit of generated output. One unrelated documentation task measures retrieval precision and must not use the auth skill.

The task prompt includes a neutral repository inventory, not the learned source/regenerate/verify relationship. The hidden rubric checks concepts and forbidden actions independently of the response parser.

## Decision rule

Report evidence rather than auto-promote. A positive transfer signal requires all of:

- every compared pair is route-compatible;
- candidate relevant-task pass rate exceeds incumbent relevant-task pass rate;
- candidate retrieves the skill on relevant tasks;
- candidate does not retrieve the skill on the unrelated task;
- candidate has no irrelevant-task regression.

Anything else is mixed, negative, or invalid evidence and remains visible in the record.

## Mutation checks

The deterministic test suite must fail if any of these mutations are introduced:

- catalog condition is ignored;
- `skill.read` is counted without the exact installed component ID;
- a response omits regeneration or scoped verification but still passes;
- direct generated-file editing or web-workspace changes are not rejected;
- irrelevant skill retrieval is not penalized;
- route mismatch is treated as a valid pair;
- hidden rubric text leaks into model prompts.
