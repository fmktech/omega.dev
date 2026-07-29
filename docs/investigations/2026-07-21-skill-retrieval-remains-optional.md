# Skill retrieval remains optional investigation

## Observed failure

In two positive near-transfer candidate arms, the installed skill was not read. The first candidate failed a task naming `src/domain/repository.js`; the skill catalog listed that exact path. The second candidate regressed against an incumbent pass, making promotion impossible under the zero-regression policy.

## Hypotheses

1. The candidate harness did not contain the generated skill.
2. The runner loaded the skill but benchmark accounting missed the event.
3. The runner delegated retrieval entirely to the coding model, which skipped an applicable catalog entry despite an exact relevant-path match.

## Evidence and conclusion

Hypothesis 1 is falsified: the candidate manifest contains `skills/node-24-offline-storage-app-contracts/SKILL.md`, and its catalog includes `src/domain/repository.js`. Hypothesis 2 is falsified: both model transcripts contain no `skill.read` request and both metrics report zero reads. Hypothesis 3 is proven: bootstrap supplied only a compact catalog and a natural-language instruction asking the model to decide whether to call `skill.read`.

## Five whys

1. Why did the learned procedure have no effect? Its document never entered model context.
2. Why was it not loaded? Retrieval was another optional model decision.
3. Why did an exact path cue not suffice? The runner provided no deterministic retrieval path for high-confidence matches.
4. Why did the benchmark catch it? Positive synthetic tasks require a candidate-only skill read and record `skill-not-loaded` otherwise.
5. Why does this matter outside benchmarks? Project memory that depends on the model remembering to ask for memory is unreliable during daily maintenance.

## Fix and falsification

The runner deterministically preloads at most one skill when the objective names one of its exact `relevantPaths` or strongly matches an applicability cue, after applying negative cues first. The loaded immutable result is placed in the existing per-session cache and injected into system context. A regression proves an exact path is preloaded before `model.start`; another proves an authentication/framework negative cue blocks preload.

## Follow-up failures

The first fix exposed three additional boundary defects in live paired runs:

1. A model correctly reasoned that an authentication/network skill was excluded, then called `skill.read` anyway several turns later. Prompting did not enforce the contract.
2. A two-token negative matcher treated “return undefined instead of null” as matching “SQL/external databases that return null,” preventing a positive exact-path load.
3. A remote legacy-sync task using a Bearer token did not share the literal words in the skill's negative cues, so the model opportunistically loaded the skill late.

These falsify both “the model will obey a negative cue” and “a lexical blacklist can enumerate semantic non-applicability.”

## Final routing invariant

Skill access is now positive-authorized at bootstrap:

- negative cues are evaluated with negation-aware, proportional matching;
- every skill that passes a strong positive path/applicability threshold is recorded as eligible;
- the highest-ranked eligible skill is preloaded once;
- later model calls can read only eligible skills;
- excluded or unselected component IDs are rejected locally and never produce `skill.loaded`;
- successful immutable reads are served from the session cache.

Protocol tests cover positive exact-path retrieval containing both “no-auth” and “instead of null,” explicit negative exclusion, late reads of an unselected remote-service skill, and repeated reads after a successful preload.

## Real-workspace replay result

An experimental harness combined the rejected learned storage skill with the corrected runner and replayed the original vague greenfield objective from the empty git checkpoint with no feedback. Routing worked: the skill loaded exactly once. The session succeeded after 336 seconds, 41 model turns, 59 model tool calls, and 18 process starts. Its own generated suite passed 41/41, but the independent holdout passed only 2/7. It missed atomic conflict preservation, Unicode/argument contracts, trimmed filtering, safe 413 behavior, and the exact 404 JSON shape.

Conclusion: retrieval is now enforceable, but the learned content is not yet a faithful compression of the feedback history. Zero user interventions alone is not success; correctness and reduced work must both improve. The candidate remained rejected and the project was restored to the vetted harness.
