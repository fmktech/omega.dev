# Storage app real-workspace replay — 2026-07-21

## Verdict

Did not transfer successfully. The experimental harness eliminated human feedback during replay, but produced a materially incomplete implementation and used more work than acceptable. It was not promoted.

## Method

- Project fixture: `/Users/fkesheh/projects/omega-storage-bench-v4`
- Empty baseline checkpoint: `68893e03116b6f2acbd9c81af4af118990f0175f`
- Five-feedback reference checkpoint: `316b961`
- Experimental replay checkpoint: `2b99637`
- Model: `deepseek/deepseek-v4-flash` through OpenRouter
- Prompt: `Build a usable storage web app for managing locations and lots. It must have no login or authentication. Include tests and make it ready for another developer to maintain. Work until the implementation and verification are complete.`
- Feedback during replay: none
- Evaluation feedback was not exposed to the runner.

The learned skill had been rejected by the synthetic promotion gate. For diagnostic purposes only, it was combined with the corrected positive-authorized runner, made temporarily active, and replayed from the clean checkpoint. The project was restored to the vetted harness afterward.

## Execution

| Metric | Replay |
| --- | ---: |
| Wall time | 336 seconds |
| Model turns | 41 |
| Model tool calls | 59 |
| Process starts | 18 |
| Skill reads | 1 |
| Human interventions | 0 |
| Input tokens | 599,160 |
| Output tokens | 17,853 |

Skill routing behaved as intended: the storage skill was positively selected and loaded exactly once.

## Evaluation

| Evaluation | Result |
| --- | ---: |
| Runner-authored local suite | 41 / 41 |
| Independent holdout | 2 / 7 |

The holdout failures were:

1. rejected nonempty-location deletion did not expose the required thrown conflict contract;
2. Unicode location creation returned a result envelope instead of the location object;
3. filtered lot listing returned a result envelope and did not honor the expected direct contract;
4. oversized request handling reset the socket instead of returning a usable 413 response;
5. unknown routes added an unexpected `code` field to the required stable JSON shape.

## Root cause

The reflection preserved names, paths, broad module ownership, and error-code vocabulary, but compressed away observable protocol details: direct value versus `{ok,data}` envelope, throw versus return, argument/identifier trimming semantics, exact JSON response shape, and connection behavior after 413. The runner then built a coherent implementation around the wrong inferred protocol and wrote 41 tests that agreed with its inference.

This is a content-fidelity failure, not a retrieval failure. A skill can load correctly and still reduce confidence by making an underspecified interpretation feel authoritative.

## Decision

- Keep the experimental skill rejected.
- Keep the positive-authorized skill-routing fixes.
- Require reflection candidates to enumerate observable input/output/error/side-effect contracts, not merely symbols and architecture.
- Make the next learning benchmark score contract extraction fidelity before paying for workspace execution.

## Contract-fidelity gate implemented — 2026-07-21

Reflection skill lessons now require a non-empty observable contract ledger. Each learned operation must explicitly record inputs, outputs, errors, side effects, and exact values; an absent behavior must be written as `none`. Skill lessons also require repository paths plus positive and negative applicability cues. Candidate construction independently checks these fields, so manually assembled or legacy proposals cannot bypass the parser.

The compiled `SKILL.md` preserves the ledger as an authoritative JSON section and warns the runner not to substitute result envelopes for direct values, returned errors for thrown errors, or approximate response bodies for exact wire shapes.

A regression fixture proves that the original broad storage guidance is rejected, while a complete five-operation ledger preserves all holdout contracts: conflict-safe delete/throw behavior, Unicode/direct creation, trimmed filtering/raw arrays, usable HTTP 413 handling, and the exact 404 body.

Production-route validation used `deepseek/deepseek-v4-flash` through OpenRouter. All 11 reflection scenarios completed with no structural failure and scored 91/110 under the existing semantic rubric. Cost was 5,297 microdollars. This is evidence that the reflection model can produce the stricter shape from ordinary correction transcripts; it is not yet evidence that the storage workspace replay passes. A new clean replay remains the next capability test.

## Fresh storage reflection and candidate gate

A first real-project attempt exposed a capability/prompt contradiction: the proposal objective forbade workspace tools, but the evolution child still inherited `read-files`. DeepSeek made four rounds of discovery calls and exhausted its model-call budget before returning a proposal. Evolution children now receive no workspace grants; the lifecycle test asserts the zero-grant, zero-process envelope.

The retry produced inactive candidate `harness_30ddd884cbc92f80f77af5d35dfd8080326e5d499a89b8d4b90cc6031f93771e`. Its compiled ledger preserved all five previously missed behaviors and the no-auth contract. The candidate-side synthetic task completed successfully. The paired result is intentionally invalid: the incumbent-side retry remained active beyond its cumulative task wall-time budget because wall time is currently reapplied per model call. Evolution `7a95c5e9-5a0a-4eca-9e3a-80a015d8e892` was cancelled, the candidate stayed inactive, and no promotion claim is made.

This run also identified the next fidelity seam: when workspace reads are forbidden and evidence does not carry verified paths, the model may invent plausible `relevantPaths`. Future reflection input should carry observed repository paths from session evidence or derive paths mechanically from the source-session event/file-read record; they should not be free-form guesses.

## Retry after cumulative deadline enforcement

Model-call deadlines now consume the session's remaining cumulative wall-time budget instead of resetting the full allowance on every call. An expired session is rejected before the provider is invoked, and an in-progress request is clamped to the remaining session time. This made the paired gate terminate deterministically.

The repaired retry produced inactive candidate `harness_162787b5d61aee4eeb4cc9c213bcb8e518d277270883a02b6101c0d144d88f17` and ran three matched near-transfer replicates with the same `deepseek/deepseek-v4-flash` route and serving provider for both arms.

| Arm | Hidden verifier | Model turns per replicate | Skill reads per replicate |
| --- | ---: | --- | --- |
| Incumbent | 0 / 3 | 24, 24, 24 | 0, 0, 0 |
| Candidate | 0 / 3 | 24, 8, 17 | 3, 1, 2 |

The candidate was retrieved and read, but it did not improve the hidden task outcome. One candidate replicate used substantially fewer turns, but a cheaper failure is not evidence of learning. Because the prerequisite near-transfer gate failed for both arms, the remaining generalization and negative-applicability work was cancelled rather than spending more model budget on a candidate that could not qualify for promotion.

Evolution job `7a95c5e9-5a0a-4eca-9e3a-80a015d8e892` is `cancelled`; the project continues to use the previously vetted harness. No clean-workspace replay or promotion was attempted for this candidate.
