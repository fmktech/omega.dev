# Synthetic task execution uses the fixture-judge model

## Symptom

- **Observed:** the first compiled suite ran its SWE task with `google/gemini-3-flash-preview`, produced no tool calls across 12 model turns, and failed verification. Gemini was selected only to author/repair structured hidden fixtures; the project coder remains DeepSeek V4 Flash.
- **Expected:** fixture generation uses `promotion-evaluator`; incumbent and candidate task execution use the same `main-coder` route. Promotion math remains deterministic and model-marked.
- **Delta:** `runSkillPaired` resolves `promotion-evaluator` and passes that route to every task launcher.

## Hypotheses

### H1: Synthetic paired execution hardcodes the promotion-evaluator route

- **Layer:** benchmark service.
- **Prediction:** persisted `BenchmarkRun.route.role` is `promotion-evaluator`, even though the task session performs code changes.
- **Evidence:** run `e8a82fcc-f1e6-4540-98dc-10d0b53fc297` records role `promotion-evaluator`, Gemini model, 12 turns, zero tool calls.
- **Verdict:** **PROVEN**.

### H2: The candidate runner overrides the requested route

- **Layer:** runner model selection.
- **Prediction:** only candidate runs would select an unexpected model.
- **Evidence:** the incumbent run already records the Gemini evaluator route supplied by `runSkillPaired`; both harnesses receive the same wrong route.
- **Verdict:** falsified.

### H3: Promotion comparison requires task execution on the evaluator role

- **Layer:** scorecard governance.
- **Prediction:** pairing or evaluator authority depends on `route.role === promotion-evaluator`.
- **Evidence:** pairing requires identical route signatures; promotion authority is the incumbent harness ID, not a model role. The coding route can be main-coder for both arms.
- **Verdict:** falsified.

## 5 Whys

1. **Why did a valid fixture fail without file tools?** The task was sent to a structured judge route rather than the coding route.
2. **Why was Gemini executing code?** `runSkillPaired` resolves `promotion-evaluator` for launcher requests.
3. **Why was that unnoticed with DeepSeek?** Both roles previously shared the same model ID, hiding the distinction while still differing in reasoning settings.
4. **Why did switching the judge expose it?** Role-specific models made the accidental coupling visible in persisted evidence.
5. **Why did tests miss it?** Synthetic pairing tests verify equal routes and skill-read gates, but never assert the semantic role used for task work.

## Falsification check

If paired task launcher requests already carry the configured `main-coder` signature, H1 is false. The production run and source both show `promotion-evaluator`.

## Resolution target

Use `main-coder` for every incumbent/candidate synthetic task. Keep `promotion-evaluator` exclusively for hidden fixture synthesis/repair. Assert the role and model in paired benchmark tests; exact route signatures continue marking every run.
