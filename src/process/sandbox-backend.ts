import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

import type {
  AbsolutePath,
  EnvironmentVariables,
  IoError,
  OmegaConfig,
  ProcessError,
  ProcessId,
  ProcessSpec,
  Result,
  SandboxRuntimeIdentity,
  Sha256,
  UnsupportedError,
} from "../contracts/index.js";

const execFileAsync = promisify(execFile);
const MANAGED_LABEL = "dev.omega.managed=true";
const PROCESS_LABEL = "dev.omega.process-id";

export type SandboxLaunch = {
  readonly processId: ProcessId;
  readonly spec: ProcessSpec;
  readonly workspacePath: AbsolutePath;
};

export interface SandboxChild {
  readonly process: ChildProcess;
  readonly identity: SandboxRuntimeIdentity;
  write(data: Uint8Array): boolean;
  closeStdin(): void;
  signal(signal: "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGKILL"): Promise<Result<void, IoError>>;
}

export interface SandboxBackend {
  launch(request: SandboxLaunch): Promise<Result<SandboxChild, ProcessError>>;
  recoverOrphans(): Promise<Result<readonly ProcessId[], ProcessError>>;
}

type BackendName = SandboxRuntimeIdentity["backend"];

function unsupported(feature: string): UnsupportedError {
  return { kind: "unsupported", feature, recoverable: false, callerAction: "propagate" };
}

function ioError(operation: string, error: NodeJS.ErrnoException): IoError {
  return {
    kind: "io-error",
    operation,
    code: error.code ?? null,
    recoverable: true,
    callerAction: "retry-with-backoff",
  };
}

function errorFrom(value: object): NodeJS.ErrnoException {
  return value instanceof Error ? value : new Error("OCI backend operation failed");
}

function digestFromInspect(output: string): Sha256 | null {
  const match = /(?:sha256:)?([0-9a-f]{64})/u.exec(output.trim());
  return match === null ? null : (match[1] as Sha256);
}

function validHost(host: string): boolean {
  return host.length > 0 && host.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(host);
}

class OciSandboxBackend implements SandboxBackend {
  public constructor(
    private readonly backend: BackendName,
    private readonly version: string,
    private readonly environment: EnvironmentVariables,
  ) {}

  public async launch(request: SandboxLaunch): Promise<Result<SandboxChild, ProcessError>> {
    const { spec } = request;
    if (spec.sandbox.runtime.kind !== "oci") {
      return { ok: false, error: unsupported(`sandbox runtime ${spec.sandbox.runtime.kind}`) };
    }
    if (spec.sandbox.network !== "allowlist" && spec.sandbox.allowedHosts.length > 0) {
      return { ok: false, error: validation("sandbox.allowedHosts", "Hosts are valid only for allowlist networking") };
    }
    if (spec.sandbox.allowedHosts.some((host) => !validHost(host))) {
      return { ok: false, error: validation("sandbox.allowedHosts", "Allowlist entries must be DNS host names") };
    }
    // Neither Docker nor Podman can enforce a DNS-name egress allowlist by itself.
    // Refuse instead of silently widening access; a future proxy backend can add it.
    if (spec.sandbox.network === "allowlist") {
      return { ok: false, error: unsupported(`${this.backend} DNS allowlist enforcement`) };
    }

    const inspected = await this.inspectImage(spec.sandbox.runtime.image);
    if (!inspected.ok) return inspected;
    if (
      spec.sandbox.runtime.expectedImageDigest !== null &&
      spec.sandbox.runtime.expectedImageDigest !== inspected.value.digest
    ) {
      return { ok: false, error: unsupported(`image digest mismatch for ${spec.sandbox.runtime.image}`) };
    }

    const containerName = `omega-${String(request.processId).replaceAll(/[^a-zA-Z0-9_.-]/gu, "-")}`;
    const mountReadOnly = spec.sandbox.filesystem === "workspace-read-only" ? ",readonly" : "";
    const containerCwd = translateCwd(spec.cwd, request.workspacePath, spec.sandbox.runtime.workspaceMountPath);
    if (containerCwd === null) {
      return { ok: false, error: validation("cwd", "Working directory must be inside the registered workspace") };
    }

    const args = [
      "run",
      "--rm",
      "--name",
      containerName,
      "--label",
      MANAGED_LABEL,
      "--label",
      `${PROCESS_LABEL}=${String(request.processId)}`,
      "--user",
      spec.sandbox.runtime.containerUser,
      "--workdir",
      containerCwd,
      "--mount",
      `type=bind,source=${String(request.workspacePath)},target=${String(spec.sandbox.runtime.workspaceMountPath)}${mountReadOnly}`,
      "--memory",
      String(spec.sandbox.memoryLimitBytes),
      "--ulimit",
      `cpu=${Math.max(1, Math.ceil(Number(spec.sandbox.cpuTimeLimitMs) / 1_000))}`,
    ];
    if (spec.sandbox.network === "none") args.push("--network", "none");
    for (const name of spec.credentialEnvNames) args.push("--env", String(name));
    args.push(spec.sandbox.runtime.image, spec.executable, ...spec.args);

    const child = spawn(this.backend, args, {
      env: { ...this.environment },
      stdio: [spec.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const spawnError = await waitForSpawn(child);
    if (spawnError !== null) return { ok: false, error: ioError(`${this.backend}.run`, spawnError) };

    const identity: SandboxRuntimeIdentity = {
      backend: this.backend,
      backendVersion: this.version,
      image: spec.sandbox.runtime.image,
      imageDigest: inspected.value.digest,
      containerUser: spec.sandbox.runtime.containerUser,
    };
    const backendName = this.backend;
    const environment = this.environment;
    return {
      ok: true,
      value: {
        process: child,
        identity,
        write(data) {
          return child.stdin?.write(data) ?? false;
        },
        closeStdin() {
          child.stdin?.end();
        },
        async signal(signal) {
          try {
            await execFileAsync(backendName, ["kill", "--signal", signal, containerName], {
              env: { ...environment },
            });
            return { ok: true, value: undefined };
          } catch (error) {
            return { ok: false, error: ioError(`${backendName}.kill`, errorFrom(error as object)) };
          }
        },
      },
    };
  }

  public async recoverOrphans(): Promise<Result<readonly ProcessId[], ProcessError>> {
    try {
      const { stdout } = await execFileAsync(
        this.backend,
        ["ps", "--filter", `label=${MANAGED_LABEL}`, "--format", `{{.Label \"${PROCESS_LABEL}\"}}`],
        { env: { ...this.environment } },
      );
      const ids = stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0) as ProcessId[];
      for (const id of ids) {
        await execFileAsync(this.backend, ["ps", "--filter", `label=${PROCESS_LABEL}=${String(id)}`, "--format", "{{.ID}}"], {
          env: { ...this.environment },
        }).then(async ({ stdout: containerIds }) => {
          for (const containerId of containerIds.split(/\r?\n/u).filter((value) => value.length > 0)) {
            await execFileAsync(this.backend, ["kill", "--signal", "SIGKILL", containerId], { env: { ...this.environment } });
          }
        });
      }
      return { ok: true, value: ids };
    } catch (error) {
      return { ok: false, error: ioError(`${this.backend}.recover`, errorFrom(error as object)) };
    }
  }

  private async inspectImage(image: string): Promise<Result<{ readonly digest: Sha256 }, ProcessError>> {
    try {
      const { stdout } = await execFileAsync(this.backend, ["image", "inspect", "--format", "{{.Id}}", image], {
        env: { ...this.environment },
      });
      const digest = digestFromInspect(stdout);
      return digest === null
        ? { ok: false, error: unsupported(`unresolvable image digest for ${image}`) }
        : { ok: true, value: { digest } };
    } catch {
      return { ok: false, error: unsupported(`unavailable image ${image}`) };
    }
  }
}

function validation(field: string, message: string): ProcessError {
  return { kind: "validation", field, message, recoverable: true, callerAction: "fix-request" };
}

function translateCwd(cwd: AbsolutePath, workspace: AbsolutePath, mount: AbsolutePath): string | null {
  const workspaceValue = String(workspace).replace(/\/$/u, "");
  const cwdValue = String(cwd);
  if (cwdValue !== workspaceValue && !cwdValue.startsWith(`${workspaceValue}/`)) return null;
  return `${String(mount).replace(/\/$/u, "")}${cwdValue.slice(workspaceValue.length)}`;
}

function waitForSpawn(child: ChildProcess): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolve(null);
    };
    const onError = (error: Error): void => {
      child.off("spawn", onSpawn);
      resolve(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

async function detect(name: BackendName, environment: EnvironmentVariables): Promise<OciSandboxBackend | null> {
  try {
    const { stdout } = await execFileAsync(name, ["version", "--format", "{{.Server.Version}}"], {
      env: { ...environment },
      timeout: 5_000,
    });
    const version = stdout.trim();
    return version.length === 0 ? null : new OciSandboxBackend(name, version, environment);
  } catch {
    return null;
  }
}

export async function detectSandboxBackend(
  config: OmegaConfig["processes"],
  environment: EnvironmentVariables,
): Promise<Result<SandboxBackend, UnsupportedError>> {
  const candidates: readonly BackendName[] = config.sandboxBackend === "auto"
    ? ["docker", "podman"]
    : [config.sandboxBackend];
  for (const candidate of candidates) {
    const backend = await detect(candidate, environment);
    if (backend !== null) return { ok: true, value: backend };
  }
  return { ok: false, error: unsupported(`OCI sandbox backend (${candidates.join(" or ")})`) };
}
