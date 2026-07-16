import { randomUUID } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";

import type {
  ActionFacts,
  ByteCount,
  CapabilityDeniedError,
  CapabilityEnvelope,
  CreateProcessRuntime,
  DurationMs,
  EnvironmentVariables,
  ExecutionPolicy,
  IoError,
  ObjectDescriptor,
  ObjectStore,
  OmegaConfig,
  PolicyDeniedError,
  ProcessCompletion,
  ProcessError,
  ProcessHandle,
  ProcessId,
  ProcessObservation,
  ProcessSpec,
  ProcessState,
  ProcessStream,
  ProcessSupervisor,
  ProjectRepository,
  Result,
  SessionRepository,
  StreamSlice,
  Timestamp,
} from "../contracts/index.js";
import { createFileService } from "./file-service.js";
import {
  detectSandboxBackend,
  type SandboxBackend,
  type SandboxChild,
} from "./sandbox-backend.js";

type ProcessRuntimeDependencies = {
  readonly config: OmegaConfig["processes"];
  readonly environment: EnvironmentVariables;
  readonly projects: ProjectRepository;
  readonly sessions: SessionRepository;
  readonly objects: ObjectStore;
  readonly policy: ExecutionPolicy;
  readonly backend?: SandboxBackend;
};

type ActiveProcess = {
  readonly handle: ProcessHandle;
  readonly spec: ProcessSpec;
  readonly capabilities: CapabilityEnvelope;
  readonly child: SandboxChild;
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
  readonly completion: Promise<Result<ProcessCompletion, ProcessError>>;
  state: ProcessState;
  desiredTerminalState: "cancelled" | "interrupted" | null;
  timeout: NodeJS.Timeout | null;
};

type CompletedProcess = {
  readonly state: ProcessState;
  readonly result: Result<ProcessCompletion, ProcessError>;
};

const MAX_COMPLETED_PROCESSES = 256;

function timestamp(): Timestamp {
  return new Date().toISOString() as Timestamp;
}

function duration(value: number): DurationMs {
  return Math.max(0, Math.floor(value)) as DurationMs;
}

function bytes(value: number): ByteCount {
  return Math.max(0, value) as ByteCount;
}

function denied(capability: CapabilityDeniedError["capability"], reason: string): CapabilityDeniedError {
  return { kind: "capability-denied", capability, reason, recoverable: true, callerAction: "request-new-child" };
}

function policyDenied(reason: string, ruleId: string): PolicyDeniedError {
  return { kind: "policy-denied", reason, ruleId, recoverable: false, callerAction: "abort" };
}

function notRunning(processId: ProcessId, state: ProcessState): ProcessError {
  return { kind: "process-not-running", processId, state, recoverable: false, callerAction: "propagate" };
}

function ioError(operation: string): IoError {
  return { kind: "io-error", operation, code: null, recoverable: true, callerAction: "retry-with-backoff" };
}

function shutdownDeadlineError(): IoError {
  return { kind: "io-error", operation: "process.shutdown-deadline", code: "ETIMEDOUT", recoverable: false, callerAction: "abort" };
}

function hasCapability(capabilities: CapabilityEnvelope, kind: "process-input"): boolean {
  return capabilities.grants.some((grant) => grant.kind === kind);
}

function hasWholeWorkspaceFileGrant(
  capabilities: CapabilityEnvelope,
  kind: "read-files" | "write-files",
): boolean {
  return capabilities.grants.some((grant) => {
    if (grant.kind !== kind || (grant.kind !== "read-files" && grant.kind !== "write-files")) return false;
    return grant.pathPrefixes.some((prefix) => String(prefix) === ".");
  });
}

function validateStartCapabilities(spec: ProcessSpec, capabilities: CapabilityEnvelope): ProcessError | null {
  const processGrant = capabilities.grants.find((grant) => grant.kind === "start-process");
  if (processGrant === undefined) return denied("start-process", "The session cannot start processes");
  if (processGrant.executableNames.length > 0 && !processGrant.executableNames.includes(spec.executable)) {
    return denied("start-process", `Executable ${spec.executable} is outside the capability envelope`);
  }
  if (!hasWholeWorkspaceFileGrant(capabilities, "read-files")) {
    return denied("read-files", "A sandboxed process requires whole-workspace read authority");
  }
  if (spec.sandbox.filesystem === "workspace-read-write") {
    if (!hasWholeWorkspaceFileGrant(capabilities, "write-files")) {
      return denied("write-files", "A writable sandbox requires whole-workspace write authority");
    }
  }
  if (spec.sandbox.network !== "none") {
    const networkGrant = capabilities.grants.find((grant) => grant.kind === "network-egress");
    if (networkGrant === undefined) return denied("network-egress", "The session cannot use network egress");
    if (
      spec.sandbox.network === "allowlist" &&
      spec.sandbox.allowedHosts.some((host) => !networkGrant.allowedHosts.includes(host))
    ) {
      return denied("network-egress", "The requested host allowlist exceeds the capability envelope");
    }
  }
  if (spec.credentialEnvNames.length > 0) {
    const credentialGrant = capabilities.grants.find((grant) => grant.kind === "inject-credential");
    if (credentialGrant === undefined) return denied("inject-credential", "The session cannot inject credentials");
    if (spec.credentialEnvNames.some((name) => !credentialGrant.credentialEnvNames.includes(name))) {
      return denied("inject-credential", "A requested credential exceeds the capability envelope");
    }
  }
  return null;
}

function processFacts(spec: ProcessSpec): ActionFacts {
  return {
    kind: "process",
    executable: spec.executable,
    args: [...spec.args],
    cwd: spec.cwd,
    credentialEnvNames: [...spec.credentialEnvNames],
    sandbox: { ...spec.sandbox, allowedHosts: [...spec.sandbox.allowedHosts], runtime: { ...spec.sandbox.runtime } },
  };
}

function pathIsWithin(root: string, target: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(target)) return false;
  const fromRoot = relative(root, target);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

async function putOutput(objects: ObjectStore, chunks: readonly Buffer[]): Promise<Result<ObjectDescriptor, ProcessError>> {
  async function* output(): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) yield chunk;
  }
  const result = await objects.put("application/octet-stream", output());
  return result.ok ? result : { ok: false, error: ioError("object-store.put-process-output") };
}

function encodeStreamSlice(stream: ProcessStream, data: Buffer, offset: number): StreamSlice {
  const text = data.toString("utf8");
  const roundTrips = Buffer.from(text, "utf8").equals(data);
  return {
    stream,
    range: { startInclusive: bytes(offset), endExclusive: bytes(offset + data.byteLength) },
    encoding: roundTrips ? "utf8" : "base64",
    data: roundTrips ? text : data.toString("base64"),
  };
}

function streamSlice(
  stream: ProcessStream,
  source: readonly Buffer[],
  offset: number,
  limit: number,
): StreamSlice | null {
  const start = Math.max(0, offset);
  const end = start + Math.max(1, limit);
  let cursor = 0;
  const selected: Buffer[] = [];
  for (const chunk of source) {
    const chunkEnd = cursor + chunk.byteLength;
    if (chunkEnd > start && cursor < end) {
      selected.push(chunk.subarray(Math.max(0, start - cursor), Math.min(chunk.byteLength, end - cursor)));
    }
    cursor = chunkEnd;
    if (cursor >= end) break;
  }
  return selected.length === 0 ? null : encodeStreamSlice(stream, Buffer.concat(selected), start);
}

async function storedStreamSlice(
  objects: ObjectStore,
  stream: ProcessStream,
  descriptor: ObjectDescriptor,
  offset: number,
  limit: number,
): Promise<Result<StreamSlice | null, ProcessError>> {
  const start = Math.max(0, offset);
  if (start >= Number(descriptor.size)) return { ok: true, value: null };
  const end = Math.min(Number(descriptor.size), start + Math.max(1, limit));
  const opened = await objects.get(descriptor.hash);
  if (!opened.ok) return { ok: false, error: ioError("object-store.get-process-output") };
  let cursor = 0;
  const selected: Buffer[] = [];
  for await (const chunkValue of opened.value) {
    const chunk = Buffer.from(chunkValue);
    const chunkEnd = cursor + chunk.byteLength;
    if (chunkEnd > start && cursor < end) {
      selected.push(chunk.subarray(Math.max(0, start - cursor), Math.min(chunk.byteLength, end - cursor)));
    }
    cursor = chunkEnd;
    if (cursor >= end) break;
  }
  return {
    ok: true,
    value: selected.length === 0 ? null : encodeStreamSlice(stream, Buffer.concat(selected), start),
  };
}

export function createProcessSupervisor(options: ProcessRuntimeDependencies): ProcessSupervisor {
  const active = new Map<ProcessId, ActiveProcess>();
  const completed = new Map<ProcessId, CompletedProcess>();
  const startsBySession = new Map<string, number>();
  const backendPromise = options.backend === undefined
    ? detectSandboxBackend(options.config, options.environment)
    : Promise.resolve({ ok: true as const, value: options.backend });

  function rememberCompletion(processId: ProcessId, value: CompletedProcess): void {
    completed.delete(processId);
    completed.set(processId, value);
    while (completed.size > MAX_COMPLETED_PROCESSES) {
      const oldest = completed.keys().next().value as ProcessId | undefined;
      if (oldest === undefined) break;
      completed.delete(oldest);
    }
  }

  async function authorize(
    sessionId: ProcessSpec["sessionId"],
    capabilities: CapabilityEnvelope,
    facts: ActionFacts,
  ): Promise<ProcessError | null> {
    const session = await options.sessions.get(sessionId);
    if (!session.ok) return ioError("session.get-for-process-policy");
    const evaluation = await options.policy.evaluate({
      sessionId,
      facts,
      capabilityEnvelope: capabilities,
      profile: session.value.header.policyProfile,
    });
    if (!evaluation.ok) return policyDenied("Execution policy could not evaluate the action", "policy-evaluation-failed");
    if (evaluation.value.outcome === "allow") return null;
    if (evaluation.value.outcome === "deny") return policyDenied(evaluation.value.reason, evaluation.value.ruleId);
    const resolution = await waitForPolicyResolution(
      options.policy,
      evaluation.value.escalationId,
      Date.parse(String(capabilities.createdAt)) + Number(capabilities.wallTimeMs),
    );
    return resolution === "allow"
      ? null
      : policyDenied(evaluation.value.reason, String(evaluation.value.escalationId));
  }

  function attachCompletion(record: Omit<ActiveProcess, "completion">): Promise<Result<ProcessCompletion, ProcessError>> {
    return new Promise((resolve) => {
      const startedAt = Date.parse(String(record.handle.startedAt));
      const finish = async (exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> => {
        if (record.timeout !== null) clearTimeout(record.timeout);
        const state = record.desiredTerminalState ?? "exited";
        record.state = state;
        const stdout = await putOutput(options.objects, record.stdout);
        const stderr = stdout.ok ? await putOutput(options.objects, record.stderr) : stdout;
        const result: Result<ProcessCompletion, ProcessError> = !stdout.ok
          ? stdout
          : !stderr.ok
            ? stderr
            : { ok: true, value: {
            processId: record.handle.id,
            state,
            exitCode,
            signal,
            durationMs: duration(Date.now() - startedAt),
            stdout: stdout.value,
            stderr: stderr.value,
          } };
        record.stdout.length = 0;
        record.stderr.length = 0;
        active.delete(record.handle.id);
        rememberCompletion(record.handle.id, { state, result });
        resolve(result);
      };
      record.child.process.once("exit", (code, signal) => { void finish(code, signal); });
      record.child.process.once("error", () => {
        record.desiredTerminalState = "interrupted";
      });
    });
  }

  return {
    async start(spec, capabilities) {
      if (active.size >= options.config.maxConcurrent) {
        return { ok: false, error: { kind: "budget-exceeded", budget: "processes", limit: options.config.maxConcurrent, observed: active.size + 1, recoverable: false, callerAction: "abort" } };
      }
      const elapsed = Date.now() - Date.parse(String(capabilities.createdAt));
      if (!Number.isFinite(elapsed) || elapsed > Number(capabilities.wallTimeMs)) {
        return { ok: false, error: { kind: "budget-exceeded", budget: "wall-time", limit: Number(capabilities.wallTimeMs), observed: elapsed, recoverable: false, callerAction: "abort" } };
      }
      const previousStarts = startsBySession.get(String(spec.sessionId)) ?? 0;
      if (previousStarts >= capabilities.maxProcessStarts) {
        return { ok: false, error: { kind: "budget-exceeded", budget: "processes", limit: capabilities.maxProcessStarts, observed: previousStarts + 1, recoverable: false, callerAction: "abort" } };
      }
      const capabilityError = validateStartCapabilities(spec, capabilities);
      if (capabilityError !== null) return { ok: false, error: capabilityError };
      for (const name of spec.credentialEnvNames) {
        if (options.environment[String(name)] === undefined) {
          return { ok: false, error: { kind: "validation", field: "credentialEnvNames", message: `Credential ${String(name)} is not available`, recoverable: true, callerAction: "fix-request" } };
        }
      }
      const session = await options.sessions.get(spec.sessionId);
      if (!session.ok) return { ok: false, error: ioError("session.get-for-process-start") };
      const workspace = await options.projects.getWorkspace(session.value.header.workspaceId);
      if (!workspace.ok) return { ok: false, error: ioError("workspace.get-for-process-start") };
      if (!pathIsWithin(String(workspace.value.path), String(spec.cwd))) {
        return {
          ok: false,
          error: {
            kind: "validation",
            field: "cwd",
            message: "Working directory must remain inside the session workspace",
            recoverable: true,
            callerAction: "fix-request",
          },
        };
      }
      const policyError = await authorize(spec.sessionId, capabilities, processFacts(spec));
      if (policyError !== null) return { ok: false, error: policyError };
      const backend = await backendPromise;
      if (!backend.ok) return backend;
      const processId = randomUUID() as ProcessId;
      const launched = await backend.value.launch({ processId, spec, workspacePath: workspace.value.path });
      if (!launched.ok) return launched;
      const handle: ProcessHandle = {
        id: processId,
        state: "running",
        harnessId: spec.harnessId,
        sandbox: launched.value.identity,
        startedAt: timestamp(),
      };
      const partial: Omit<ActiveProcess, "completion"> = {
        handle,
        spec,
        capabilities,
        child: launched.value,
        stdout: [],
        stderr: [],
        state: "running",
        desiredTerminalState: null,
        timeout: null,
      };
      launched.value.process.stdout?.on("data", (chunk: Buffer) => partial.stdout.push(Buffer.from(chunk)));
      launched.value.process.stderr?.on("data", (chunk: Buffer) => partial.stderr.push(Buffer.from(chunk)));
      const completion = attachCompletion(partial);
      const record = Object.assign(partial, { completion }) as ActiveProcess;
      if (spec.timeoutMs !== null) {
        record.timeout = setTimeout(() => {
          record.desiredTerminalState = "cancelled";
          void record.child.signal("SIGTERM");
          setTimeout(() => { if (active.has(processId)) void record.child.signal("SIGKILL"); }, Number(options.config.gracefulShutdownMs));
        }, Number(spec.timeoutMs));
      }
      active.set(processId, record);
      startsBySession.set(String(spec.sessionId), previousStarts + 1);
      return { ok: true, value: handle };
    },

    async observe(processId, after) {
      const record = active.get(processId);
      const remembered = completed.get(processId);
      if (record === undefined && remembered === undefined) return { ok: false, error: notRunning(processId, "interrupted") };
      const slices: StreamSlice[] = [];
      for (const stream of ["stdout", "stderr"] as const) {
        const offset = Number(after.find((entry) => entry.stream === stream)?.offset ?? 0);
        if (record !== undefined) {
          const slice = streamSlice(stream, record[stream], offset, Number(options.config.liveChunkBytes));
          if (slice !== null) slices.push(slice);
          continue;
        }
        if (remembered === undefined) return { ok: false, error: notRunning(processId, "interrupted") };
        if (!remembered.result.ok) return { ok: false, error: remembered.result.error };
        const slice = await storedStreamSlice(
          options.objects,
          stream,
          remembered.result.value[stream],
          offset,
          Number(options.config.liveChunkBytes),
        );
        if (!slice.ok) return slice;
        if (slice.value !== null) slices.push(slice.value);
      }
      return { ok: true, value: { processId, state: record?.state ?? remembered?.state ?? "interrupted", slices, observedAt: timestamp() } satisfies ProcessObservation };
    },

    async input(processId, input) {
      const record = active.get(processId);
      if (record === undefined) return { ok: false, error: notRunning(processId, completed.get(processId)?.state ?? "interrupted") };
      if (!hasCapability(record.capabilities, "process-input")) return { ok: false, error: denied("process-input", "The session cannot control process input") };
      const facts: ActionFacts = { kind: "process-input", processId, input: { ...input } };
      const policyError = await authorize(record.spec.sessionId, record.capabilities, facts);
      if (policyError !== null) return { ok: false, error: policyError };
      if (input.kind === "close-stdin") {
        record.child.closeStdin();
        return { ok: true, value: { acceptedBytes: bytes(0) } };
      }
      if (input.kind === "signal") {
        const signalled = await record.child.signal(input.signal);
        return signalled.ok ? { ok: true, value: { acceptedBytes: bytes(0) } } : signalled;
      }
      const data = input.encoding === "utf8" ? Buffer.from(input.data, "utf8") : Buffer.from(input.data, "base64");
      if (input.encoding === "base64" && data.toString("base64") !== input.data.replaceAll(/\s/gu, "")) {
        return { ok: false, error: { kind: "validation", field: "input.data", message: "Invalid base64 process input", recoverable: true, callerAction: "fix-request" } };
      }
      record.child.write(data);
      return { ok: true, value: { acceptedBytes: bytes(data.byteLength) } };
    },

    async cancel(processId) {
      const record = active.get(processId);
      if (record === undefined) {
        const remembered = completed.get(processId);
        return remembered?.result ?? { ok: false, error: notRunning(processId, "interrupted") };
      }
      if (record.state !== "running") return record.completion;
      record.desiredTerminalState = "cancelled";
      const signal = await record.child.signal("SIGTERM");
      if (!signal.ok) return signal;
      setTimeout(() => { if (active.has(processId)) void record.child.signal("SIGKILL"); }, Number(options.config.gracefulShutdownMs));
      return record.completion;
    },

    async listActive(sessionId) {
      return { ok: true, value: [...active.values()].filter((record) => record.spec.sessionId === sessionId).map((record) => record.handle) };
    },

    async recoverOrphans() {
      const backend = await backendPromise;
      return backend.ok ? backend.value.recoverOrphans() : backend;
    },

    async shutdown(deadline) {
      const records = [...active.values()];
      for (const record of records) {
        record.desiredTerminalState = "interrupted";
        void record.child.signal("SIGTERM");
      }
      const remaining = Math.max(0, Date.parse(String(deadline)) - Date.now());
      const settled = Promise.all(records.map((record) => record.completion));
      const finishedBeforeDeadline = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), remaining);
        void settled.then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!finishedBeforeDeadline) {
        for (const record of records) if (active.has(record.handle.id)) void record.child.signal("SIGKILL");
        return { ok: false, error: shutdownDeadlineError() };
      }
      const results = await settled;
      const failed = results.find((result) => !result.ok);
      return failed !== undefined && !failed.ok
        ? failed
        : { ok: true, value: results.flatMap((result) => result.ok ? [result.value] : []) };
    },
  };
}

async function waitForPolicyResolution(
  policy: ProcessRuntimeDependencies["policy"],
  escalationId: Parameters<ProcessRuntimeDependencies["policy"]["getEscalation"]>[0],
  deadline: number,
): Promise<"allow" | "deny"> {
  while (Date.now() < deadline) {
    const current = await policy.getEscalation(escalationId);
    if (current.ok && current.value.state === "resolved") return current.value.resolution ?? "deny";
    if (!current.ok && current.error.kind !== "not-found") return "deny";
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return "deny";
}

export const createProcessRuntime: CreateProcessRuntime = (options) => ({
  processes: createProcessSupervisor(options),
  files: createFileService(options),
});
