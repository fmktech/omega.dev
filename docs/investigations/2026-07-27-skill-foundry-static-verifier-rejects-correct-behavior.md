---
type: investigation
symptom: "A retrieved storage-contract skill produced the requested behavior but scored 0/3 in the near-transfer promotion gate."
slug: skill-foundry-static-verifier-rejects-correct-behavior
date: 2026-07-27T09:03:54-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8ebr
branch: main
repository: git@github.com:fmktech/omega.dev.git
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-21-evolution-handoff-and-static-verifier.md
  - docs/benchmarks/2026-07-21-storage-app-real-replay.md
---

# Skill Foundry static verifier rejects correct behavior

## Symptom

- **User report:** "I think something is wrong in your implementation loop until you make this work"
- **Observed:** Candidate harness `harness_162787b5d61aee4eeb4cc9c213bcb8e518d277270883a02b6101c0d144d88f17` retrieved its learned skill and completed the task, but all three near-transfer benchmark replicates failed their hidden verifier.
- **Expected:** A candidate that applies the requested observable contracts should pass independently of equivalent implementation syntax.
- **Delta:** The candidate's final JavaScript passes a direct behavioral probe, while the promotion verifier reports failure because three source substrings and one byte-exact source file differ.

## Reproduction

1. Inspect persisted benchmark run `66563837-b693-4d62-b314-985b292fd6b7` and its private report artifact `artifact_cd8b983c-853e-4094-ad2f-b62c0cb44a06`.
2. Replay the exact `file.write` contents from session `session_15830f59-7ef5-4523-9d5b-90f1cca04970` in memory and execute assertions for raw location return, trimmed lot filtering, conflict throwing, exact 404 shape, and usable 413 JSON.
3. Compare the behavioral result with the persisted verifier diagnostics.

Verified 2026-07-27: the reproduction is deterministic against immutable session and artifact records.

```
behavioral contract: PASS
["src/storage.js","src/api.js"]
```

Persisted private report:

```
{"outcome":"failed","verifierPassed":false,"negativeInvariantsPassed":true,"verifierDiagnostics":[{"index":0,"path":"src/storage.js","passed":false,"operator":"contains","expected":"throw new Error('CONFLICT')","actual":"present"},{"index":1,"path":"src/storage.js","passed":true,"operator":"contains","expected":"return loc;","actual":"present"},{"index":2,"path":"src/storage.js","passed":false,"operator":"contains","expected":"filter.locationId.trim()","actual":"present"},{"index":3,"path":"src/storage.js","passed":true,"operator":"notContains","expected":"return { ok: true","actual":"present"},{"index":4,"path":"src/api.js","passed":false,"operator":"equals","expected":"export function handleNotFound() {\n  return { status: 404, body: { \"error\": \"Not found\" } };\n}\n\nexport function handleLargeRequest() {\n  return { status: 413, body: { \"error\": \"Payload Too Large\" } };\n}","actual":"present"}]}
```

## Hypotheses

#### H1: The candidate failed because the learned skill was unavailable or was not retrieved

- **Layer:** state-data
- **Prediction:** If H1 is true, the candidate session has no `skill.loaded` event and its transcript does not reason from the learned contracts.
- **Verification method:** Inspect the immutable session event stream.
- **Evidence:**
  ```
  sequence 3: {"kind":"skill.loaded","componentId":"component_0380722cc615287c0944cfa576de459bd2f731307a646dc203f764f6e643cc79"}
  final reasoning: "Let me verify the changes against the contract ledger"
  benchmark metrics: "skillReads":1
  ```
- **Verdict:** REJECTED
- **Rationale:** The skill was loaded exactly once before the first model request, and the model explicitly audited its edits against the ledger.

#### H2: The candidate failed because its implementation did not satisfy the observable storage contracts

- **Layer:** code-logic
- **Prediction:** If H2 is true, executing the final written modules will fail at least one behavioral assertion for conflict throwing, raw return values, trimming, or HTTP response shapes.
- **Verification method:** Extract the exact `file.write` payloads from the immutable event stream, import them from data URLs, and execute the five assertions.
- **Evidence:**
  ```
  behavioral contract: PASS
  ["src/storage.js","src/api.js"]
  ```
- **Verdict:** REJECTED
- **Rationale:** The exact candidate output satisfies all behavior the public objective requests. It differs from the hidden oracle only in implementation syntax and in an unspecified 413 message string.

#### H3: The synthetic verifier mistakes source spelling for observable behavior

- **Layer:** test-observation
- **Prediction:** If H3 is true, behaviorally correct code can fail the verifier, and behaviorally wrong code containing the expected literals can pass it.
- **Verification method:** Compare the direct behavioral replay with the private report, then construct an in-memory module that places every required storage literal in comments while implementing incorrect behavior.
- **Evidence:**
  ```
  exact candidate: behavioral contract: PASS
  exact candidate: verifierPassed=false

  adversarial counterexample:
  static verifier: PASS
  behavioral contract: FAIL
  ```
- **Verdict:** PROVEN
- **Rationale:** The verifier is both incomplete and unsound: it rejects an equivalent correct implementation and accepts comments paired with incorrect functions. `runChecks` compares only bytes (`equals`, `contains`, `notContains`, `absent`) and never executes the requested contract.

## 5 Whys

Symptom: The candidate scored 0/3 despite applying the learned behavior.

1. **Why?** The hidden verifier demanded exact source fragments rather than executing the public contract.
2. **Why?** Skill Foundry stores evaluator-generated `checks` as static file predicates and the generic benchmark launcher only interprets those predicates.
3. **Why?** The private fixture schema has no executable verifier files or command, so the evaluator can express behavior only as source text approximations.
4. **Why?** The first implementation optimized for tiny, language-agnostic fixtures and treated static checks as sufficient for capability evaluation.
5. **Why?** The promotion architecture did not mechanically separate cheap structural validation from authoritative behavioral validation; a proxy oracle was allowed to make the promotion decision.

## Falsification

- **Check performed:** Adjacent-cause search plus an adversarial counterexample.
- **Result:** The skill was loaded and the exact candidate passed direct behavioral assertions, eliminating retrieval and implementation failure. Conversely, an intentionally broken storage module with the required literals only in comments passed every static storage check while failing the conflict behavior.
- **Conclusion:** H3 survives falsification. Provider variance cannot explain a deterministic disagreement between the same immutable output and the two verifier methods.

## Root Cause

- **Immediate cause:** `src/app/omega-app.ts` evaluates Skill Foundry output using byte-only `runChecks`; the persisted verifier required `throw new Error('CONFLICT')`, `filter.locationId.trim()`, and a byte-exact `src/api.js` even though those spellings were not public contracts.
- **Architectural root:** The Skill Foundry private task schema lacks an executable behavioral verifier, allowing static proxy predicates to act as the authoritative capability gate.
- **Rejected H1:** Session sequence 3 and the benchmark metric prove exactly one successful skill load.
- **Rejected H2:** Direct execution of the exact written modules passes all five public behavioral assertions.
- **Falsification survived:** A deliberately wrong module passes the static predicates, proving the oracle defect independently of the candidate implementation.

## Fix

- Extend synthetic skill fixtures with private, bounded executable verifier files and an offline verification command.
- Run the verifier after the task in the isolated workspace; keep its files and command hidden from the task-solving session.
- Preserve static invariants for safety and negative controls, but do not let source substrings establish positive capability.
- Add regression tests proving equivalent implementations pass and comment-only implementations fail.

