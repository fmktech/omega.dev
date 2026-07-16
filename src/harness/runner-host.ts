import type {
  AbsolutePath,
  ByteCount,
  CreateRunnerHost,
  DurationMs,
  HarnessError,
  HarnessId,
  HarnessVersionMismatchError,
  JsonObject,
  JsonValue,
  KernelToRunnerEnvelope,
  ProcessError,
  ProcessHandle,
  ProcessObservation,
  ProcessSpec,
  ProcessSupervisor,
  ProtocolError,
  RequestId,
  Result,
  RunnerRequest,
  RunnerStart,
  RunnerToKernelEnvelope,
  SessionId,
} from "../contracts/index.js";
import { encodeJsonLine } from "../shared/core.js";

const PROTOCOL = "omega-runner-jsonl";
const VERSION = 1;
const MAX_LINE_BYTES = 1024 * 1024;
const READY_POLLS = 100;
const READY_POLL_DELAY_MS = 10;
const REQUEST_KINDS: ReadonlySet<string> = new Set([
  "model.start", "process.start", "process.observe", "process.input", "process.cancel", "artifact.read", "file.read",
  "file.write", "child.spawn", "child.observe", "knowledge.catalog", "knowledge.read", "knowledge.write",
  "marketplace.search", "marketplace.install", "harness.evolve", "harness.status", "evolution.observe",
  "evolution.cancel", "session.complete",
]);

type RunnerState = {
  readonly start: RunnerStart;
  readonly handle: ProcessHandle;
  currentHarnessId: HarnessId;
  stdoutOffset: ByteCount;
  stderrOffset: ByteCount;
  inputBuffer: Buffer;
  readonly received: RunnerToKernelEnvelope[];
  readonly pendingRequests: Set<RequestId>;
  readonly deferredUpdates: KernelToRunnerEnvelope[];
  ready: boolean;
  terminal: boolean;
};

export const createRunnerHost: CreateRunnerHost = (processes, harnesses) => {
  const states = new Map<SessionId, RunnerState>();

  return {
    async start(start) {
      if (states.has(start.session.id)) {
        return conflict("runner-session", "not-started", start.session.id);
      }
      if (start.harness.id !== start.session.initialHarnessId || start.workspace.id !== start.session.workspaceId
        || start.harness.projectId !== start.session.projectId || start.workspace.projectId !== start.session.projectId) {
        return validation("Runner start session, workspace, project, and harness identities must agree", "start");
      }
      const storedHarness = await harnesses.getHarness(start.harness.id);
      if (!storedHarness.ok) {
        return storedHarness;
      }
      const runner = storedHarness.value.components.find((component) => component.kind === "runner");
      if (runner === undefined || storedHarness.value.components.filter((component) => component.kind === "runner").length !== 1) {
        return validation("Harness must contain exactly one runner component", "harness.components");
      }
      if (runner.runtime === "document") {
        return validation("Runner component cannot use the document runtime", "harness.components.runner.runtime");
      }
      const spec = runnerProcessSpec(start, runner.runtime, runner.entrypoint, runner.credentialEnvNames);
      const launched = await processes.start(spec, start.session.capabilityEnvelope);
      if (!launched.ok) {
        return launched;
      }
      const state: RunnerState = {
        start,
        handle: launched.value,
        currentHarnessId: start.harness.id,
        stdoutOffset: 0 as ByteCount,
        stderrOffset: 0 as ByteCount,
        inputBuffer: Buffer.alloc(0),
        received: [],
        pendingRequests: new Set(),
        deferredUpdates: [],
        ready: false,
        terminal: false,
      };
      states.set(start.session.id, state);
      const started = await writeEnvelope(processes, state, {
        protocol: PROTOCOL,
        version: VERSION,
        message: { kind: "kernel.start", start },
      });
      if (!started.ok) {
        states.delete(start.session.id);
        await processes.cancel(launched.value.id, "runner start envelope failed");
        return started;
      }
      for (let attempt = 0; attempt < READY_POLLS; attempt += 1) {
        const observed = await poll(processes, state);
        if (!observed.ok) {
          states.delete(start.session.id);
          await processes.cancel(launched.value.id, "runner handshake observation failed");
          return observed;
        }
        if (state.ready) {
          return { ok: true, value: launched.value };
        }
        const protocolFailure = state.received.find((envelope) => envelope.message.kind === "runner.protocol-error");
        if (protocolFailure?.message.kind === "runner.protocol-error") {
          states.delete(start.session.id);
          await processes.cancel(launched.value.id, "runner handshake protocol failure");
          return { ok: false, error: protocolFailure.message.error };
        }
        if (state.terminal) {
          states.delete(start.session.id);
          return protocol("Runner exited before completing the ready handshake");
        }
        await delay(READY_POLL_DELAY_MS);
      }
      states.delete(start.session.id);
      await processes.cancel(launched.value.id, "runner ready handshake timed out");
      return protocol("Runner did not complete the ready handshake");
    },

    async send(sessionId, envelope) {
      const state = states.get(sessionId);
      if (state === undefined) {
        return notFound("runner-session", sessionId);
      }
      const valid = validateKernelEnvelope(envelope);
      if (!valid.ok) {
        return valid;
      }
      if (envelope.message.kind === "kernel.start") {
        return protocol("kernel.start may only be sent by RunnerHost.start");
      }
      if (envelope.message.kind === "kernel.event" && envelope.message.event.kind === "harness.updated") {
        const update = envelope.message.event.update;
        if (update.projectId !== state.start.session.projectId || update.previousHarnessId !== state.currentHarnessId) {
          return mismatch(state.currentHarnessId, update.previousHarnessId);
        }
        const next = await harnesses.getHarness(update.activeHarnessId);
        if (!next.ok) {
          return next;
        }
        if (next.value.projectId !== state.start.session.projectId) {
          return validation("A runner cannot adopt another project's harness", "event.update.activeHarnessId");
        }
        if (state.pendingRequests.size > 0) {
          state.deferredUpdates.push(envelope);
          return { ok: true, value: undefined };
        }
        const sent = await writeEnvelope(processes, state, envelope);
        if (sent.ok) {
          state.currentHarnessId = update.activeHarnessId;
        }
        return sent;
      }
      const sent = await writeEnvelope(processes, state, envelope);
      if (!sent.ok) {
        return sent;
      }
      if (envelope.message.kind === "kernel.reply") {
        state.pendingRequests.delete(envelope.message.reply.requestId);
        const flushed = await flushDeferredUpdates(processes, state);
        if (!flushed.ok) {
          return flushed;
        }
      }
      return { ok: true, value: undefined };
    },

    async *receive(sessionId) {
      const state = states.get(sessionId);
      if (state === undefined) {
        return;
      }
      while (true) {
        while (state.received.length > 0) {
          const envelope = state.received.shift();
          if (envelope !== undefined) {
            yield envelope;
          }
        }
        if (state.terminal) {
          return;
        }
        const observed = await poll(processes, state);
        if (!observed.ok) {
          state.received.push(protocolEnvelope(`Runner observation failed: ${observed.error.kind}`));
          state.terminal = true;
        } else if (!state.terminal && state.received.length === 0) {
          await delay(READY_POLL_DELAY_MS);
        }
      }
    },

    async stop(sessionId, reason) {
      const state = states.get(sessionId);
      if (state === undefined) {
        return notFound("runner-session", sessionId);
      }
      await poll(processes, state);
      finishPartialLine(state);
      const completion = await processes.cancel(state.handle.id, reason);
      states.delete(sessionId);
      return completion;
    },
  };
};

async function poll(processes: ProcessSupervisor, state: RunnerState): Promise<Result<ProcessObservation, ProcessError | HarnessError>> {
  const observed = await processes.observe(state.handle.id, [
    { stream: "stdout", offset: state.stdoutOffset },
    { stream: "stderr", offset: state.stderrOffset },
  ]);
  if (!observed.ok) {
    return observed;
  }
  for (const slice of observed.value.slices) {
    const bytes = Buffer.from(slice.data, slice.encoding === "base64" ? "base64" : "utf8");
    const declaredLength = slice.range.endExclusive - slice.range.startInclusive;
    if (declaredLength !== bytes.byteLength) {
      state.received.push(protocolEnvelope(`Runner ${slice.stream} slice byte range does not match its payload`));
      continue;
    }
    if (slice.stream === "stderr") {
      if (slice.range.startInclusive === state.stderrOffset) {
        state.stderrOffset = slice.range.endExclusive;
      }
      continue;
    }
    if (slice.range.startInclusive !== state.stdoutOffset) {
      state.received.push(protocolEnvelope("Runner stdout stream contains a gap or overlapping slice"));
      continue;
    }
    state.stdoutOffset = slice.range.endExclusive;
    acceptBytes(state, bytes, processes);
  }
  if (observed.value.state !== "starting" && observed.value.state !== "running") {
    state.terminal = true;
    finishPartialLine(state);
    if (!state.ready) {
      state.received.push(protocolEnvelope("Runner terminated before ready handshake"));
    }
  }
  return observed;
}

function acceptBytes(state: RunnerState, bytes: Buffer, processes: ProcessSupervisor): void {
  state.inputBuffer = Buffer.concat([state.inputBuffer, bytes]);
  while (true) {
    const newline = state.inputBuffer.indexOf(0x0a);
    if (newline < 0) {
      if (state.inputBuffer.byteLength > MAX_LINE_BYTES) {
        state.received.push(protocolEnvelope("Runner JSONL line exceeds the 1 MiB limit"));
        state.inputBuffer = Buffer.alloc(0);
      }
      return;
    }
    const line = state.inputBuffer.subarray(0, newline);
    state.inputBuffer = state.inputBuffer.subarray(newline + 1);
    if (line.byteLength > MAX_LINE_BYTES) {
      state.received.push(protocolEnvelope("Runner JSONL line exceeds the 1 MiB limit"));
      continue;
    }
    acceptLine(state, line.toString("utf8"), processes);
  }
}

function acceptLine(state: RunnerState, line: string, processes: ProcessSupervisor): void {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(line) as JsonValue;
  } catch {
    state.received.push(protocolEnvelope("Runner stdout contains malformed JSONL"));
    return;
  }
  const envelope = parseRunnerEnvelope(parsed);
  if (!envelope.ok) {
    state.received.push(protocolEnvelope(envelope.error.message));
    return;
  }
  if (envelope.value.message.kind === "runner.ready") {
    if (state.ready) {
      state.received.push(protocolEnvelope("Runner sent runner.ready more than once"));
      return;
    }
    if (envelope.value.message.harnessId !== state.currentHarnessId) {
      state.received.push(protocolEnvelope("Runner ready handshake named the wrong harness"));
      return;
    }
    state.ready = true;
    state.received.push(envelope.value);
    return;
  }
  if (!state.ready) {
    state.received.push(protocolEnvelope("Runner sent a message before runner.ready"));
    return;
  }
  if (envelope.value.message.kind === "runner.request") {
    const request = envelope.value.message.request;
    const requestedHarness = requestHarnessId(request);
    if (requestedHarness !== null && requestedHarness !== state.currentHarnessId) {
      const rejection: KernelToRunnerEnvelope = {
        protocol: PROTOCOL,
        version: VERSION,
        message: {
          kind: "kernel.reply",
          reply: { kind: "request.rejected", requestId: request.requestId, error: mismatchError(requestedHarness, state.currentHarnessId) },
        },
      };
      void writeEnvelope(processes, state, rejection);
      return;
    }
    if (state.pendingRequests.has(request.requestId)) {
      state.received.push(protocolEnvelope("Runner reused a pending request id"));
      return;
    }
    state.pendingRequests.add(request.requestId);
  }
  state.received.push(envelope.value);
}

function requestHarnessId(request: RunnerRequest): HarnessId | null {
  if (request.kind === "model.start") {
    return request.request.harnessId;
  }
  if (request.kind === "process.start") {
    return request.spec.harnessId;
  }
  return null;
}

async function flushDeferredUpdates(processes: ProcessSupervisor, state: RunnerState): Promise<Result<void, HarnessError | ProcessError>> {
  if (state.pendingRequests.size > 0) {
    return { ok: true, value: undefined };
  }
  while (state.deferredUpdates.length > 0) {
    const envelope = state.deferredUpdates.shift();
    if (envelope === undefined || envelope.message.kind !== "kernel.event" || envelope.message.event.kind !== "harness.updated") {
      continue;
    }
    const sent = await writeEnvelope(processes, state, envelope);
    if (!sent.ok) {
      return sent;
    }
    state.currentHarnessId = envelope.message.event.update.activeHarnessId;
  }
  return { ok: true, value: undefined };
}

async function writeEnvelope(
  processes: ProcessSupervisor,
  state: RunnerState,
  envelope: KernelToRunnerEnvelope,
): Promise<Result<void, HarnessError | ProcessError>> {
  const valid = validateKernelEnvelope(envelope);
  if (!valid.ok) {
    return valid;
  }
  const accepted = await processes.input(state.handle.id, { kind: "data", encoding: "utf8", data: encodeJsonLine(envelope) });
  return accepted.ok ? { ok: true, value: undefined } : accepted;
}

function runnerProcessSpec(
  start: RunnerStart,
  runtime: "node" | "python" | "bash" | "native",
  entrypoint: string,
  credentialEnvNames: ProcessSpec["credentialEnvNames"],
): ProcessSpec {
  const inline = entrypoint.startsWith("inline-base64:") ? Buffer.from(entrypoint.slice("inline-base64:".length), "base64").toString("utf8") : null;
  const command = runtime === "node" ? process.execPath : runtime === "python" ? "python3" : runtime === "bash" ? "bash" : entrypoint;
  const args = runtime === "native" ? [] : inline === null ? [entrypoint] : ["--input-type=module", "--eval", inline];
  return {
    executable: command,
    args,
    cwd: start.workspace.path,
    credentialEnvNames,
    stdin: "pipe",
    timeoutMs: null,
    sandbox: {
      filesystem: "workspace-read-write",
      network: "none",
      allowedHosts: [],
      memoryLimitBytes: (512 * 1024 * 1024) as ByteCount,
      cpuTimeLimitMs: 3_600_000 as DurationMs,
      runtime: {
        kind: "oci",
        image: "omega-runner:local",
        expectedImageDigest: null,
        containerUser: "1000:1000",
        workspaceMountPath: "/workspace" as AbsolutePath,
      },
    },
    harnessId: start.harness.id,
    sessionId: start.session.id,
  };
}

function parseRunnerEnvelope(value: JsonValue): Result<RunnerToKernelEnvelope, ProtocolError> {
  if (!isObject(value) || value["protocol"] !== PROTOCOL || value["version"] !== VERSION || !isObject(value["message"])) {
    return protocol("Runner envelope has an unsupported protocol, version, or shape");
  }
  const message = value["message"];
  if (message["kind"] === "runner.ready" && typeof message["harnessId"] === "string") {
    return { ok: true, value: value as RunnerToKernelEnvelope };
  }
  if (message["kind"] === "runner.request" && isObject(message["request"])
    && typeof message["request"]["kind"] === "string" && REQUEST_KINDS.has(message["request"]["kind"])
    && typeof message["request"]["requestId"] === "string"
    && hasRequestHarnessShape(message["request"])) {
    return { ok: true, value: value as RunnerToKernelEnvelope };
  }
  if (message["kind"] === "runner.protocol-error" && isProtocolErrorValue(message["error"])) {
    return { ok: true, value: value as RunnerToKernelEnvelope };
  }
  return protocol("Runner envelope message has an invalid discriminator or shape");
}

function hasRequestHarnessShape(request: JsonObject): boolean {
  if (request["kind"] === "model.start") {
    return isObject(request["request"]) && typeof request["request"]["harnessId"] === "string";
  }
  if (request["kind"] === "process.start") {
    return isObject(request["spec"]) && typeof request["spec"]["harnessId"] === "string";
  }
  return true;
}

function validateKernelEnvelope(envelope: KernelToRunnerEnvelope): Result<void, HarnessError> {
  if (envelope.protocol !== PROTOCOL || envelope.version !== VERSION
    || !["kernel.start", "kernel.reply", "kernel.event"].includes(envelope.message.kind)) {
    return protocol("Kernel envelope has an unsupported protocol, version, or message");
  }
  return { ok: true, value: undefined };
}

function isProtocolErrorValue(value: JsonValue | undefined): boolean {
  return isObject(value) && value["kind"] === "protocol-error" && value["protocol"] === "runner-jsonl"
    && typeof value["message"] === "string" && value["recoverable"] === false && value["callerAction"] === "abort";
}

function finishPartialLine(state: RunnerState): void {
  if (state.inputBuffer.byteLength > 0) {
    state.received.push(protocolEnvelope("Runner stdout ended with a partial JSONL line"));
    state.inputBuffer = Buffer.alloc(0);
  }
}

function protocolEnvelope(message: string): RunnerToKernelEnvelope {
  return { protocol: PROTOCOL, version: VERSION, message: { kind: "runner.protocol-error", error: protocolError(message) } };
}

function protocolError(message: string): ProtocolError {
  return { kind: "protocol-error", protocol: "runner-jsonl", message, recoverable: false, callerAction: "abort" };
}

function mismatchError(expected: HarnessId, active: HarnessId): HarnessVersionMismatchError {
  return { kind: "harness-version-mismatch", expected, active, recoverable: true, callerAction: "refresh-version-and-retry" };
}

function mismatch(expected: HarnessId, active: HarnessId): Result<never, HarnessError> {
  return { ok: false, error: mismatchError(expected, active) };
}

function protocol(message: string): Result<never, ProtocolError> {
  return { ok: false, error: protocolError(message) };
}

function validation(message: string, field: string | null): Result<never, HarnessError> {
  return { ok: false, error: { kind: "validation", message, field, recoverable: true, callerAction: "fix-request" } };
}

function conflict(resource: string, expected: string, actual: string): Result<never, HarnessError> {
  return { ok: false, error: { kind: "conflict", resource, expected, actual, recoverable: true, callerAction: "refresh-version-and-retry" } };
}

function notFound(resource: string, id: string): Result<never, HarnessError> {
  return { ok: false, error: { kind: "not-found", resource, id, recoverable: false, callerAction: "propagate" } };
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
