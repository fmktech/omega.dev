# Structured evaluator exhausts output budget on reasoning

## Symptom

- **Observed:** promotion-evaluation session `session_fedf0c77-ae6c-4a62-b4d6-980cf1766b75` followed the tool-free prompt but failed after one completion with `finishReason: length`, 16,384 reasoning tokens, 16,385 output tokens, and no usable fixture JSON.
- **Expected:** the structured evaluator should emit one compact JSON object well inside its output budget.
- **Delta:** the promotion-evaluator route uses DeepSeek V4 Flash with `reasoning: high`, so hidden reasoning alone can consume the entire 16,384-token route limit.

## Hypotheses

### H1: High reasoning on the structured evaluator consumes the route output limit

- **Layer:** default model-role routing.
- **Prediction:** the persisted route is `promotion-evaluator` with high reasoning, and usage reaches the 16,384-token reasoning/output ceiling before any text result.
- **Evidence:** the live completion recorded `reasoningTokens: 16384`, `outputTokens: 16385`, `finishReason: length`, and content consisting only of reasoning parts.
- **Verdict:** **PROVEN**.

### H2: The fixture prompt itself exceeds the model context window

- **Layer:** context construction.
- **Prediction:** input usage approaches the one-million-token context limit.
- **Evidence:** input usage was only 2,832 tokens.
- **Verdict:** rejected.

### H3: The provider returned a transient empty/error completion

- **Layer:** OpenRouter/provider adapter.
- **Prediction:** completion finish reason is `error` with zero or negligible usage.
- **Evidence:** finish reason was `length` with the full output allocation consumed.
- **Verdict:** rejected.

## Root cause

The same high-reasoning route was applied to open-ended coding/reflection and to a bounded schema-generation task. The latter needs deterministic concise JSON, not an unconstrained reasoning trace.

## 5 Whys

1. **Why was no suite JSON produced?** The completion ended at the length limit before text output.
2. **Why did it reach the limit?** All 16,384 tokens were spent on reasoning.
3. **Why was reasoning so large?** The promotion-evaluator route requested high effort.
4. **Why did that route request high effort?** It copied the main-coder route profile despite a different output contract.
5. **Why did tests miss it?** Routing tests verified the main coder but did not assert a compact, reasoning-off profile for structured promotion evaluation.

## Falsification condition

This diagnosis is false if the same evaluator, routed with reasoning off, again consumes the output limit without emitting fixture JSON.
