import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  AbsolutePath,
  ArtifactId,
  CapabilityKind,
  ComponentId,
  ComponentKind,
  ComponentManifest,
  ComponentRuntime,
  CreateHarnessRepository,
  CredentialEnvName,
  HarnessError,
  HarnessId,
  HarnessManifest,
  JsonObject,
  JsonValue,
  ObjectHash,
  ObjectStore,
  PageRequest,
  ProjectId,
  Result,
  Sha256,
  Timestamp,
} from "../contracts/index.js";

const COMPONENT_PREFIX = "component_";
const HARNESS_PREFIX = "harness_";
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const COMPONENT_KINDS: ReadonlySet<string> = new Set([
  "runner", "tool", "connector", "skill", "workflow", "context-compiler", "promotion-evaluator", "policy-prompt",
]);
const COMPONENT_RUNTIMES: ReadonlySet<string> = new Set(["node", "python", "bash", "native", "document"]);
const CAPABILITY_KINDS: ReadonlySet<string> = new Set([
  "model-call", "read-files", "write-files", "start-process", "process-input", "network-egress", "inject-credential",
  "spawn-child", "write-knowledge", "install-marketplace", "publish-marketplace", "manage-marketplace",
  "create-harness-candidate", "run-promotion-eval", "activate-harness",
]);

type ComponentBody = Omit<ComponentManifest, "id">;
type HarnessBody = Omit<HarnessManifest, "id">;

export const createHarnessRepository: CreateHarnessRepository = (root, objects, projects) => ({
  async putComponent(component) {
    const valid = validateComponent(component);
    if (!valid.ok) {
      return valid;
    }
    const described = await objects.describe(component.objectHash);
    if (!described.ok) {
      return described;
    }
    const body = componentBody(component);
    const stored = await putJson(objects, "application/vnd.omega.component+json", body);
    if (!stored.ok) {
      return stored;
    }
    const expectedId = `${COMPONENT_PREFIX}${stored.value.hash}` as ComponentId;
    if (component.id !== expectedId) {
      return conflict("component-id", expectedId, component.id);
    }
    return { ok: true, value: freezeComponent(component) };
  },

  async putHarness(manifest) {
    const valid = validateHarness(manifest);
    if (!valid.ok) {
      return valid;
    }
    const project = await projects.getProject(manifest.projectId);
    if (!project.ok) {
      return project;
    }
    const parentIds = new Set<string>();
    for (const parentId of manifest.parents) {
      if (parentId === manifest.id || parentIds.has(parentId)) {
        return validation("Harness parents must be unique and cannot contain the harness itself", "parents");
      }
      parentIds.add(parentId);
      const parent = await loadHarness(objects, parentId);
      if (!parent.ok) {
        return parent;
      }
      if (parent.value.projectId !== manifest.projectId) {
        return validation("Harness parents must belong to the same project", "parents");
      }
    }
    const componentIds = new Set<string>();
    for (const component of manifest.components) {
      if (componentIds.has(component.id)) {
        return validation("Harness component ids must be unique", "components");
      }
      componentIds.add(component.id);
      const storedComponent = await putComponent(objects, component);
      if (!storedComponent.ok) {
        return storedComponent;
      }
    }
    const stored = await putJson(objects, "application/vnd.omega.harness+json", harnessBody(manifest));
    if (!stored.ok) {
      return stored;
    }
    const expectedId = `${HARNESS_PREFIX}${stored.value.hash}` as HarnessId;
    if (manifest.id !== expectedId) {
      return conflict("harness-id", expectedId, manifest.id);
    }
    const indexed = await indexHarness(root, manifest);
    if (!indexed.ok) {
      return indexed;
    }
    return { ok: true, value: freezeHarness(manifest) };
  },

  getHarness(id) {
    return loadHarness(objects, id);
  },

  async getActiveHarness(projectId) {
    const project = await projects.getProject(projectId);
    if (!project.ok) {
      return project;
    }
    if (project.value.activeHarnessId === null) {
      return notFound("active-harness", projectId);
    }
    return loadHarness(objects, project.value.activeHarnessId);
  },

  async listProjectHarnesses(projectId, page) {
    const validPage = validatePage(page);
    if (!validPage.ok) {
      return validPage;
    }
    const project = await projects.getProject(projectId);
    if (!project.ok) {
      return project;
    }
    let ids: HarnessId[];
    try {
      const directory = projectIndexDirectory(root, projectId);
      const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return [];
        }
        throw error;
      });
      ids = entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => entry.slice(0, -5) as HarnessId);
    } catch (error) {
      return ioError("list-project-harnesses", error);
    }
    if (project.value.activeHarnessId !== null && !ids.includes(project.value.activeHarnessId)) {
      ids.push(project.value.activeHarnessId);
    }
    ids.sort((left, right) => left.localeCompare(right));
    const remaining = page.cursor === null ? ids : ids.filter((id) => id.localeCompare(page.cursor ?? "") > 0);
    const selected = remaining.slice(0, page.limit);
    const manifests: HarnessManifest[] = [];
    for (const id of selected) {
      const loaded = await loadHarness(objects, id);
      if (!loaded.ok) {
        return loaded;
      }
      if (loaded.value.projectId !== projectId) {
        return integrity("harness-project", projectId, loaded.value.projectId);
      }
      manifests.push(loaded.value);
    }
    return {
      ok: true,
      value: {
        items: manifests,
        nextCursor: remaining.length > selected.length ? selected.at(-1) ?? null : null,
      },
    };
  },
});

async function putComponent(objects: ObjectStore, component: ComponentManifest): Promise<Result<ComponentManifest, HarnessError>> {
  const valid = validateComponent(component);
  if (!valid.ok) {
    return valid;
  }
  const described = await objects.describe(component.objectHash);
  if (!described.ok) {
    return described;
  }
  const stored = await putJson(objects, "application/vnd.omega.component+json", componentBody(component));
  if (!stored.ok) {
    return stored;
  }
  const expected = `${COMPONENT_PREFIX}${stored.value.hash}` as ComponentId;
  return component.id === expected ? { ok: true, value: freezeComponent(component) } : conflict("component-id", expected, component.id);
}

async function loadHarness(objects: ObjectStore, id: HarnessId): Promise<Result<HarnessManifest, HarnessError>> {
  const hash = hashFromId(id, HARNESS_PREFIX);
  if (hash === null) {
    return validation("Harness id must be a content-addressed harness_<sha256> value", "id");
  }
  const loaded = await objects.get(hash);
  if (!loaded.ok) {
    return loaded;
  }
  const bytes: Uint8Array[] = [];
  try {
    for await (const chunk of loaded.value) {
      bytes.push(chunk);
    }
    const parsed = JSON.parse(Buffer.concat(bytes).toString("utf8")) as JsonValue;
    const body = parseHarnessBody(parsed);
    if (!body.ok) {
      return body;
    }
    const canonicalHash = sha256(encodeCanonical(body.value));
    if (canonicalHash !== hash) {
      return integrity("harness-manifest", hash, canonicalHash);
    }
    return { ok: true, value: freezeHarness({ id, ...body.value }) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return protocolError("Stored harness manifest is not valid JSON");
    }
    return ioError("read-harness", error);
  }
}

async function putJson(objects: ObjectStore, mediaType: string, value: JsonObject) {
  const encoded = Buffer.from(encodeCanonical(value), "utf8");
  async function* chunks(): AsyncIterable<Uint8Array> {
    yield encoded;
  }
  return objects.put(mediaType, chunks());
}

async function indexHarness(root: AbsolutePath, manifest: HarnessManifest): Promise<Result<void, HarnessError>> {
  const path = join(projectIndexDirectory(root, manifest.projectId), `${manifest.id}.json`);
  const encoded = `${JSON.stringify({ id: manifest.id, projectId: manifest.projectId })}\n`;
  try {
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, encoded, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(isNodeError(error) && error.code === "EEXIST")) {
        throw error;
      }
      if (await readFile(path, "utf8") !== encoded) {
        return conflict("harness-index", encoded.trim(), (await readFile(path, "utf8")).trim());
      }
    }
    return { ok: true, value: undefined };
  } catch (error) {
    return ioError("index-harness", error);
  }
}

function componentBody(component: ComponentManifest): ComponentBody & JsonObject {
  return {
    kind: component.kind,
    runtime: component.runtime,
    objectHash: component.objectHash,
    entrypoint: component.entrypoint,
    credentialEnvNames: [...component.credentialEnvNames],
    capabilities: [...component.capabilities],
  };
}

function harnessBody(manifest: HarnessManifest): HarnessBody & JsonObject {
  return {
    projectId: manifest.projectId,
    alias: manifest.alias,
    parents: [...manifest.parents],
    components: manifest.components.map(componentAsJson),
    sourceArtifacts: [...manifest.sourceArtifacts],
    createdAt: manifest.createdAt,
  };
}

function componentAsJson(component: ComponentManifest): ComponentManifest & JsonObject {
  return { id: component.id, ...componentBody(component) };
}

function encodeCanonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(encodeCanonical).join(",")}]`;
  }
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${encodeCanonical(object[key] ?? null)}`).join(",")}}`;
}

function parseHarnessBody(value: JsonValue): Result<HarnessBody, HarnessError> {
  if (!isObject(value)) {
    return protocolError("Stored harness body must be an object");
  }
  const componentsValue = value["components"];
  const parentsValue = value["parents"];
  const artifactsValue = value["sourceArtifacts"];
  if (typeof value["projectId"] !== "string" || typeof value["alias"] !== "string"
    || !Array.isArray(componentsValue) || !isStringArray(parentsValue) || !isStringArray(artifactsValue)
    || typeof value["createdAt"] !== "string") {
    return protocolError("Stored harness body has an invalid shape");
  }
  const components: ComponentManifest[] = [];
  for (const item of componentsValue) {
    const parsed = parseComponent(item);
    if (!parsed.ok) {
      return parsed;
    }
    components.push(parsed.value);
  }
  const body: HarnessBody = {
    projectId: value["projectId"] as ProjectId,
    alias: value["alias"],
    parents: parentsValue as readonly HarnessId[],
    components,
    sourceArtifacts: artifactsValue as readonly ArtifactId[],
    createdAt: value["createdAt"] as Timestamp,
  };
  return validateHarness({ id: `${HARNESS_PREFIX}${sha256(encodeCanonical(value))}` as HarnessId, ...body }).ok
    ? { ok: true, value: body }
    : protocolError("Stored harness body failed validation");
}

function parseComponent(value: JsonValue): Result<ComponentManifest, HarnessError> {
  if (!isObject(value) || typeof value["id"] !== "string" || typeof value["kind"] !== "string"
    || typeof value["runtime"] !== "string" || typeof value["objectHash"] !== "string"
    || typeof value["entrypoint"] !== "string" || !isStringArray(value["credentialEnvNames"])
    || !isStringArray(value["capabilities"])) {
    return protocolError("Stored component manifest has an invalid shape");
  }
  const component: ComponentManifest = {
    id: value["id"] as ComponentId,
    kind: value["kind"] as ComponentKind,
    runtime: value["runtime"] as ComponentRuntime,
    objectHash: value["objectHash"] as ObjectHash,
    entrypoint: value["entrypoint"],
    credentialEnvNames: value["credentialEnvNames"] as readonly CredentialEnvName[],
    capabilities: value["capabilities"] as readonly CapabilityKind[],
  };
  const valid = validateComponent(component);
  return valid.ok ? { ok: true, value: component } : protocolError("Stored component manifest failed validation");
}

function validateComponent(component: ComponentManifest): Result<void, HarnessError> {
  if (!COMPONENT_KINDS.has(component.kind) || !COMPONENT_RUNTIMES.has(component.runtime)) {
    return validation("Unsupported component kind or runtime", "component");
  }
  if (component.entrypoint.trim().length === 0 || !HASH_PATTERN.test(component.objectHash)) {
    return validation("Component entrypoint and object hash must be valid", "component");
  }
  if (new Set(component.capabilities).size !== component.capabilities.length
    || component.capabilities.some((kind) => !CAPABILITY_KINDS.has(kind))) {
    return validation("Component capabilities must be unique known capability kinds", "capabilities");
  }
  if (new Set(component.credentialEnvNames).size !== component.credentialEnvNames.length
    || component.credentialEnvNames.some((name) => name.length === 0 || name.includes("="))) {
    return validation("Component credential environment names must be unique names", "credentialEnvNames");
  }
  return { ok: true, value: undefined };
}

function validateHarness(manifest: HarnessManifest): Result<void, HarnessError> {
  if (manifest.alias.trim().length === 0 || manifest.components.length === 0) {
    return validation("Harness alias and at least one component are required", "manifest");
  }
  if (!Number.isFinite(Date.parse(manifest.createdAt))) {
    return validation("Harness createdAt must be an ISO timestamp", "createdAt");
  }
  if (manifest.components.filter((component) => component.kind === "runner").length !== 1) {
    return validation("A harness must contain exactly one runner component", "components");
  }
  return { ok: true, value: undefined };
}

function validatePage(page: PageRequest): Result<void, HarnessError> {
  return Number.isInteger(page.limit) && page.limit > 0 && page.limit <= 1_000
    ? { ok: true, value: undefined }
    : validation("Page limit must be an integer from 1 through 1000", "limit");
}

function freezeComponent(component: ComponentManifest): ComponentManifest {
  return Object.freeze({
    ...component,
    credentialEnvNames: Object.freeze([...component.credentialEnvNames]),
    capabilities: Object.freeze([...component.capabilities]),
  });
}

function freezeHarness(manifest: HarnessManifest): HarnessManifest {
  return Object.freeze({
    ...manifest,
    parents: Object.freeze([...manifest.parents]),
    components: Object.freeze(manifest.components.map(freezeComponent)),
    sourceArtifacts: Object.freeze([...manifest.sourceArtifacts]),
  });
}

function hashFromId(id: string, prefix: string): ObjectHash | null {
  const value = id.startsWith(prefix) ? id.slice(prefix.length) : "";
  return HASH_PATTERN.test(value) ? value as ObjectHash : null;
}

function projectIndexDirectory(root: AbsolutePath, projectId: ProjectId): string {
  return join(root, "harness-index", createHash("sha256").update(projectId).digest("hex"));
}

function sha256(value: string): ObjectHash {
  return createHash("sha256").update(value, "utf8").digest("hex") as ObjectHash;
}

function isObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: JsonValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validation(message: string, field: string | null): Result<never, HarnessError> {
  return { ok: false, error: { kind: "validation", message, field, recoverable: true, callerAction: "fix-request" } };
}

function notFound(resource: string, id: string): Result<never, HarnessError> {
  return { ok: false, error: { kind: "not-found", resource, id, recoverable: false, callerAction: "propagate" } };
}

function conflict(resource: string, expected: string, actual: string): Result<never, HarnessError> {
  return { ok: false, error: { kind: "conflict", resource, expected, actual, recoverable: true, callerAction: "refresh-version-and-retry" } };
}

function integrity(resource: string, expected: string, actual: string): Result<never, HarnessError> {
  return {
    ok: false,
    error: {
      kind: "integrity-failure",
      resource,
      expected: sha256ForError(expected),
      actual: sha256ForError(actual),
      recoverable: false,
      callerAction: "abort",
    },
  };
}

function protocolError(message: string): Result<never, HarnessError> {
  return { ok: false, error: { kind: "protocol-error", protocol: "runner-jsonl", message, recoverable: false, callerAction: "abort" } };
}

function sha256ForError(value: string): Sha256 {
  return createHash("sha256").update(value, "utf8").digest("hex") as Sha256;
}

function ioError(operation: string, error: unknown): Result<never, HarnessError> {
  const code = isNodeError(error) ? error.code ?? null : null;
  const retry = code === "EAGAIN" || code === "EBUSY" || code === "EMFILE" || code === "ENFILE";
  return { ok: false, error: { kind: "io-error", operation, code, recoverable: retry, callerAction: retry ? "retry-with-backoff" : "propagate" } };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
