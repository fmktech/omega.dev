# Evaluator repair inherits a tool-seeking runner context

## Symptom

- **Observed:** repair session `session_25c0e29a-51bc-4598-9420-de29e2d412a7` responded to a static JSON validation correction by calling `skill.read`, then seven `file.read` tools. The child had no tool capabilities, so these calls could not help.
- **Expected:** repair is a one-turn, proposal-only correction with no tool calls; a failed repair must not erase the original successful evaluator session used for retry.
- **Delta:** the repair prompt omitted the tool-free instruction, and the job replaced its evaluator session pointer before repair succeeded.

## Hypotheses

### H1: The repair objective does not restate the proposal-only boundary

- **Layer:** repair child objective.
- **Prediction:** it requests corrected JSON but never says tools are unavailable or forbidden.
- **Evidence:** inspection confirms the omission; the first two model completions requested `skill.read` and `file.read`.
- **Verdict:** **PROVEN**.

### H2: Capability attenuation would hide all tools from the model

- **Layer:** runner/model tool exposure.
- **Prediction:** the repair model request would contain no tools regardless of prompt wording.
- **Evidence:** the inherited initial runner exposes its catalog while the kernel enforces capabilities on execution; the model therefore saw and called the tools.
- **Verdict:** falsified.

### H3: A failed repair leaves the original evaluator retryable

- **Layer:** evolution persistence.
- **Prediction:** `evaluationSessionId` remains the original successful evaluator until repair completes.
- **Evidence:** the implementation updated it immediately after spawning repair; cancellation left the job pointing at a cancelled repair session.
- **Verdict:** falsified.

## 5 Whys

1. **Why did a JSON correction attempt read project files?** The model saw familiar runner tools and inferred it should inspect context.
2. **Why did it not follow proposal-only behavior?** The repair objective did not repeat the explicit no-tool rule from the initial evaluator objective.
3. **Why were calls possible to request?** Capability attenuation is enforced by the kernel, not by removing tool schemas from this inherited runner.
4. **Why did cancellation also damage retryability?** The job persisted the repair session ID before knowing repair succeeded.
5. **Why did the lifecycle test miss both?** Its fake repair child completed instantly and it asserted only the validation feedback text.

## Falsification check

If the repair objective explicitly forbade every tool and the job retained its successful evaluator pointer until repair completion, the observed tool loop and retry loss would not follow. Neither condition held.

## Resolution target

Make repair explicitly one-turn and tool-free. Persist the replacement evaluator IDs only after the repair child succeeds, preserving the original evaluator for a failed or cancelled repair.
