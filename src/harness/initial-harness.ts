import type {
  CapabilityKind,
  ComponentId,
  ComponentManifest,
  CreateInitialHarness,
  HarnessError,
  HarnessId,
  JsonObject,
  JsonValue,
  ObjectHash,
  ObjectStore,
  Result,
  Timestamp,
} from "../contracts/index.js";

const INITIAL_MODEL_TOOLS = [
  { name: "file.read", description: "Read a UTF-8 workspace file and return content plus its SHA-256 interlock.", inputSchema: { type: "object", properties: { path: { type: "string", description: "Repository-relative POSIX path" } }, required: ["path"], additionalProperties: false } },
  { name: "file.write", description: "Create or replace a UTF-8 file. Pass the exact SHA from file.read when replacing; a stale SHA is rejected.", inputSchema: { type: "object", properties: { path: { type: "string" }, expectedSha: { type: ["string", "null"] }, content: { type: "string" } }, required: ["path", "expectedSha", "content"], additionalProperties: false } },
  { name: "process.start", description: "Start one isolated workspace process. Network defaults to none. Use process.observe to stream output and state.", inputSchema: { type: "object", properties: { executable: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, stdin: { enum: ["pipe", "closed"] }, timeoutMs: { type: ["integer", "null"] } }, required: ["executable", "args"], additionalProperties: false } },
  { name: "process.observe", description: "Observe process state and output after byte offsets for stdout and stderr.", inputSchema: { type: "object", properties: { processId: { type: "string" }, after: { type: "array", items: { type: "object", properties: { stream: { enum: ["stdout", "stderr"] }, offset: { type: "integer", minimum: 0 } }, required: ["stream", "offset"], additionalProperties: false } } }, required: ["processId", "after"], additionalProperties: false } },
  { name: "process.input", description: "Write stdin, close stdin, or send a signal to a running process.", inputSchema: { type: "object", properties: { processId: { type: "string" }, input: { type: "object" } }, required: ["processId", "input"], additionalProperties: false } },
  { name: "process.cancel", description: "Stop a running process and preserve its stdout/stderr artifacts.", inputSchema: { type: "object", properties: { processId: { type: "string" }, reason: { type: "string" } }, required: ["processId", "reason"], additionalProperties: false } },
  { name: "subagent.spawn", description: "Spawn an attenuated child session for a bounded subtask.", inputSchema: { type: "object", properties: { role: { type: "string" }, objective: { type: "string" }, contextArtifactIds: { type: "array", items: { type: "string" } }, capabilityEnvelope: { type: "object" } }, required: ["role", "objective", "contextArtifactIds", "capabilityEnvelope"], additionalProperties: false } },
  { name: "subagent.observe", description: "Read the current state of a child session.", inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"], additionalProperties: false } },
  { name: "knowledge.catalog", description: "Search short project-knowledge summaries before opening a full document.", inputSchema: { type: "object", properties: { text: { type: "string" }, tags: { type: "array", items: { type: "string" } }, relevantPaths: { type: "array", items: { type: "string" } }, limit: { type: "integer", minimum: 1 } }, required: ["text", "tags", "relevantPaths", "limit"], additionalProperties: false } },
  { name: "knowledge.read", description: "Open one full project-knowledge document by ID.", inputSchema: { type: "object", properties: { documentId: { type: "string" } }, required: ["documentId"], additionalProperties: false } },
  { name: "skill.read", description: "Open one installed project skill from the session-start skill catalog by component ID.", inputSchema: { type: "object", properties: { componentId: { type: "string" } }, required: ["componentId"], additionalProperties: false } },
  { name: "knowledge.write", description: "Persist a verified project-knowledge document with provenance and compare-and-swap SHA.", inputSchema: { type: "object", properties: { document: { type: "object" }, expectedSha: { type: ["string", "null"] } }, required: ["document", "expectedSha"], additionalProperties: false } },
  { name: "marketplace.search", description: "Search locally created and vetted harness parts.", inputSchema: { type: "object", properties: { text: { type: "string" }, kinds: { type: "array", items: { type: "string" } }, states: { type: "array", items: { type: "string" } }, limit: { type: "integer", minimum: 1 } }, required: ["text", "kinds", "states", "limit"], additionalProperties: false } },
  { name: "marketplace.install", description: "Create a project-scoped candidate from a trusted local marketplace artifact.", inputSchema: { type: "object", properties: { artifactId: { type: "string" } }, required: ["artifactId"], additionalProperties: false } },
  { name: "harness.evolve", description: "Start a bounded evolution job using this session's evidence.", inputSchema: { type: "object", properties: { goal: { type: "string" }, evidenceArtifactIds: { type: "array", items: { type: "string" } }, allowedComponentKinds: { type: "array", items: { type: "string" } }, budget: { type: "object" } }, required: ["goal", "evidenceArtifactIds", "allowedComponentKinds", "budget"], additionalProperties: false } },
  { name: "harness.status", description: "Read the project's currently active harness manifest.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
] as const;

const INITIAL_RUNNER = String.raw`let buffer="",start=null,currentHarnessId=null,requestSequence=0,activeStream=null,toolCalls=new Map();
const pending=new Map();
const skillCache=new Map();
const tools=${JSON.stringify(INITIAL_MODEL_TOOLS)};
let messages=[];
function emit(message){process.stdout.write(JSON.stringify({protocol:"omega-runner-jsonl",version:1,message})+"\n")}
function request(value,done){const requestId="runner-"+(++requestSequence);pending.set(requestId,done);emit({kind:"runner.request",request:{...value,requestId}})}
function finish(outcome){request({kind:"session.complete",outcome},()=>{process.exitCode=outcome==="succeeded"?0:1;setImmediate(()=>process.exit())})}
function bootstrapPrompt(value){
  const instructions=value.instructions.map(item=>"Instruction file: "+item.path+"\nScope: "+item.scope+"\nSHA-256: "+item.sha+"\n"+item.content).join("\n\n");
  const catalogs=JSON.stringify({projectKnowledge:value.knowledgeCatalog,installedSkills:value.skillCatalog});
  return "You are omega.dev's initial SWE runner. Use file SHA interlocks, isolated processes, and authoritative project verification. Preserve unrelated work. Continue until the objective is complete and verified; if a tool reports stale-read, re-read, merge, and retry.\n\nRepository instructions are ordered from root to deeper scopes. Apply every instruction governing a path; a deeper AGENTS.md overrides its parent only where they conflict.\n\n"+(instructions||"No AGENTS.md files were discovered.")+"\n\nCompact durable-context catalogs:\n"+catalogs+"\n\nBefore acting, inspect these catalogs. When an entry may be relevant, call knowledge.read or skill.read to load the full document. Do not infer omitted details from a summary.";
}
function modelRequest(){
  const route=start.session.initialModelRoutes.find(route=>route.role==="main-coder")||start.session.initialModelRoutes[0];
  request({kind:"model.start",request:{sessionId:start.session.id,harnessId:currentHarnessId,role:route?.role||"main-coder",messages,tools,maxOutputTokens:Math.min(Number(route?.outputLimit||32768),Number(start.session.capabilityEnvelope.maxOutputTokens)),abortAfterMs:Number(start.session.capabilityEnvelope.wallTimeMs)}},reply=>{
    if(!reply.result?.ok){finish("failed");return}
    activeStream=reply.result.value.streamId;toolCalls=new Map();
  });
}
function toolRequest(call){
  const input=call.input||{},session=start.session,workspace=start.workspace;
  switch(call.toolName){
    case "file.read":return {kind:"file.read",workspaceId:workspace.id,path:input.path};
    case "file.write":return {kind:"file.write",request:{sessionId:session.id,workspaceId:workspace.id,path:input.path,expectedSha:input.expectedSha??null,content:String(input.content??"")}};
    case "process.start":return {kind:"process.start",spec:{executable:String(input.executable??""),args:Array.isArray(input.args)?input.args.map(String):[],cwd:input.cwd||workspace.path,credentialEnvNames:Array.isArray(input.credentialEnvNames)?input.credentialEnvNames:[],stdin:input.stdin==="closed"?"closed":"pipe",timeoutMs:input.timeoutMs??null,sandbox:input.sandbox||{filesystem:"workspace-read-write",network:"none",allowedHosts:[],memoryLimitBytes:536870912,cpuTimeLimitMs:1800000,runtime:{kind:"oci",image:"omega-runner:local",expectedImageDigest:null,containerUser:"1000:1000",workspaceMountPath:"/workspace"}},harnessId:currentHarnessId,sessionId:session.id}};
    case "process.observe":return {kind:"process.observe",processId:input.processId,after:Array.isArray(input.after)?input.after:[]};
    case "process.input":return {kind:"process.input",processId:input.processId,input:input.input};
    case "process.cancel":return {kind:"process.cancel",processId:input.processId,reason:String(input.reason||"cancelled by agent")};
    case "subagent.spawn":return {kind:"child.spawn",request:{...input,parentSessionId:session.id}};
    case "subagent.observe":return {kind:"child.observe",sessionId:input.sessionId};
    case "knowledge.catalog":return {kind:"knowledge.catalog",query:{...input,projectId:session.projectId}};
    case "knowledge.read":return {kind:"knowledge.read",documentId:input.documentId};
    case "skill.read":return {kind:"skill.read",harnessId:currentHarnessId,componentId:input.componentId};
    case "knowledge.write":return {kind:"knowledge.write",request:{...input,projectId:session.projectId}};
    case "marketplace.search":return {kind:"marketplace.search",query:input};
    case "marketplace.install":return {kind:"marketplace.install",artifactId:input.artifactId};
    case "harness.evolve":return {kind:"harness.evolve",request:{...input,projectId:session.projectId,sourceSessionId:session.id}};
    case "harness.status":return {kind:"harness.status",projectId:session.projectId};
    default:return null;
  }
}
function runTools(calls,index=0,results=[]){
  if(index>=calls.length){messages.push({role:"assistant",content:calls});messages.push({role:"tool",content:results});modelRequest();return}
  const call=calls[index],mapped=toolRequest(call);
  if(!mapped){results.push({kind:"tool-result",callId:call.callId,toolName:call.toolName,result:{error:"unsupported tool"},isError:true});runTools(calls,index+1,results);return}
  const skillKey=call.toolName==="skill.read"&&typeof call.input?.componentId==="string"?call.input.componentId:null;
  if(skillKey!==null&&skillCache.has(skillKey)){results.push({kind:"tool-result",callId:call.callId,toolName:call.toolName,result:skillCache.get(skillKey),isError:false});runTools(calls,index+1,results);return}
  request(mapped,reply=>{const result=reply.result??reply,isError=reply.result?.ok===false||reply.kind==="request.rejected";if(skillKey!==null&&!isError)skillCache.set(skillKey,result);results.push({kind:"tool-result",callId:call.callId,toolName:call.toolName,result,isError});runTools(calls,index+1,results)});
}
function modelEvent(event){
  if(event.kind==="tool-call")toolCalls.set(event.call.callId,event.call);
  if(event.kind==="failed"){activeStream=null;finish("failed");return}
  if(event.kind!=="completed")return;
  if(activeStream!==null&&event.completion.streamId!==activeStream)return;
  activeStream=null;
  for(const part of event.completion.content)if(part.kind==="tool-call")toolCalls.set(part.callId,part);
  const calls=[...toolCalls.values()];
  if(calls.length===0){finish(event.completion.finishReason==="stop"?"succeeded":"failed");return}
  runTools(calls);
}
function accept(envelope){
  if(envelope.protocol!=="omega-runner-jsonl"||envelope.version!==1)throw new Error("unsupported kernel envelope");
  const message=envelope.message;
  if(message?.kind==="kernel.start"){
    if(start!==null)throw new Error("duplicate kernel.start");
    start=message.start;currentHarnessId=start.harness.id;
    emit({kind:"runner.ready",harnessId:currentHarnessId});
    request({kind:"context.bootstrap"},reply=>{
      if(!reply.result?.ok){finish("failed");return}
      messages=[{role:"system",content:[{kind:"text",text:bootstrapPrompt(reply.result.value)}]},{role:"user",content:[{kind:"text",text:start.session.objective}]}];
      modelRequest();
    });return;
  }
  if(message?.kind==="kernel.reply"){
    const done=pending.get(message.reply.requestId);if(done){pending.delete(message.reply.requestId);done(message.reply)}return;
  }
  if(message?.kind==="kernel.event"){
    if(message.event.kind==="model.event")modelEvent(message.event.event);
    else if(message.event.kind==="harness.updated")currentHarnessId=message.event.update.activeHarnessId;
    else if(message.event.kind==="daemon.shutdown")finish("cancelled");
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{buffer+=chunk;for(;;){const newline=buffer.indexOf("\n");if(newline<0)return;const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);try{accept(JSON.parse(line))}catch(error){emit({kind:"runner.protocol-error",error:{kind:"protocol-error",protocol:"runner-jsonl",message:error instanceof Error?error.message:"invalid kernel JSONL",recoverable:false,callerAction:"abort"}})}}});`;

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
  { name: "skill.read", capabilities: [] },
  { name: "knowledge.write", capabilities: ["write-knowledge"] },
  { name: "marketplace.search", capabilities: [] },
  { name: "marketplace.install", capabilities: ["install-marketplace"] },
  { name: "harness.evolve", capabilities: ["create-harness-candidate"] },
  { name: "harness.status", capabilities: [] },
];

export const createInitialHarness: CreateInitialHarness = async (project, objects, _projects) => {
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
  const createdAt = project.createdAt as Timestamp;
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
  return { ok: true, value: { id: `harness_${stored.value}` as HarnessId, ...body } };
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
