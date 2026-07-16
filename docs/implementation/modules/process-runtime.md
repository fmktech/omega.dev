# Module: process-runtime

## Owns

`src/process/sandbox-backend.ts`, `process-supervisor.ts`, `file-service.ts`, and `process-runtime.test.ts`.

## Implements

Implement `ProcessSupervisor` and `FileService`. Each invocation gets its own Docker/Podman-supervised process, live stdin/stdout/stderr, byte-range sidecars, process-group cancellation, enforceable `SandboxSpec`, credential-name injection, and policy/capability checks. File writes use read SHA compare-and-swap and never silently overwrite stale content.

Export `createProcessRuntime` with the exact dependencies and result in `docs/implementation/runtime-contract.md`; backend-unavailable and image-unavailable paths return typed `UnsupportedError` values.

## Edge cases and gates

Test output backpressure, split UTF-8 sequences, base64 binary output, close-stdin, signals, timeout, cancel races, orphan verification, backend unavailable, offline/allowlist egress, filesystem read-only mounts, stale writes, symlink/path traversal, and daemon restart interruption.
