# Empty synthetic evidence causes evaluator tool loops

## Symptom

- **Observed:** synthetic evolution job `9ea6034b-28f6-4fa5-ae1d-27bfe447a77f` supplied `evidenceArtifactIds: []`, yet its evaluation child repeatedly called unavailable `knowledge.catalog`/inspection tools and did not emit fixture JSON.
- **Expected:** with no explicit evidence artifacts, the evaluator must use the opportunity text already in its objective and immediately return the three-fixture JSON.
- **Delta:** the objective says both “Read the supplied evidence artifacts” and “Evidence artifact IDs: none,” leaving a tool-seeking model to resolve a nonexistent evidence source.

## Hypotheses

### H1: The unconditional artifact-read instruction triggers discovery attempts when the evidence list is empty

- **Layer:** synthetic evaluation prompt construction.
- **Prediction:** the persisted objective contains an `artifact.read` instruction alongside `Evidence artifact IDs: none`, and completed model turns end in unrelated tool calls.
- **Evidence:** the live evaluation session contains exactly that contradictory prompt and successive `model.completed` events ending in `knowledge.catalog` tool calls.
- **Verdict:** **PROVEN**.

### H2: The evaluator received one or more malformed evidence IDs that artifact.read rejected

- **Layer:** CLI argument parsing/evolution request persistence.
- **Prediction:** the stored evolution request has a non-empty `evidenceArtifactIds` array.
- **Evidence:** the stored request and `evolution.get` response both contain `evidenceArtifactIds: []`.
- **Verdict:** rejected.

### H3: OpenRouter returned empty/error completions and the runner invented recovery calls

- **Layer:** model-provider adapter.
- **Prediction:** persisted completions have `finishReason: error` or no content.
- **Evidence:** persisted completions have `finishReason: tool-calls`, substantial reasoning, and explicit catalog calls.
- **Verdict:** rejected.

## Root cause

`skillEvalObjective` always instructs the evaluator to call `artifact.read`, even when the request contains no artifact IDs. It does not explicitly prohibit all tool calls in that case. The evaluator is intentionally isolated from workspace and candidate state, so its attempts cannot succeed and create a bounded but wasteful loop.

## 5 Whys

1. **Why did the evaluator not return fixtures?** It repeatedly requested tools.
2. **Why did it request tools?** The prompt told it to read supplied evidence before answering.
3. **Why was there nothing to read?** The completed source session was the reflection provenance and no additional evidence artifacts were supplied.
4. **Why did the prompt not adapt?** Evidence instructions were static rather than conditional on `evidenceArtifactIds.length`.
5. **Why did tests miss this?** Lifecycle tests asserted isolation and child creation, but never asserted the empty-evidence objective was self-contained and tool-free.

## Falsification condition

This diagnosis is false if, after making the empty-evidence objective explicitly tool-free and removing its artifact-read instruction, the same model still issues tool calls instead of returning fixture JSON.
