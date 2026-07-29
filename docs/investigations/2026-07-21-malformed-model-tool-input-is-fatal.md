# Malformed model tool input is fatal

## Observed failure

In production session `session_ddc52e6f-b550-40a3-b8a8-4260b4ea6393`, the model completed its workspace verification and then called `knowledge.write` with a plausible but contract-incompatible document. No tool result was returned. The session immediately recorded `session.completed: failed`.

## Hypotheses

1. **The knowledge service rejected a valid request and the runner incorrectly treated an ordinary tool error as fatal.** This predicts a valid `knowledge.write` runner request and a `knowledge.written` reply before termination.
2. **The runner emitted a request that failed the JSONL transport decoder, which converted model argument drift into a fatal protocol error.** This predicts no dispatched `knowledge.write` event and a request shape missing kernel-required fields.
3. **The runner process crashed independently after verification.** This predicts stderr or a process failure unrelated to the final model tool call.

## Evidence and conclusion

Hypothesis 2 is proven. The final model completion supplied `document: {sha,tags,path,summary}`. The built-in tool schema describes `document` only as an unconstrained object, while the kernel requires `document.projectId`, `markdown`, and complete frontmatter. The runner adds only the outer `projectId`, so even a model following the advertised shape cannot infer every transport-owned field. `parseRunnerEnvelope` rejects the request before dispatch, and the dispatcher treats every runner protocol error as terminal. There is no `knowledge.updated` or `knowledge.written` event. Hypothesis 1 is falsified because the service was never called. Hypothesis 3 is falsified by the termination's direct adjacency to the malformed request and absence of an independent process error.

## Five whys

1. Why did a successful workspace session fail? Its final knowledge-capture call terminated the runner protocol.
2. Why was the call a protocol violation? The emitted request did not match `KnowledgeWriteRequest`.
3. Why did the model produce that shape? The advertised model tool schema left the document unconstrained and exposed no usable contract.
4. Why did the runner not repair transport-owned fields? It injected the outer project ID but not the document project ID or current-session provenance.
5. Why was malformed model input fatal? The runner host did not distinguish a well-framed request with invalid arguments from corrupted runner transport.

## Fix and falsification test

Advertise the complete model-facing knowledge schema, inject project/session provenance in the built-in runner, and make a well-framed request with invalid arguments receive `request.rejected` instead of becoming a terminal protocol error. Keep malformed JSON and invalid envelopes fatal. A regression test will emit a malformed known request, assert a rejection is written back, and then prove the host still accepts the next valid request.
