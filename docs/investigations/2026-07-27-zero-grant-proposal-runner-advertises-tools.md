---
type: investigation
symptom: "A zero-grant evolution child spends its synthesis budget calling artifact.read instead of returning a proposal."
slug: zero-grant-proposal-runner-advertises-tools
date: 2026-07-27T09:22:00-03:00
investigator: Foad Kesheh
git_commit: fdce809a7ba7427257415839c923ed3629517f8ebr
branch: main
repository: git@github.com:fmktech/omega.dev.git
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-21-empty-synthetic-evidence-tool-loop.md
  - docs/investigations/2026-07-21-evaluator-repair-inherits-tool-seeking-context.md
---

# Zero-grant proposal runner advertises tools

## Symptom

- **Observed:** Fresh evolution job `a28dde8c-dac6-4dc0-a3b3-c872a35433b4` created proposal session `session_deba851b-fae2-4151-a7c6-34fffd82e054`. Its first two completed model turns contained only `artifact.read` calls (three calls, then one call), so the four-call synthesis budget was being consumed without a proposal.
- **Expected:** A proposal-only child with no evidence artifacts and no grants receives no model-facing tools and returns its JSON proposal directly.
- **Delta:** Kernel capability enforcement denies the calls, but the runner advertises the tool anyway, inviting an avoidable tool loop.

## Reproduction

1. Start synthetic skill evolution with no `evidenceArtifactIds` and a four-call proposal budget.
2. Inspect the proposal session header and event stream.
3. Observe zero grants plus repeated `artifact.read` model calls.

Verified 2026-07-27 against immutable session events:

```
session grants: []
sequence 5 finishReason=tool-calls tools=["artifact.read","artifact.read","artifact.read"]
sequence 8 finishReason=tool-calls tools=["artifact.read"]
```

The job was cancelled before spending the remaining model budget.

## Hypotheses

#### H1: The proposal objective tells the model to read artifacts

- **Layer:** configuration-prompt
- **Prediction:** The persisted objective contains an instruction to call `artifact.read` or omits the no-tool constraint.
- **Verification method:** Read the immutable session header.
- **Evidence:**
  ```
  "No additional evidence artifacts were supplied... Do not call artifact.read or any discovery tool."
  "This is a proposal-only child: every tool is unavailable and forbidden."
  ```
- **Verdict:** REJECTED
- **Rationale:** The objective explicitly and repeatedly prohibits the observed calls.

#### H2: Capability attenuation accidentally retained artifact or file-read authority

- **Layer:** state-data
- **Prediction:** The session header contains a read grant or a nonempty evidence context.
- **Verification method:** Inspect the session header returned by the daemon.
- **Evidence:**
  ```
  {"grants":[],"maxModelCalls":4}
  request.evidenceArtifactIds=[]
  ```
- **Verdict:** REJECTED
- **Rationale:** The child has no granted tool capability and no additional evidence artifact to read.

#### H3: The runner sends a fixed tool catalog to every model request without considering role, evidence, or capabilities

- **Layer:** code-logic
- **Prediction:** `INITIAL_RUNNER` defines one constant tool list and passes it unchanged in `model.start`; no capability or proposal-role filter exists.
- **Verification method:** Inspect `src/harness/initial-harness.ts` and compare with the production event stream.
- **Evidence:**
  ```
  const tools=${JSON.stringify(INITIAL_MODEL_TOOLS)};
  request({kind:"model.start",request:{...,messages,tools,...}}
  ```
  Production then emitted four `artifact.read` calls from a zero-grant child.
- **Verdict:** PROVEN
- **Rationale:** The model-visible affordance contradicts the enforced envelope and the objective. Kernel denial occurs only after a costly model call has already selected the unavailable tool.

## 5 Whys

Symptom: Proposal synthesis spends all calls on unavailable tools.

1. **Why?** The model selects `artifact.read` because it appears in the supplied tool catalog.
2. **Why?** The initial runner sends the same catalog for every session.
3. **Why?** Capability checks were implemented only at the kernel execution boundary.
4. **Why?** The runner treated tool presentation as a usability concern rather than part of capability attenuation and budget efficiency.
5. **Why?** The architecture lacks a single model-visible tool projection derived from role, evidence references, and the immutable capability envelope.

## Falsification

- **Check performed:** Absence-condition inspection.
- **Result:** If the fixed catalog were not the cause, a zero-grant/no-evidence session would produce `tools:[]`; the runner source has no branch capable of doing so. The adjacent evaluator child completed only because its model ignored the same affordance, showing provider behavior changes likelihood but does not remove the contradictory interface.
- **Conclusion:** H3 survives. Prompt wording and kernel denial cannot prevent wasted calls while an unavailable tool remains advertised.

## Root Cause

- **Immediate cause:** `modelRequest` passes fixed `tools` rather than a session-derived visible-tool projection.
- **Architectural root:** Enforced capabilities and model-visible capabilities are separate, allowing the model to plan actions that the kernel will necessarily reject.
- **Rejected H1:** The objective explicitly prohibits tools.
- **Rejected H2:** The child has no grants or evidence artifacts.

## Fix

- Derive model-visible tools from session role, continuation evidence, and capability grants.
- Proposal-only `evolution`/`promotion-eval` children with zero grants receive no tools; when explicit context artifacts exist, they receive only `artifact.read`.
- Add runner regression tests that inspect the first `model.start` request.

