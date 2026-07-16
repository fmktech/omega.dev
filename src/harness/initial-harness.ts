import type {
  CapabilityKind,
  ComponentId,
  ComponentManifest,
  CreateInitialHarness,
  HarnessError,
  HarnessId,
  HarnessManifest,
  JsonObject,
  JsonValue,
  ObjectHash,
  ObjectStore,
  Result,
  Timestamp,
} from "../contracts/index.js";

const INITIAL_RUNNER = String.raw`let buffer="";
process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{buffer+=chunk;for(;;){const newline=buffer.indexOf("\n");if(newline<0)return;const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);try{const envelope=JSON.parse(line);if(envelope.protocol==="omega-runner-jsonl"&&envelope.version===1&&envelope.message?.kind==="kernel.start"){process.stdout.write(JSON.stringify({protocol:"omega-runner-jsonl",version:1,message:{kind:"runner.ready",harnessId:envelope.message.start.harness.id}})+"\n");}}catch{process.stdout.write(JSON.stringify({protocol:"omega-runner-jsonl",version:1,message:{kind:"runner.protocol-error",error:{kind:"protocol-error",protocol:"runner-jsonl",message:"invalid kernel JSONL",recoverable:false,callerAction:"abort"}}})+"\n");}}});`;

const INITIAL_TOOLS: readonly { readonly name: string; readonly capabilities: readonly CapabilityKind[] }[] = [
  { name: "file.read", capabilities: ["read-files"] },
  { name: "file.write", capabilities: ["write-files"] },
  { name: "process.start", capabilities: ["start-process"] },
  { name: "process.observe", capabilities: [] },
  { name: "process.input", capabilities: ["process-input"] },
  { name: "process.cancel", capabilities: [] },
  { name: "subagent.spawn", capabilities: ["spawn-child"] },
  { name: "subagent.observe", capabilities: [] },
  { name: "knowledge.catalog", capabilities: [] },
  { name: "knowledge.read", capabilities: [] },
  { name: "knowledge.write", capabilities: ["write-knowledge"] },
  { name: "marketplace.search", capabilities: [] },
  { name: "marketplace.install", capabilities: ["install-marketplace"] },
  { name: "harness.evolve", capabilities: ["create-harness-candidate"] },
  { name: "harness.status", capabilities: [] },
];

export const createInitialHarness: CreateInitialHarness = async (project, objects, projects) => {
  if (project.activeHarnessId !== null) {
    return conflict("project-active-harness", "null", project.activeHarnessId);
  }
  const runnerPayload = await putBytes(objects, "application/javascript", INITIAL_RUNNER);
  if (!runnerPayload.ok) {
    return runnerPayload;
  }
  const runner = await materializeComponent(objects, {
    kind: "runner",
    runtime: "node",
    objectHash: runnerPayload.value,
    entrypoint: `inline-base64:${Buffer.from(INITIAL_RUNNER, "utf8").toString("base64")}`,
    credentialEnvNames: [],
    capabilities: ["model-call"],
  });
  if (!runner.ok) {
    return runner;
  }
  const tools: ComponentManifest[] = [];
  for (const tool of INITIAL_TOOLS) {
    const payload = await putBytes(objects, "application/vnd.omega.tool+json", JSON.stringify({
      name: tool.name,
      transport: "runner-request",
      protocolVersion: 1,
    }));
    if (!payload.ok) {
      return payload;
    }
    const component = await materializeComponent(objects, {
      kind: "tool",
      runtime: "document",
      objectHash: payload.value,
      entrypoint: tool.name,
      credentialEnvNames: [],
      capabilities: tool.capabilities,
    });
    if (!component.ok) {
      return component;
    }
    tools.push(component.value);
  }
  const createdAt = new Date().toISOString() as Timestamp;
  const body = {
    projectId: project.id,
    alias: `${project.displayName}@1`,
    parents: [],
    components: [runner.value, ...tools],
    sourceArtifacts: [],
    createdAt,
  } as const;
  const stored = await putJson(objects, "application/vnd.omega.harness+json", {
    projectId: body.projectId,
    alias: body.alias,
    parents: body.parents,
    components: body.components.map(componentJson),
    sourceArtifacts: body.sourceArtifacts,
    createdAt: body.createdAt,
  });
  if (!stored.ok) {
    return stored;
  }
  const manifest: HarnessManifest = { id: `harness_${stored.value}` as HarnessId, ...body };
  const activated = await projects.compareAndSetActiveHarness(project.id, null, manifest.id);
  if (!activated.ok) {
    return activated;
  }
  return { ok: true, value: manifest };
};

async function materializeComponent(
  objects: ObjectStore,
  body: Omit<ComponentManifest, "id">,
): Promise<Result<ComponentManifest, HarnessError>> {
  const stored = await putJson(objects, "application/vnd.omega.component+json", {
    kind: body.kind,
    runtime: body.runtime,
    objectHash: body.objectHash,
    entrypoint: body.entrypoint,
    credentialEnvNames: body.credentialEnvNames,
    capabilities: body.capabilities,
  });
  if (!stored.ok) {
    return stored;
  }
  return { ok: true, value: { id: `component_${stored.value}` as ComponentId, ...body } };
}

async function putJson(objects: ObjectStore, mediaType: string, value: JsonObject): Promise<Result<ObjectHash, HarnessError>> {
  return putBytes(objects, mediaType, canonical(value));
}

async function putBytes(objects: ObjectStore, mediaType: string, value: string): Promise<Result<ObjectHash, HarnessError>> {
  const bytes = Buffer.from(value, "utf8");
  async function* chunks(): AsyncIterable<Uint8Array> {
    yield bytes;
  }
  const stored = await objects.put(mediaType, chunks());
  return stored.ok ? { ok: true, value: stored.value.hash } : stored;
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key] ?? null)}`).join(",")}}`;
}

function componentJson(component: ComponentManifest): JsonObject {
  return {
    id: component.id,
    kind: component.kind,
    runtime: component.runtime,
    objectHash: component.objectHash,
    entrypoint: component.entrypoint,
    credentialEnvNames: component.credentialEnvNames,
    capabilities: component.capabilities,
  };
}

function conflict(resource: string, expected: string, actual: string): Result<never, HarnessError> {
  return { ok: false, error: { kind: "conflict", resource, expected, actual, recoverable: true, callerAction: "refresh-version-and-retry" } };
}
