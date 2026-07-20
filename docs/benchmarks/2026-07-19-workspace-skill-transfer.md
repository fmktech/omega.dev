# Workspace skill-transfer benchmark — 2026-07-19

## Outcome

Omega produced a project-scoped skill from a prior developer conversation, retrieved it only when applicable, and improved later work in fresh isolated workspaces.

- Comparable incumbent/candidate pairs: **9/9**
- Relevant-task passes: incumbent **5/6**, candidate **6/6**
- Negative-control passes: incumbent **3/3**, candidate **3/3**
- Candidate retrieval: **6/6** relevant reads and **3/3** correct non-reads
- Capability gains/regressions: **1/0**
- Tool calls: incumbent **94**, candidate **42** (**55.3% fewer**)
- Provider cost: incumbent **12,844 μUSD**, candidate **8,596 μUSD** (**33.1% lower**)
- Machine verdict: **positive transfer**

The frozen material-efficiency thresholds were 10% lower provider cost and 20% fewer tool calls. The candidate cleared both, although capability improvement alone was sufficient for this run's positive verdict.

## What was learned

The source evidence was a completed developer exchange in which the agent initially edited generated runtime output, received correction, then learned the repository's source → regenerate → scoped-verify workflow. DeepSeek V4 Flash reflected over that immutable exchange without evaluation feedback and created one skill:

`source-and-regenerate-workflow-for-generated-config`

Its catalog metadata scopes retrieval to `config/service.toml`, `tools/render-config`, and `verify-auth`, with positive and negative applicability cues. The candidate harness is a new immutable generation whose only added component is that skill.

## Method

The benchmark used three workspace scenarios and three matched replicates:

1. Near transfer: change the authentication timeout.
2. Generalization: change the authentication lockout threshold.
3. Negative control: update authentication documentation without invoking the generated-config workflow.

Each condition received a fresh temporary repository. The agent could use typed `skill.read`, SHA-interlocked `file.read`/`file.write`, and streaming `process.start` tools. Every process ran in a fresh Docker container with no network, a read-only root filesystem, a workspace-only bind mount, tmpfs `/tmp`, 512 MiB memory, and one CPU.

The agent saw the objective and workspace, but not expected values, hidden checks, applicability expectations, or the verifier. The deterministic verifier checked final config, generated runtime output, documentation, preserved sentinel files, canonical source writes, absence of direct generated-output writes, generator execution, scoped verification, and exact skill-read behavior. Task failure was never fed back to reflection or retried. Provider-only retries were allowed and recorded; none were needed in the final run.

Both sides used the same model route and serving provider for each pair. Execution order alternated by replicate. Reflection used OpenRouter `deepseek/deepseek-v4-flash`, served by GMICloud, at temperature 0 with high reasoning.

## Pair results

| Scenario | Replicate | Incumbent | Candidate | Tools I/C | Cost μUSD I/C |
| --- | ---: | --- | --- | ---: | ---: |
| timeout | 1 | pass | pass | 14 / 5 | 1,765 / 1,054 |
| lockout | 1 | pass | pass | 19 / 5 | 2,749 / 1,151 |
| documentation | 1 | pass | pass | 3 / 3 | 458 / 540 |
| timeout | 2 | fail | pass | 12 / 5 | 1,471 / 1,039 |
| lockout | 2 | pass | pass | 12 / 6 | 1,374 / 1,258 |
| documentation | 2 | pass | pass | 3 / 3 | 467 / 518 |
| timeout | 3 | pass | pass | 14 / 7 | 2,163 / 1,537 |
| lockout | 3 | pass | pass | 14 / 5 | 1,936 / 1,111 |
| documentation | 3 | pass | pass | 3 / 3 | 461 / 388 |

## Evidence

Authoritative append-only record:

`~/.omega/benchmarks/workspace-skill-transfer/13dc814669e61859d55cbadcbe05a716be56c6136972d4839ca814381caea099.json`

The record contains the evidence digest, complete reflection proposal, route and serving-provider signatures, candidate lineage and object hashes, per-turn model usage, ordered tool traces, final workspace files, hidden scores, retries, and aggregate verdict.

Earlier records remain in the same directory. They document calibration defects and one provider-interrupted attempt rather than being silently discarded. The v4 acceptance thresholds and verdict logic were frozen before the reported samples were collected.

## What this proves

For this project family, a base model can turn a prior correction into a valid project skill and use it in later unseen workspace executions. The resulting harness was strictly better on verified outcomes, did not over-trigger on the adjacent negative task, and required materially less exploratory work.

This is evidence for the complete learning mechanism, not a universal model-quality claim. It covers one learned workflow, one repository shape, three task variants, and three replicates. Broader claims require additional project families and a final workstream holdout in which benchmark results never select intermediate mutations.
