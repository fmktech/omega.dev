# DeepSeek fixture repair does not converge under static feedback

## Symptom

- **Observed:** the promotion evaluator and three successive static-feedback repairs all completed, but every proposal failed suite compilation. Repairs moved satisfied checks to invariants, produced empty check arrays, then reintroduced checks already true in starting files.
- **Expected:** a structured evaluator should create three compact, internally consistent fixtures or correct them from exact validation feedback within the bounded loop.
- **Delta:** the reflection proposal is usable, but no benchmark can start because the evaluator role repeatedly violates simple local fixture constraints.

## Hypotheses

### H1: DeepSeek V4 Flash is mismatched to the structured evaluator role

- **Layer:** promotion-evaluator model route.
- **Prediction:** repeated temperature-zero calls with progressively exact compiler feedback will continue making structural edits without satisfying the full constraint set.
- **Evidence:** the initial proposal plus three independent correction sessions failed on solved checks, empty checks, and solved checks again.
- **Verdict:** **PROVEN for this workload**.

### H2: The compiler is rejecting valid fixture syntax

- **Layer:** deterministic validation.
- **Prediction:** manual replay would reveal checks that are false on the baseline despite the reported error.
- **Evidence:** exact output replay confirms the cited checks are already satisfied or arrays are empty; compiler decisions are reproducible.
- **Verdict:** falsified.

### H3: More opportunity evidence is required

- **Layer:** evaluator context.
- **Prediction:** failures would be semantic omissions caused by missing project requirements.
- **Evidence:** failures are self-consistency errors between files/checks/invariants, all decidable from the evaluator's own JSON and error feedback.
- **Verdict:** falsified.

## 5 Whys

1. **Why can no paired benchmark start?** The hidden suite never passes static compilation.
2. **Why does repair not fix it?** The model edits locally around the last error and loses another required invariant.
3. **Why does exact feedback not converge?** This cheap reasoning-off route is weak at maintaining a large structured object under interacting constraints.
4. **Why keep using it for evaluation?** The initial design optimized cost before measuring role-specific reliability.
5. **Why is switching safe?** Model routes are role-specific and every benchmark stores the exact route signature, preventing cross-model comparisons.

## Falsification check

If the same deterministic compiler accepts a fixture produced by a stronger structured judge on the same opportunity, the compiler/prompt are adequate and the role-model mismatch is confirmed. If Gemini fails similarly, H1 is weakened and fixture generation needs a deterministic redesign.

## Resolution target

Route only `promotion-evaluator` through the user-approved OpenRouter `google/gemini-3-flash-preview` model at temperature zero and reasoning off. Keep DeepSeek V4 Flash for reflection/coding. Record Gemini pricing and retain exact route signatures in benchmark evidence.
