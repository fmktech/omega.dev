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
  "context.bootstrap", "skill.read", "model.start", "process.start", "process.observe", "process.input", "process.cancel", "artifact.read", "file.read",
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
  stderrTail: string;
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
        stderrTail: "",
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
        state.stderrTail = `${state.stderrTail}${bytes.toString("utf8")}`.slice(-2_048);
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
      const detail = state.stderrTail.trim();
      state.received.push(protocolEnvelope(detail.length === 0
        ? "Runner terminated before ready handshake"
        : `Runner terminated before ready handshake: ${detail}`));
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
  const command = runtime === "node" ? "node" : runtime === "python" ? "python3" : runtime === "bash" ? "bash" : entrypoint;
  const args = runtime === "native" ? [] : inline === null ? [entrypoint] : ["--input-type=module", "--eval", inline];
  const writable = start.session.capabilityEnvelope.grants.some((grant) =>
    grant.kind === "write-files" && grant.pathPrefixes.some((prefix) => String(prefix) === "."));
  return {
    executable: command,
    args,
    cwd: start.workspace.path,
    credentialEnvNames,
    stdin: "pipe",
    timeoutMs: null,
    sandbox: {
      filesystem: writable ? "workspace-read-write" : "workspace-read-only",
      network: "none",
      allowedHosts: [],
      memoryLimitBytes: (512 * 1024 * 1024) as ByteCount,
      cpuTimeLimitMs: 1_800_000 as DurationMs,
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
  if (message["kind"] === "runner.ready" && isId(message["harnessId"])) {
    return { ok: true, value: value as RunnerToKernelEnvelope };
  }
  if (message["kind"] === "runner.request" && isRunnerRequest(message["request"])) {
    return { ok: true, value: value as RunnerToKernelEnvelope };
  }
  if (message["kind"] === "runner.protocol-error" && isProtocolErrorValue(message["error"])) {
    return { ok: true, value: value as RunnerToKernelEnvelope };
  }
  return protocol("Runner envelope message has an invalid discriminator or shape");
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const MODEL_ROLES = new Set(["main-coder", "fast-policy", "harness-mutator", "promotion-evaluator", "diagnostician", "crystallizer"]);
const CAPABILITY_KINDS = new Set([
  "model-call", "read-files", "write-files", "start-process", "process-input", "network-egress", "inject-credential",
  "spawn-child", "write-knowledge", "install-marketplace", "publish-marketplace", "manage-marketplace",
  "create-harness-candidate", "run-promotion-eval", "activate-harness",
]);
const COMPONENT_KINDS = new Set(["runner", "tool", "connector", "skill", "workflow", "context-compiler", "promotion-evaluator", "policy-prompt"]);
const MARKETPLACE_KINDS = new Set(["harness", "tool", "connector", "skill", "workflow", "component-delta"]);
const MARKETPLACE_STATES = new Set(["experimental", "proven", "deprecated"]);

function isRunnerRequest(value: JsonValue | undefined): value is RunnerRequest {
  if (!isObject(value) || typeof value["kind"] !== "string" || !REQUEST_KINDS.has(value["kind"]) || !isId(value["requestId"])) return false;
  switch (value["kind"]) {
    case "context.bootstrap":
      return true;
    case "skill.read":
      return isId(value["harnessId"]) && isId(value["componentId"]);
    case "model.start":
      return isModelRequest(value["request"]);
    case "process.start":
      return isProcessSpec(value["spec"]);
    case "process.observe":
      return isId(value["processId"]) && isArray(value["after"], (cursor) => isObject(cursor)
        && (cursor["stream"] === "stdout" || cursor["stream"] === "stderr") && isNonNegativeInteger(cursor["offset"]));
    case "process.input":
      return isId(value["processId"]) && isProcessInput(value["input"]);
    case "process.cancel":
      return isId(value["processId"]) && typeof value["reason"] === "string";
    case "artifact.read":
      return isId(value["artifactId"]) && isNonNegativeInteger(value["offset"]) && isPositiveInteger(value["limit"]);
    case "file.read":
      return isId(value["workspaceId"]) && isNonEmptyString(value["path"]);
    case "file.write":
      return isFileWriteRequest(value["request"]);
    case "child.spawn":
      return isSpawnChildRequest(value["request"]);
    case "child.observe":
      return isId(value["sessionId"]);
    case "knowledge.catalog":
      return isKnowledgeQuery(value["query"]);
    case "knowledge.read":
      return isId(value["documentId"]);
    case "knowledge.write":
      return isKnowledgeWriteRequest(value["request"]);
    case "marketplace.search":
      return isMarketplaceQuery(value["query"]);
    case "marketplace.install":
      return isId(value["artifactId"]);
    case "harness.evolve":
      return isEvolutionRequest(value["request"]);
    case "harness.status":
      return isId(value["projectId"]);
    case "evolution.observe":
      return isId(value["jobId"]);
    case "evolution.cancel":
      return isId(value["jobId"]) && typeof value["reason"] === "string";
    case "session.complete":
      return value["outcome"] === "succeeded" || value["outcome"] === "failed" || value["outcome"] === "cancelled";
    default:
      return false;
  }
}

function isModelRequest(value: JsonValue | undefined): boolean {
  return isObject(value)
    && isId(value["sessionId"])
    && isId(value["harnessId"])
    && typeof value["role"] === "string"
    && MODEL_ROLES.has(value["role"])
    && isArray(value["messages"], isModelMessage)
    && isArray(value["tools"], isToolSchema)
    && isPositiveInteger(value["maxOutputTokens"])
    && isPositiveInteger(value["abortAfterMs"]);
}

function isModelMessage(value: JsonValue): boolean {
  if (!isObject(value) || !Array.isArray(value["content"])) return false;
  if (value["role"] === "system" || value["role"] === "user") {
    return value["content"].every((part) => isTextPart(part) || isToolResultPart(part));
  }
  if (value["role"] === "assistant") return value["content"].every(isModelContentPart);
  if (value["role"] === "tool") return value["content"].every(isToolResultPart);
  return false;
}

function isModelContentPart(value: JsonValue): boolean {
  return isTextPart(value) || isReasoningPart(value) || isToolCallPart(value) || isToolResultPart(value);
}

function isTextPart(value: JsonValue): boolean {
  return isObject(value) && value["kind"] === "text" && typeof value["text"] === "string";
}

function isReasoningPart(value: JsonValue): boolean {
  return isObject(value) && value["kind"] === "reasoning" && typeof value["text"] === "string";
}

function isToolCallPart(value: JsonValue): boolean {
  return isObject(value) && value["kind"] === "tool-call" && isNonEmptyString(value["callId"])
    && isNonEmptyString(value["toolName"]) && isObject(value["input"]);
}

function isToolResultPart(value: JsonValue): boolean {
  return isObject(value) && value["kind"] === "tool-result" && isNonEmptyString(value["callId"])
    && isNonEmptyString(value["toolName"]) && Object.hasOwn(value, "result") && typeof value["isError"] === "boolean";
}

function isToolSchema(value: JsonValue): boolean {
  return isObject(value) && isNonEmptyString(value["name"]) && typeof value["description"] === "string" && isObject(value["inputSchema"]);
}

function isProcessSpec(value: JsonValue | undefined): boolean {
  if (!isObject(value) || !isNonEmptyString(value["executable"]) || !isArray(value["args"], isString)
    || !isNonEmptyString(value["cwd"]) || !isArray(value["credentialEnvNames"], isNonEmptyString)
    || (value["stdin"] !== "closed" && value["stdin"] !== "pipe")
    || (value["timeoutMs"] !== null && !isPositiveInteger(value["timeoutMs"]))
    || !isId(value["harnessId"]) || !isId(value["sessionId"]) || !isObject(value["sandbox"])) return false;
  const sandbox = value["sandbox"];
  if ((sandbox["filesystem"] !== "workspace-read-only" && sandbox["filesystem"] !== "workspace-read-write")
    || (sandbox["network"] !== "none" && sandbox["network"] !== "allowlist" && sandbox["network"] !== "unrestricted")
    || !isArray(sandbox["allowedHosts"], isNonEmptyString) || !isPositiveInteger(sandbox["memoryLimitBytes"])
    || !isPositiveInteger(sandbox["cpuTimeLimitMs"]) || !isObject(sandbox["runtime"])) return false;
  const runtime = sandbox["runtime"];
  return runtime["kind"] === "oci" && isNonEmptyString(runtime["image"])
    && (runtime["expectedImageDigest"] === null || isSha256(runtime["expectedImageDigest"]))
    && isNonEmptyString(runtime["containerUser"]) && isNonEmptyString(runtime["workspaceMountPath"]);
}

function isProcessInput(value: JsonValue | undefined): boolean {
  if (!isObject(value)) return false;
  if (value["kind"] === "close-stdin") return true;
  if (value["kind"] === "signal") return value["signal"] === "SIGINT" || value["signal"] === "SIGTERM" || value["signal"] === "SIGHUP";
  return value["kind"] === "data" && (value["encoding"] === "utf8" || value["encoding"] === "base64") && typeof value["data"] === "string";
}

function isFileWriteRequest(value: JsonValue | undefined): boolean {
  return isObject(value) && isId(value["sessionId"]) && isId(value["workspaceId"]) && isNonEmptyString(value["path"])
    && (value["expectedSha"] === null || isSha256(value["expectedSha"])) && typeof value["content"] === "string";
}

function isSpawnChildRequest(value: JsonValue | undefined): boolean {
  return isObject(value) && isId(value["parentSessionId"])
    && (value["role"] === "task" || value["role"] === "evolution" || value["role"] === "promotion-eval"
      || value["role"] === "diagnostician" || value["role"] === "crystallizer")
    && isNonEmptyString(value["objective"]) && isArray(value["contextArtifactIds"], isId)
    && isCapabilityEnvelope(value["capabilityEnvelope"]);
}

function isCapabilityEnvelope(value: JsonValue | undefined): boolean {
  return isObject(value) && isArray(value["grants"], isCapabilityGrant) && isArray(value["modelRoles"], isModelRole)
    && isNonNegativeInteger(value["maxCostUsdMicros"]) && isNonNegativeInteger(value["maxModelCalls"])
    && isNonNegativeInteger(value["maxProcessStarts"]) && isNonNegativeInteger(value["maxInputTokens"])
    && isNonNegativeInteger(value["maxOutputTokens"]) && isPositiveInteger(value["wallTimeMs"])
    && isNonEmptyString(value["createdAt"]);
}

function isCapabilityGrant(value: JsonValue): boolean {
  if (!isObject(value) || typeof value["kind"] !== "string" || !CAPABILITY_KINDS.has(value["kind"])) return false;
  if (value["kind"] === "read-files" || value["kind"] === "write-files") return isArray(value["pathPrefixes"], isNonEmptyString);
  if (value["kind"] === "start-process") return isArray(value["executableNames"], isNonEmptyString);
  if (value["kind"] === "network-egress") return isArray(value["allowedHosts"], isNonEmptyString);
  if (value["kind"] === "inject-credential") return isArray(value["credentialEnvNames"], isNonEmptyString);
  return true;
}

function isKnowledgeQuery(value: JsonValue | undefined): boolean {
  return isObject(value) && isId(value["projectId"]) && typeof value["text"] === "string"
    && isArray(value["tags"], isString) && isArray(value["relevantPaths"], isNonEmptyString) && isPositiveInteger(value["limit"]);
}

function isKnowledgeWriteRequest(value: JsonValue | undefined): boolean {
  if (!isObject(value) || !isId(value["projectId"]) || !isObject(value["document"])
    || (value["expectedSha"] !== null && !isSha256(value["expectedSha"]))) return false;
  const document = value["document"];
  return isId(document["projectId"]) && typeof document["markdown"] === "string" && isKnowledgeFrontmatter(document["frontmatter"]);
}

function isKnowledgeFrontmatter(value: JsonValue | undefined): boolean {
  return isObject(value) && isId(value["id"]) && isNonEmptyString(value["title"]) && typeof value["summary"] === "string"
    && isArray(value["tags"], isString) && isFiniteNumber(value["confidence"]) && isNonEmptyString(value["verifiedAt"])
    && isArray(value["sourceSessionIds"], isId) && isArray(value["sourceArtifactIds"], isId)
    && isArray(value["relevantPaths"], isNonEmptyString) && isArray(value["invalidationConditions"], isString);
}

function isMarketplaceQuery(value: JsonValue | undefined): boolean {
  return isObject(value) && typeof value["text"] === "string"
    && isArray(value["kinds"], (kind) => typeof kind === "string" && MARKETPLACE_KINDS.has(kind))
    && isArray(value["states"], (state) => typeof state === "string" && MARKETPLACE_STATES.has(state))
    && isPositiveInteger(value["limit"]);
}

function isEvolutionRequest(value: JsonValue | undefined): boolean {
  if (!isObject(value) || !isId(value["projectId"]) || !isId(value["sourceSessionId"]) || !isNonEmptyString(value["goal"])
    || !isArray(value["evidenceArtifactIds"], isId)
    || !isArray(value["allowedComponentKinds"], (kind) => typeof kind === "string" && COMPONENT_KINDS.has(kind))
    || !isObject(value["budget"])
    || (value["evaluationMode"] !== undefined && value["evaluationMode"] !== "development-suite"
      && value["evaluationMode"] !== "synthetic-skill-suite")) return false;
  const budget = value["budget"];
  return isPositiveInteger(budget["wallTimeMs"]) && isNonNegativeInteger(budget["maxModelCalls"])
    && isNonNegativeInteger(budget["maxInputTokens"]) && isNonNegativeInteger(budget["maxOutputTokens"])
    && isNonNegativeInteger(budget["maxCostUsdMicros"]) && isNonNegativeInteger(budget["maxProcessStarts"]);
}

function isArray(value: JsonValue | undefined, predicate: (item: JsonValue) => boolean): boolean {
  return Array.isArray(value) && value.every(predicate);
}

function isString(value: JsonValue): boolean {
  return typeof value === "string";
}

function isNonEmptyString(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isId(value: JsonValue | undefined): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isSha256(value: JsonValue | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isNonNegativeInteger(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: JsonValue | undefined): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isFiniteNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isModelRole(value: JsonValue): boolean {
  return typeof value === "string" && MODEL_ROLES.has(value);
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
