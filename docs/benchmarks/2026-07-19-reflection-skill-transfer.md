# Reflection-to-skill transfer benchmark — 2026-07-19

## Outcome

The first native reflection-to-`SKILL.md` transfer benchmark produced **no positive end-to-end transfer signal**.

- Relevant task pairs: **6** across two holdouts and three replicates
- Irrelevant task pairs: **3** across one adjacent documentation holdout
- Route-comparable pairs: **9/9**
- Candidate retrieval on relevant tasks: **6/6**
- Candidate non-retrieval on irrelevant tasks: **0/3**
- Incumbent relevant full passes: **0/6**
- Candidate relevant full passes: **0/6**
- Candidate relevant closed-loop passes: **0/6**
- Automatic activation or promotion: **none**

The benchmark therefore rejects the next proposed product step—automatic post-session reflection scheduling—for now. Retrieval works, but destination completeness and retrieval precision do not.

Durable raw record: `~/.omega/benchmarks/reflection-skill-transfer/09ca1f8159bc5f36d04edfede483728f5404ae035fef522066175f441c18cdfe.json`

## Follow-up: atomic bundle and scoped retrieval

The recommended compiler and runner changes were implemented and evaluated with the same three scenarios, three replicates, route-comparability rule, and downstream scorer. The new reflection prompt additionally requires repository paths and positive and negative applicability conditions; it still receives no evaluation output.

The compiler now creates one immutable candidate in which a skill lesson carries every related `knowledge`, `runner`, `tool`, and `policy` lesson as explicitly labelled companion guidance. This avoids partially activating cross-destination advice while ensuring a selected skill exposes the whole evidence-supported bundle. The catalog now includes `relevantPaths`, `appliesWhen`, and `doesNotApplyWhen`. The initial runner also caches successful reads by immutable component ID for the life of the session.

The follow-up result remains **mixed and is not promotion evidence**:

| Measure | Before | Follow-up |
| --- | ---: | ---: |
| Comparable pairs | 9/9 | 9/9 |
| Relevant retrieval | 6/6 | 6/6 |
| Irrelevant non-retrieval | 0/3 | 2/3 |
| Canonical source | 4/6 | 5/6 |
| Regeneration | 4/6 | 5/6 |
| Scoped verifier | 4/6 | 5/6 |
| Never directly edit generated output | 4/6 | 5/6 |
| Web-workspace boundary, frozen lexical score | 0/6 | 0/6 |
| Relevant full passes | 0/6 | 0/6 |

The raw follow-up record is `~/.omega/benchmarks/reflection-skill-transfer/e4c6aca33c3548d4703ccc9b3617843ab74a2611f6ea9fb4a6b818120f87c149.json`.

The new reflection scored **9/10** and produced a project fact plus a scoped auth workflow. Both were preserved in the installed skill bundle. Five of six relevant candidate outputs applied the source/regenerate/verify/no-direct-edit sequence. The sixth retrieved the correct skill but returned no final text. Two of three documentation-only runs correctly avoided retrieval.

The frozen scorer also exposed a measurement limitation that was not changed after seeing results: candidate plans used wording such as “do not run npm test or touch any files in the web/ workspace,” while the positive concept matcher accepted only a small set of different phrases. Separately, its forbidden-claim matcher treats a negated phrase such as “do not run npm test” as if it recommended `npm test`. These runs therefore remain strict failures, but the raw responses must be consulted before concluding that the boundary was absent. A future benchmark version should freeze a negation-aware semantic judge before collecting a new series; these v1 results must not be rescored in place.

Follow-up provider usage was $0.000452 for reflection, $0.002054 for incumbent runs, and $0.002278 for candidate runs: **$0.004784 total**. The nine pairs used the same OpenRouter model and GMICloud serving provider. Three incumbent and two candidate transient retries were recorded without exhausting the bound.

## Method

One fresh DeepSeek V4 Flash reflection saw only the frozen completed developer conversation about generated authentication configuration. Its proposal was compiled through the production `createReflectionSkillCandidate` path into an immutable project-scoped harness child.

The untouched incumbent and compiled candidate then received the same three later tasks:

1. change an authentication timeout;
2. change an authentication lockout threshold;
3. make an adjacent authentication documentation-only edit.

Each condition received the compact installed-skill catalog first. Turn one could call typed `skill.read`; turn two had to return a structured implementation plan. The evaluator-only rubric was not serialized into reflection, catalog, skill, or task prompts. Incumbent/candidate order alternated by replicate. This measured retrieval and procedural application, not file execution, Promotion Eval, or hidden-result-driven selection.

## Reflection and compiled candidate

The reflection scored **7/10**. It correctly chose evolution and emitted two lessons:

| Target | Lesson | What it contained |
| --- | --- | --- |
| `skill` | Source-and-regenerate workflow for runtime config | edit `config/service.toml`, run `tools/render-config`, never edit generated output directly |
| `policy` | Do not touch the web workspace | run `./verify-auth`, avoid root `npm test`, do not change the web workspace |

The production path was intentionally skill-scoped, so it compiled only the first lesson. The verifier and web-workspace boundary were lost from the installed skill even though they were present in the reflection. Candidate lineage remained correct:

```text
harness_reflection_skill_transfer_incumbent_v1
  → harness_0963cab98891ee5b777f635689ce3185f904bff95e18b874bba67441c7759062
```

Installed skill component: `component_dd48873dd22d21611c74881d0be23419f142d0a104b1b5cb05cb05c80dc8ddff`.

## Detailed transfer signal

The hidden relevant-task rubric had five independently scored concepts:

| Required concept | Incumbent | Candidate | Possible |
| --- | ---: | ---: | ---: |
| canonical source | 6 | 4 | 6 |
| regeneration command | 6 | 4 | 6 |
| auth-scoped verifier | 6 | 4 | 6 |
| never directly edit generated output | 1 | 4 | 6 |
| preserve the web workspace | 0 | 0 | 6 |

The candidate improved the hard-to-infer generated-file boundary from **1/6 to 4/6**. That is the useful partial signal: when DeepSeek retrieved the skill and emitted a final plan, the compiled procedure influenced its decision.

It did not become a full pass because:

- the separate `policy` lesson was not compiled, so the installed skill omitted the web-workspace rule and scoped verifier;
- two relevant candidate runs retrieved the skill but ended without a parseable final plan;
- the catalog had empty `relevantPaths`, so the auth configuration skill was opened on all three documentation-only runs.

The last point is especially important. The skill catalog achieved perfect recall on this tiny sample but zero precision on the adjacent negative control. Automatic scheduling would compound this kind of over-triggering.

## Model-marked evidence

Reflection and every downstream run used:

```text
provider: OpenRouter
model: deepseek/deepseek-v4-flash
serving provider: GMICloud
reasoning: high
temperature: 0
reported quantization: unavailable
```

All nine pairs matched on material route fields. Bounded transient-provider retries were recorded: two incumbent retries and one candidate retry; none exhausted the limit.

| Phase | Input tokens | Output tokens | Provider cost |
| --- | ---: | ---: | ---: |
| Reflection | 440 | 1,606 | $0.000358 |
| Incumbent downstream | 8,096 | 6,429 | $0.002034 |
| Candidate downstream | 12,663 | 5,160 | $0.002232 |
| Total | 21,199 | 13,195 | $0.004624 |

Candidate retrieval increased input use by **56%** and provider cost by roughly **10%** relative to the incumbent task runs.

## Interpretation

This benchmark answers the immediate question: a reflection can create a real skill, the later agent can discover and read it, and the skill can alter one important behavior. But compiling only one destination from a multi-destination reflection is lossy, and an unscoped catalog entry is too eager.

Before automatic post-session reflection, the next implementation should:

1. validate and install a reflection's related skill, knowledge, runner, tool, and policy lessons as one atomic candidate rather than discarding non-skill destinations;
2. derive or require `relevantPaths`, applicability cues, and negative applicability conditions for every skill;
3. make one successful skill read sufficient and prevent repeated reads of the same immutable component in a session;
4. rerun this benchmark, then graduate to a full workspace-execution holdout with real file and process tools.

Development smoke runs and partial provider-failure records were retained but excluded from the reported series. No benchmark score was fed into reflection or used to mutate the candidate.
