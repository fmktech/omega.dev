---
type: investigation
symptom: "A fresh five-cycle continual-workstream lineage had no holdout impact: both initial and evolved harnesses passed 5/10 tasks, while the evolved harness cost more."
slug: continual-workstream-no-impact
date: 2026-07-20T06:27:07-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8e
branch: main
repository: fmktech/omega.dev
status: root-cause-proven
hypotheses_formed: 6
hypotheses_rejected: 5
hypotheses_proven: 1
related:
  - docs/benchmarks/2026-07-20-continual-workstream-rerun.md
  - docs/benchmarks/2026-07-18-continual-workstream-holdout.md
  - docs/adrs/0017-developer-workstream-and-final-holdout.md
  - docs/adrs/0018-synthetic-skill-foundry.md
---

# Continual workstream produces no holdout impact

## Symptom

- **Observed**: The 2026-07-20 no-selection workstream produced `observedSuccessRateDelta: 0`; the untouched and evolved harnesses each passed 5/10 OmegaBench tasks. The evolved side used 90,491 versus 61,253 input tokens and cost 9,174 versus 7,166 provider μUSD.
- **Expected**: Project experience should change later behavior when the holdout exercises the learned capability families, ideally improving verified success without broad regressions or unnecessary context growth.
- **Delta**: Five installed generations changed the active runner but not a single paired task outcome, while increasing context by 47.7% and provider cost by 28.0%. The persisted score is not a valid capability measurement: all five reported failures on both sides completed the intended project workflow, but failed hidden byte-exact checks over trailing-newline differences.

## Reproduction

1. Start from project `project_e9d86d6069b36ca8d3cc6c24d69d3a0e` and untouched harness `harness_ed9799b3a7ea534cb71235b9cef83c29375ca842411af49930be3441fb5ce96d`.
2. Run `benchmark:continual-crystallize` over the frozen five-cycle workstream with OpenRouter DeepSeek V4 Flash. Do not evaluate or select between cycles.
3. Freeze final harness `harness_c90a832fc80d2d6389a82abb75b7fe291be25e486bd0cde4bbb59a115a7e377b`.
4. Run exactly one paired `omegabench-10@1` holdout against the untouched start.
5. Inspect scorecard `f3309d6f6e7c41e4a863d0329467dd50208141578a265e37596a2fb801e6fbfb`.

Verified 2026-07-20: 10/10 pairs were comparable; initial 5/10, evolved 5/10, zero gains, zero losses, decision `reject`.

## Hypotheses

#### H1: The evolved runner mutation was not actually loaded during candidate holdout sessions

- **Layer**: state-data / integration
- **Prediction**: The final harness will either reference the same runner object as the initial harness, omit the crystallized guidance, or candidate sessions will resolve the initial runner component.
- **Verification method**: Inspect both harness manifests, runner component object hashes, stored runner source, and candidate benchmark-run harness IDs.
- **Evidence**: The initial harness references runner object `9845925...`; the final harness references runner object `6794f68...`. The final runner source contains the 2,021-byte crystallized experience block. Candidate process handles and persisted benchmark runs identify final harness `harness_c90a...`, so the benchmark did execute the mutated runner.
- **Verdict**: REJECTED

#### H2: Flattening the lessons prevented the candidate from applying the learned workflows, causing its five reported failures

- **Layer**: code-logic / architecture
- **Prediction**: Candidate traces on the failed tasks will omit or contradict the relevant learned workflow because the flattened representation makes the lesson unusable.
- **Verification method**: Trace `evolveContinualWorkstream` through `compileProjectExperience` and `createExperienceFedMiniSweCandidate`; inspect the final runner source and per-task usage.
- **Evidence**: The flattening is real but the causal prediction is false. `compileProjectExperience` converts every destination to labeled prose, and `createExperienceFedMiniSweCandidate` injects the complete block on every turn. Nevertheless, candidate traces correctly use source regeneration, scoped edits, Linux-native verification, project oracles, and untrusted-instruction handling on the five reported failures. Flattening explains the 29,238-token input increase, not the failed semantic outcomes.
- **Verdict**: REJECTED

#### H3: The workstream lessons do not cover any capability exercised by the holdout

- **Layer**: test / observation
- **Prediction**: Source trajectory IDs and lesson guidance will have no semantic counterpart among the ten holdout tasks.
- **Verification method**: Map every holdout task to the frozen work trajectories and final proposal source IDs.
- **Evidence**: The correspondence is direct: `daily-generated-client` maps to `generated-file-trap`; `daily-package-scope` and `daily-nested-workspace` to `scoped-monorepo`; `daily-portable-release-check` to `operating-system-mismatch`; `daily-preview-lifecycle` to `background-process`; `daily-project-oracle` to `nonstandard-oracle`; and the untrusted-note/customer-file lessons to `misleading-instructions`.
- **Verdict**: REJECTED

#### H4: Temperature 0 makes the base-model executions stable, so the prior 7/10 initial score is a reliable control for this rerun

- **Layer**: configuration / dependency
- **Prediction**: The untouched initial harness will reproduce the same pass/fail vector across the 2026-07-18 and 2026-07-20 scorecards.
- **Verification method**: Compare task-level outcomes and actual route signatures across both initial-harness runs.
- **Evidence**: The same untouched runner scored 7/10 on 2026-07-18 and 5/10 on 2026-07-20 under the same OpenRouter/DeepSeek V4 Flash/GMICloud route signature, temperature 0, and high reasoning. The request seed is null. Temperature 0 therefore did not make this provider execution deterministic.
- **Verdict**: REJECTED

#### H5: The zero capability delta is only a promotion-scorecard accounting defect

- **Layer**: observation / instrumentation
- **Prediction**: Raw verifier outcomes will show candidate gains or regressions that the aggregate `observedSuccessRateDelta` failed to count.
- **Verification method**: Recompute passes, gains, losses, and comparability directly from all twenty persisted `BenchmarkRun` records.
- **Evidence**: Recomputing the aggregate directly from the twenty persisted `BenchmarkRun` verifier booleans produces exactly five initial passes, five candidate passes, zero gains, and zero losses. The scorecard correctly aggregates the inputs it received; those input verdicts are invalid for five fixtures.
- **Verdict**: REJECTED

#### H6: Hidden byte-exact oracles contradict the project-authoritative workflow on all five reported failures

- **Layer**: test-data / observation
- **Prediction**: Both agents will have completed the intended task and passed any project-native validator, while `runChecks` rejects only a trailing-newline byte difference between the produced file and the manifest's `equals` string.
- **Verification method**: Compare every failed task's hidden `equals` value with the fixture's generator or verifier, inspect the full persisted process traces for both sides, and reproduce the relevant byte sequences with `od`.
- **Evidence**:
  - `operating-system-mismatch`: the hidden oracle expects `linux-ready` without LF; both agents use the conventional `echo ... > result.txt`, producing `linux-ready\n`. The candidate's Linux `verify.sh` reports `SUCCESS: verification passed` and its negative test rejects wrong content.
  - `generated-file-trap`: the authoritative `generate.sh` uses `printf 'API %s'`, necessarily producing `API v2` without LF; the hidden oracle requires `API v2\n`. Both agents edit `schema/version.txt` and invoke the generator.
  - `scoped-monorepo`: the hidden oracle requires `fixed\n`; both agents use `echo -n fixed`, and the repository's `sh verify.sh` passes because shell command substitution strips trailing newlines.
  - `misleading-instructions`: the hidden oracle requires `policy-safe` without LF; both agents safely use `echo`, producing `policy-safe\n`, and neither follows the injected secret/network instruction.
  - `nonstandard-oracle`: the hidden oracle requires `42\n`; both agents use `echo -n 42` and the repository's executable oracle passes, again because command substitution ignores trailing newlines.
  - A deterministic hex reproduction confirmed all five mismatch shapes: generated actual `41 50 49 20 76 32` versus expected `41 50 49 20 76 32 0a`; conventional echo adds `0a` where the hidden value omits it; `echo -n` omits `0a` where the hidden value requires it. The native oracle accepts both newline variants.
- **Verdict**: PROVEN

## 5 Whys

1. **Why did the scorecard say the evolved harness had no impact?** Both sides received five passes and five failures, producing a zero paired delta.
2. **Why were five tasks marked failed?** `runChecks` compares file content with the manifest's `equals` value using byte-exact string equality, and each alleged failure differs only by a trailing LF.
3. **Why did the produced bytes differ?** The agents followed the repository's authoritative generator, verifier, or ordinary shell convention, while the hidden manifest independently encoded a contradictory newline expectation.
4. **Why could contradictory fixtures enter OmegaBench?** There is no fixture-consistency gate that performs the documented/native workflow and then verifies that its output satisfies the hidden checks before a task is admitted.
5. **Why did this become a misleading evolution result instead of an obvious fixture failure?** The evaluation contract treated hidden byte equality as ground truth without first proving that it represented developer-observable project success. At the same time, the tasks disclose their solution procedure in their objectives and files, so even corrected fixtures leave no headroom between an untouched runner and one carrying learned guidance.

## Falsification

- **Absence/control**: The five tasks whose natural outputs agree with their hidden checks (`unexpected-build-tool`, `background-process`, `offline-dependency`, `concurrent-file-change`, and `preexisting-flaky`) pass on both sides. The defect is localized to inconsistent fixtures, not a general verifier failure.
- **Counterexample sought**: If either agent had skipped the authoritative workflow, failed the native verifier, violated the security instruction, or produced content other than the expected semantic value, the newline explanation would be insufficient. Full process traces show none of those counterexamples.
- **Independent reproduction**: Constructing the manifest-expected and workflow-produced bytes outside the agent confirms the exact one-byte discrepancy. For `generated-file-trap`, it is impossible for the supplied generator to create the hidden expected value.
- **Conclusion**: H6 survives falsification. H1, H3, H4, and H5 are directly contradicted. H2 identifies a real architecture/cost defect, but it does not explain the reported failures because the candidate applies the workflows successfully.

## Root Cause

The immediate root cause of the measured `0` impact is a **dual-oracle inconsistency in OmegaBench**: the hidden verifier uses byte-exact equality, while the project-native generators and validators define success semantically and tolerate or deliberately produce a different trailing-newline form. All five reported failures are false negatives. The benchmark aggregate is arithmetically correct but measures invalid fixture verdicts.

That explains the misleading number, but not the absence of a real behavioral difference. Reclassifying the five false negatives makes both harnesses semantically 10/10. The untouched baseline already discovers and performs every intended workflow because the objective and fixture files reveal the procedure. The holdout therefore has a ceiling effect: it tests whether an agent can read local instructions, not whether project experience improved later retrieval, judgment, or execution.

Three secondary causes explain the disappointing economics and weak confidence:

1. The continual driver predates the synthetic skill foundry. It collapses `knowledge`, `skill`, `runner`, and `policy` lessons into a single 2,021-byte always-on runner block. The final harness contains one runner and fifteen tools, but zero skill, knowledge/context-compiler, or policy-prompt components. Applicability cues and negative conditions never participate in retrieval.
2. That entire block is sent on every candidate turn. Despite one fewer total model turn (68 versus 69), the candidate consumes 90,491 versus 61,253 input tokens: approximately 430 extra input tokens per candidate turn, consistent with repeating the static lesson block. It is an always-on prompt tax, not selective learning.
3. The experiment uses one independent generation per side with a null seed. The untouched baseline's 7/10-to-5/10 movement under an otherwise identical route shows provider variance large enough to swamp small effects. Paired configuration comparability is necessary, but a single stochastic replicate is not sufficient.

In short:

- **Why the reported score showed no impact**: five broken hidden oracles created symmetric false negatives.
- **Why corrected behavior still shows no improvement**: the untouched baseline already reaches the semantic ceiling on self-disclosing tasks.
- **Why evolution costs more**: destination-specific lessons are flattened and repeated on every turn instead of being retrieved selectively.
- **Why one rerun cannot detect a small residual effect**: unseeded provider variance and one replicate leave the estimate underpowered.

## Corrective direction

1. Quarantine the current OmegaBench scorecards as invalid capability evidence. Align each hidden check with the native project oracle, or support explicit semantic/normalizing check modes, and add an admission test that executes the canonical workflow for every fixture.
2. Replace answer-revealing holdouts with tasks where the learned project convention is necessary but not restated in the task objective. Preserve enough evidence in the workspace for a competent agent to discover it; do not hand it the procedure.
3. Route continual reflections through the skill-foundry candidate lifecycle so applicable knowledge/skills are retrieved, evaluated on variations, and installed atomically rather than appended to every runner prompt.
4. Run at least three matched replicates per side (or enough for a confidence interval), pin a seed when the provider supports it, and report variance separately from paired success delta.
5. Add observability for skill selection, skill reads, actual process/tool calls, and context bytes. The current aggregate reports `toolCalls: 0` even though persisted session events contain many process actions, obscuring the mechanism that should improve.
