# Initial runner rejects new-file writes encoded as `"null"`

## Symptom

- **Observed:** In the completed synthetic skill-foundry evaluation, all 18 runs failed verification. The best candidate near-transfer run loaded the skill and proposed a complete implementation, but the final workspace still contained only the seed `README.md` and `package.json` files.
- **Expected:** Model-issued `file.write` calls for new paths should reach the file service with `expectedSha: null`, create the files, and become visible to the hidden verifier.
- **Delta:** The model emitted `expectedSha: "null"` for new files. The immutable runner forwarded that string unchanged, and the runner protocol rejected the request before the file service could execute it.

## Hypotheses

### H1 — The hidden verifier rejects otherwise-correct generated files

- **Layer:** benchmark verification
- **Prediction:** The session log contains accepted file writes and the final workspace snapshot lists generated source files, but one or more hidden checks fail.
- **Evidence:** The representative session has no file-write events, and its final workspace snapshot contains only the two seed files.
- **Verdict:** REJECTED

### H2 — The launcher loses successful workspace writes before snapshotting

- **Layer:** benchmark workspace lifecycle
- **Prediction:** Accepted file-write requests appear in the session trace, while the final snapshot omits their paths.
- **Evidence:** The trace contains five model completions and one skill load but no accepted file-write operation. The model-response artifacts show that writes were proposed but never accepted by the runner protocol.
- **Verdict:** REJECTED

### H3 — The initial runner fails to normalize the model's string form of JSON null

- **Layer:** harness runner / runner-protocol boundary
- **Prediction:** Model-response artifacts contain `file.write` calls with `expectedSha: "null"`; the embedded runner forwards that value; protocol validation accepts only a SHA-256 string or JSON null.
- **Evidence:** Session `session_56da0b80-a670-4847-82aa-856504e0b948` contains generated writes for `src/domain/product.js` and other new files with `expectedSha: "null"`. `INITIAL_RUNNER.toolRequest` forwards `input.expectedSha` unchanged. `isFileWriteRequest` accepts only `null` or a 64-character SHA-256 value.
- **Verdict:** PROVEN

## Root cause — five whys

1. Why did the candidate not improve benchmark success? Because its generated implementation never reached the workspace.
2. Why did the implementation never reach the workspace? Because every new-file `file.write` request was rejected at the runner-protocol boundary.
3. Why was each request rejected? Because `expectedSha` was the string `"null"`, not JSON null or a SHA-256 value.
4. Why did that representation reach the protocol boundary? Because the model produced a common recoverable encoding mistake and the embedded runner forwarded it without canonicalization.
5. Why did repeated turns not recover? Because the tool error did not teach the model the representation distinction strongly enough, while the same unchanged mapper retried every subsequent write.

## Fix

The initial runner will canonicalize the exact string `"null"` to JSON null for `file.write.expectedSha` and `knowledge.write.expectedSha`, while preserving every other string for strict SHA validation. Tool descriptions will explicitly say “JSON null, never the string `null`.” Existing-file safety is unchanged: normalizing to null still causes the file service's optimistic-concurrency check to reject a write when the target already exists.

## Falsification condition

This diagnosis is false if an executable runner test proves that a model tool call containing `expectedSha: "null"` does not become a runner request containing `expectedSha: null`, or if a fresh live benchmark run still proposes new-file writes but records no created files for a different reason.

