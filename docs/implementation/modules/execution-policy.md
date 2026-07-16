# Module: execution-policy

## Owns

`src/policy/action-facts.ts`, `policy-engine.ts`, `escalation-store.ts`, and `execution-policy.test.ts`.

## Implements

Implement `ExecutionPolicy`. Derive action facts from the actual command, sandbox, paths, credential names, and marketplace/harness operation. Deterministic capability and hard-policy checks retain authority; the `fast-policy` model classifies only permitted ambiguity. Deny and escalate are `PolicyDecision` values. Escalations persist and resolve exactly once.

## Edge cases and gates

Test every autonomy profile, model timeout/failure fail-closed behavior, egress host mismatch, undeclared credential, path scope escape, duplicate resolution, resolution after cancellation, prompt injection in repository content, and redaction of command diagnostics at client boundaries.

