import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import type {
  CapabilityDeniedError,
  CapabilityEnvelope,
  CapabilityKind,
  ComponentRuntime,
  ConflictError,
  CredentialEnvName,
  IoError,
  MarketplaceArtifact,
  MarketplaceInstallation,
  MarketplaceState,
  NotFoundError,
  Result,
  Sha256,
  Timestamp,
  ValidationError,
} from "../contracts/index.js";

type JsonValidator<T> = (value: unknown) => value is T;

const stateLocks = new Map<string, Promise<void>>();

export function nowTimestamp(): Timestamp {
  return new Date().toISOString() as Timestamp;
}

export function sha256(value: string | Uint8Array): Sha256 {
  return createHash("sha256").update(value).digest("hex") as Sha256;
}

export function stateFileName(id: string): string {
  return sha256(id);
}

export function validationError(message: string, field: string | null): ValidationError {
  return {
    kind: "validation",
    message,
    field,
    recoverable: true,
    callerAction: "fix-request",
  };
}

export function notFoundError(resource: string, id: string): NotFoundError {
  return {
    kind: "not-found",
    resource,
    id,
    recoverable: false,
    callerAction: "propagate",
  };
}

export function conflictError(resource: string, expected: string, actual: string): ConflictError {
  return {
    kind: "conflict",
    resource,
    expected,
    actual,
    recoverable: true,
    callerAction: "refresh-version-and-retry",
  };
}

export function capabilityDenied(capability: CapabilityKind, reason: string): CapabilityDeniedError {
  return {
    kind: "capability-denied",
    capability,
    reason,
    recoverable: true,
    callerAction: "request-new-child",
  };
}

export function ioError(operation: string, error: unknown): IoError {
  const code = isNodeError(error) && typeof error.code === "string" ? error.code : null;
  return {
    kind: "io-error",
    operation,
    code,
    recoverable: code === "EAGAIN" || code === "EBUSY" || code === "EMFILE" || code === "ENFILE",
    callerAction: code === "EAGAIN" || code === "EBUSY" || code === "EMFILE" || code === "ENFILE" ? "retry-with-backoff" : "propagate",
  };
}

export function hasCapability(envelope: CapabilityEnvelope, capability: CapabilityKind): boolean {
  return envelope.grants.some((grant) => grant.kind === capability);
}

export function credentialsArePermitted(
  envelope: CapabilityEnvelope,
  names: readonly CredentialEnvName[],
): boolean {
  if (names.length === 0) {
    return true;
  }
  const permitted = new Set(
    envelope.grants
      .filter((grant) => grant.kind === "inject-credential")
      .flatMap((grant) => grant.credentialEnvNames),
  );
  return names.every((name) => permitted.has(name));
}

export async function withStateLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = stateLocks.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  stateLocks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (stateLocks.get(key) === tail) {
      stateLocks.delete(key);
    }
  }
}

export async function readJsonState<T>(
  path: string,
  resource: string,
  id: string,
  validator: JsonValidator<T>,
): Promise<Result<T, NotFoundError | IoError>> {
  try {
    const text = await readFile(path, "utf8");
    const value: unknown = JSON.parse(text);
    if (!validator(value)) {
      return { ok: false, error: ioError(`validate ${resource} state`, { code: "EINVALIDSTATE" }) };
    }
    return { ok: true, value };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { ok: false, error: notFoundError(resource, id) };
    }
    return { ok: false, error: ioError(`read ${resource} state`, error) };
  }
}

export async function writeJsonState(path: string, value: object): Promise<Result<void, IoError>> {
  return writeTextState(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextState(path: string, value: string): Promise<Result<void, IoError>> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, value, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: ioError("atomically write state", error) };
  }
}

export function isMarketplaceArtifact(value: unknown): value is MarketplaceArtifact {
  if (!isRecord(value) || !isMarketplaceArtifactKind(value["kind"]) || !isMarketplaceState(value["state"])) {
    return false;
  }
  if (
    !isNonEmptyString(value["id"]) ||
    !isNonEmptyString(value["title"]) ||
    !isNonEmptyString(value["summary"]) ||
    !isSha256(value["objectHash"]) ||
    !isStringArray(value["componentIds"]) ||
    value["componentIds"].length === 0 ||
    !isNonEmptyString(value["sourceProjectId"]) ||
    !isNonEmptyString(value["sourceHarnessId"]) ||
    !isStringArray(value["scorecardIds"]) ||
    !isStringArray(value["credentialEnvNames"]) ||
    !value["credentialEnvNames"].every(isCredentialEnvName) ||
    !isTimestamp(value["publishedAt"]) ||
    !isRecord(value["compatibility"])
  ) {
    return false;
  }
  const compatibility = value["compatibility"];
  return (
    Array.isArray(compatibility["omegaSchemaVersions"]) &&
    compatibility["omegaSchemaVersions"].every((version) => version === 1) &&
    Array.isArray(compatibility["operatingSystems"]) &&
    compatibility["operatingSystems"].every(isOperatingSystem) &&
    Array.isArray(compatibility["runtimes"]) &&
    compatibility["runtimes"].every(isComponentRuntime) &&
    isStringArray(compatibility["requiredExecutables"]) &&
    compatibility["requiredExecutables"].every(isExecutableName)
  );
}

export function isMarketplaceInstallation(value: unknown): value is MarketplaceInstallation {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value["artifactId"]) ||
    !isNonEmptyString(value["projectId"]) ||
    !isStringArray(value["installedComponentIds"]) ||
    !isNonEmptyString(value["candidateHarnessId"]) ||
    typeof value["requiresCanary"] !== "boolean" ||
    (value["activation"] !== "installed-inactive" && value["activation"] !== "active") ||
    !isTimestamp(value["installedAt"]) ||
    (value["activatedAt"] !== null && !isTimestamp(value["activatedAt"])) ||
    !isRecord(value["compatibility"])
  ) {
    return false;
  }
  const compatibility = value["compatibility"];
  if (
    compatibility["compatible"] !== true ||
    compatibility["omegaSchemaVersion"] !== 1 ||
    !isOperatingSystem(compatibility["operatingSystem"]) ||
    !Array.isArray(compatibility["availableRuntimes"]) ||
    !compatibility["availableRuntimes"].every(isComponentRuntime)
  ) {
    return false;
  }
  if (value["canary"] === null) {
    return true;
  }
  return isCanaryEvidence(value["canary"]);
}

export function validateMarketplaceArtifact(artifact: MarketplaceArtifact): ValidationError | null {
  if (!isMarketplaceArtifact(artifact)) {
    return validationError("Marketplace artifact manifest is invalid", "artifact");
  }
  if (new Set(artifact.componentIds).size !== artifact.componentIds.length) {
    return validationError("Marketplace component IDs must be unique", "componentIds");
  }
  if (new Set(artifact.credentialEnvNames).size !== artifact.credentialEnvNames.length) {
    return validationError("Credential environment names must be unique", "credentialEnvNames");
  }
  return null;
}

export function canTransitionMarketplaceState(from: MarketplaceState, to: MarketplaceState): boolean {
  if (from === to) {
    return true;
  }
  switch (from) {
    case "experimental":
      return to === "proven" || to === "deprecated" || to === "quarantined";
    case "proven":
      return to === "deprecated" || to === "quarantined";
    case "deprecated":
      return to === "experimental" || to === "proven" || to === "quarantined";
    case "quarantined":
      return false;
  }
}

export async function evaluateCompatibility(
  artifact: MarketplaceArtifact,
): Promise<
  Result<
    MarketplaceInstallation["compatibility"],
    ValidationError
  >
> {
  const operatingSystem = currentOperatingSystem();
  if (operatingSystem === null) {
    return { ok: false, error: validationError(`Unsupported host operating system: ${process.platform}`, "compatibility.operatingSystems") };
  }
  if (!artifact.compatibility.omegaSchemaVersions.includes(1)) {
    return { ok: false, error: validationError("Artifact does not support Omega schema version 1", "compatibility.omegaSchemaVersions") };
  }
  if (!artifact.compatibility.operatingSystems.includes(operatingSystem)) {
    return { ok: false, error: validationError(`Artifact does not support ${operatingSystem}`, "compatibility.operatingSystems") };
  }

  const availableRuntimes = await detectAvailableRuntimes();
  const missingRuntime = artifact.compatibility.runtimes.find((runtime) => !availableRuntimes.includes(runtime));
  if (missingRuntime !== undefined) {
    return { ok: false, error: validationError(`Required runtime is unavailable: ${missingRuntime}`, "compatibility.runtimes") };
  }
  for (const executable of artifact.compatibility.requiredExecutables) {
    if (!(await executableExists(executable))) {
      return { ok: false, error: validationError(`Required executable is unavailable: ${executable}`, "compatibility.requiredExecutables") };
    }
  }

  return {
    ok: true,
    value: {
      compatible: true,
      omegaSchemaVersion: 1,
      operatingSystem,
      availableRuntimes,
    },
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isTimestamp(value: unknown): value is Timestamp {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function isCredentialEnvName(value: unknown): value is CredentialEnvName {
  return typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/.test(value);
}

function isExecutableName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._+-]+$/.test(value);
}

function isMarketplaceState(value: unknown): value is MarketplaceState {
  return value === "experimental" || value === "proven" || value === "deprecated" || value === "quarantined";
}

function isMarketplaceArtifactKind(value: unknown): value is MarketplaceArtifact["kind"] {
  return value === "harness" || value === "tool" || value === "connector" || value === "skill" || value === "workflow" || value === "component-delta";
}

function isOperatingSystem(value: unknown): value is MarketplaceInstallation["compatibility"]["operatingSystem"] {
  return value === "linux" || value === "darwin" || value === "windows";
}

function isComponentRuntime(value: unknown): value is ComponentRuntime {
  return value === "node" || value === "python" || value === "bash" || value === "native" || value === "document";
}

function isCanaryEvidence(value: unknown): value is NonNullable<MarketplaceInstallation["canary"]> {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value["projectId"]) ||
    !isNonEmptyString(value["artifactId"]) ||
    !isNonEmptyString(value["candidateHarnessId"]) ||
    !isRecord(value["result"])
  ) {
    return false;
  }
  const result = value["result"];
  if (
    !isNonEmptyString(result["harnessId"]) ||
    (result["outcome"] !== "healthy" && result["outcome"] !== "regressed") ||
    (result["action"] !== "retain" && result["action"] !== "rollback-and-quarantine") ||
    !isRecord(result["source"])
  ) {
    return false;
  }
  const source = result["source"];
  return source["kind"] === "benchmark"
    ? isNonEmptyString(source["benchmarkRunId"])
    : source["kind"] === "project-session" &&
        isNonEmptyString(source["sessionId"]) &&
        isNonEmptyString(source["verificationArtifactId"]);
}

function currentOperatingSystem(): MarketplaceInstallation["compatibility"]["operatingSystem"] | null {
  switch (process.platform) {
    case "linux":
      return "linux";
    case "darwin":
      return "darwin";
    case "win32":
      return "windows";
    default:
      return null;
  }
}

async function detectAvailableRuntimes(): Promise<readonly ComponentRuntime[]> {
  const available: ComponentRuntime[] = ["node", "native", "document"];
  if (await executableExists("bash")) {
    available.push("bash");
  }
  if ((await executableExists("python3")) || (await executableExists("python"))) {
    available.push("python");
  }
  return available;
}

async function executableExists(executable: string): Promise<boolean> {
  const pathValue = process.env["PATH"] ?? "";
  const extensions = process.platform === "win32"
    ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    for (const extension of extensions) {
      try {
        await access(join(directory, `${executable}${extension}`));
        return true;
      } catch {
        // Continue searching the process PATH.
      }
    }
  }
  return false;
}
