# Feedback-to-skill transfer benchmark

Date: 2026-07-20  
Status: completed, one replicate  
Coding and correction model: `deepseek/deepseek-v4-flash` through OpenRouter  
Reflection model: `deepseek/deepseek-v4-flash` through OpenRouter  
Evidence: `~/.omega/benchmarks/feedback-skill-transfer/74282df7081adfa46d67d14635515ee6b5657c7965a6a5ae44e7d93bf52eb11e.json`

## Question

Can Omega transfer a testing skill that initially exists only in a user's judgment into a project harness?

The benchmark models that transfer directly. The unevolved harness receives the deliberately vague request `Create good tests for src/plan-dispatch.ts`. A hidden mutation evaluator acts as the user, returning procedural corrections until the suite is accepted. Reflection sees that complete back-and-forth and crystallizes a project-scoped skill. The incumbent and candidate then receive the same vague request against three unseen modules.

Holdout results cannot revise the skill. The first holdout attempt is sealed and receives no feedback. Later evaluator messages are allowed only so the benchmark can count how many additional user interventions each harness would need to finish the work.

## Result

The candidate preserved final correctness and reduced aggregate simulated user corrections from five to three. It improved two of three paired holdouts under the benchmark's lexicographic rule and therefore passed this one-replicate transfer check.

| Metric | Incumbent | Candidate | Change |
| --- | ---: | ---: | ---: |
| Final hidden mutations killed | 13/13 | 13/13 | tied |
| First-attempt mutations killed | 10/13 | 10/13 | tied |
| Evaluator/user corrections | 5 | 3 | -40% |
| Model turns | 52 | 43 | -17% |
| Tool calls | 74 | 60 | -19% |
| Invalid tool calls | 0 | 0 | tied |
| Input tokens | 290,669 | 203,198 | -30% |
| Output tokens | 51,852 | 28,856 | -44% |
| Equivalent model cost | $0.037388 | $0.023022 | -38% |

This is evidence of reduced intervention and work, not a claim that every first attempt became better. Aggregate first-attempt correctness tied, and the per-project outcomes were mixed.

## Learning trajectory

The training suite initially killed 6/10 hidden mutations. The evaluator supplied two user-like corrections, after which it killed 10/10, passed strict TypeScript compilation, passed native tests twice, and left production source unchanged.

The learning episode used 17 model turns, 25 tool calls, 143,510 input tokens, and 33,979 output tokens. It had no invalid tool calls. Intentional failing test executions during red/green iteration were recorded separately and did not count as tool misuse.

Reflection produced an 8/10 proposal and installed one immutable project-scoped skill, `guard-against-partial-writes-in-test-driven-design`. Its reusable instruction is to construct a case where an earlier item could succeed and a later preflight fails, then assert that no writes occurred. Applicability and negative-applicability cues prevent the instruction from being used where incremental writes are intentional or where no preflight/write split exists.

## Holdout details

| Unseen project | First attempt, incumbent | First attempt, candidate | Corrections, incumbent | Corrections, candidate | Final | Pair verdict |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Feature-batch activation | 4/5 | 4/5 | 2 | 1 | both 5/5 | candidate improved |
| Release publication | 4/4 | 3/4 | 2 | 1 | both 4/4 | candidate did not improve |
| Ordered migrations | 2/4 | 3/4 | 1 | 1 | both 4/4 | candidate improved |

The release-publication pair is the important counterexample: the candidate missed one more mutation on its sealed attempt, even though it recovered with one fewer correction. Correctness has priority over efficiency, so that pair is not counted as improved.

## What the benchmark establishes

- A vague task plus iterative user feedback can be captured as structured reflection evidence.
- Reflection can turn that trajectory into a real, retrievable, project-scoped `SKILL.md` component rather than a benchmark-only prompt.
- The skill can transfer to unseen source modules while final evaluator correctness remains unchanged.
- In this replicate, the transfer reduced corrections, model turns, tool calls, tokens, and model cost.

## What it does not establish

- One replicate is not enough for a statistical or model-independent claim.
- All fixtures are TypeScript batch/preflight workflows, so the distant holdout is structurally different but remains in the same broad skill family.
- The deterministic evaluator gives clearer feedback than some real users will provide.
- Correction rounds retain the edited workspace but start a fresh model session with a handoff-style objective; they do not preserve hidden conversational state.
- The generated skill earned 8/10 because it captured the atomicity lesson but not every concept present in the feedback trajectory.

The next meaningful run is three or more model-marked replicates, followed by a real-project shadow mode that records naturally occurring developer corrections without exposing private holdout checks to reflection.

## Reproduction

```sh
pnpm build
pnpm benchmark:feedback-skill-transfer 1
```

The implementation is in `src/evolution/feedback-skill-transfer-benchmark.ts`; the executable orchestration is in `src/feedback-skill-transfer-benchmark-main.ts`; the benchmark design is in `docs/benchmarks/feedback-to-skill-transfer-plan.md`.
