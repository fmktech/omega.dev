import { createHash } from "node:crypto";

import type {
  ComponentId,
  ComponentManifest,
  HarnessError,
  HarnessId,
  HarnessManifest,
  HarnessRepository,
  JsonObject,
  JsonValue,
  ObjectHash,
  ObjectStore,
  Result,
  Timestamp,
} from "../contracts/index.js";

export const MINI_SWE_BASELINE_VERSION = "2.4.5";
const BASELINE_CREATED_AT = "2026-07-06T00:00:00.000Z" as Timestamp;

// This deliberately reproduces mini-swe-agent's defining harness choices rather
// than vendoring its Python package: linear message history, bash as the only
// tool, and a fresh subprocess for every action. Prompt structure follows the
// v2 documentation at https://mini-swe-agent.com/latest/advanced/yaml_configuration/.
export const MINI_SWE_BASELINE_RUNNER = String.raw`let buffer="",start=null,currentHarnessId=null,requestSequence=0,activeStream=null,formatErrors=0,toolCalls=new Map();
const pending=new Map();
const bashTool={name:"bash",description:"Execute a bash command in a fresh non-interactive subshell. Directory and environment changes do not persist, but workspace file changes do.",inputSchema:{type:"object",properties:{command:{type:"string"}},required:["command"],additionalProperties:false}};
let messages=[];
function emit(message){process.stdout.write(JSON.stringify({protocol:"omega-runner-jsonl",version:1,message})+"\n")}
function request(value,done){const requestId="runner-"+(++requestSequence);pending.set(requestId,done);emit({kind:"runner.request",request:{...value,requestId}})}
function finish(outcome){request({kind:"session.complete",outcome},()=>{process.exitCode=outcome==="succeeded"?0:1;setImmediate(()=>process.exit())})}
function modelRequest(){
  const route=start.session.initialModelRoutes.find(route=>route.role==="main-coder")||start.session.initialModelRoutes[0];
  request({kind:"model.start",request:{sessionId:start.session.id,harnessId:currentHarnessId,role:route?.role||"main-coder",messages,tools:[bashTool],maxOutputTokens:Math.min(Number(route?.outputLimit||32768),Number(start.session.capabilityEnvelope.maxOutputTokens)),abortAfterMs:Number(start.session.capabilityEnvelope.wallTimeMs)}},reply=>{
    if(!reply.result?.ok){finish("failed");return}
    activeStream=reply.result.value.streamId;toolCalls=new Map();
  });
}
function clipped(output){
  if(output.length<=10000)return {output};
  return {output_head:output.slice(0,5000),output_tail:output.slice(-5000),elided_chars:output.length-10000,warning:"Output too long."};
}
function observeProcess(processId,call,offset=0,output=""){
  request({kind:"process.observe",processId,after:[{stream:"stdout",offset},{stream:"stderr",offset:0}]},reply=>{
    if(!reply.result?.ok){completeTool(call,{returncode:-1,output:"",exception_info:reply.result?.error?.kind||"process observation failed"},true);return}
    const observation=reply.result.value;
    let nextOffset=offset,nextOutput=output;
    for(const slice of observation.slices||[]){
      if(slice.stream==="stdout")nextOffset=Math.max(nextOffset,Number(slice.range?.endExclusive||nextOffset));
      nextOutput+=String(slice.data||"");
    }
    if(observation.state==="starting"||observation.state==="running"){
      setTimeout(()=>observeProcess(processId,call,nextOffset,nextOutput),50);
      return;
    }
    const match=/\n?__OMEGA_MINI_RC__=(\d+)\s*$/u.exec(nextOutput);
    const returncode=match?Number(match[1]):-1;
    const clean=match?nextOutput.slice(0,match.index):nextOutput;
    completeTool(call,{returncode,...clipped(clean),exception_info:returncode<0?"process "+observation.state:""},returncode<0);
  });
}
function completeTool(call,result,isError){
  messages.push({role:"tool",content:[{kind:"tool-result",callId:call.callId,toolName:"bash",result,isError}]});
  modelRequest();
}
function executeCall(call){
  const command=String(call.input?.command||"");
  if(command.trim()==="echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"){finish("succeeded");return}
  const wrapped='bash -lc "$1" 2>&1; rc=$?; printf "\\n__OMEGA_MINI_RC__=%s\\n" "$rc"';
  request({kind:"process.start",spec:{executable:"bash",args:["-lc",wrapped,"omega-mini",command],cwd:start.workspace.path,credentialEnvNames:[],stdin:"closed",timeoutMs:60000,sandbox:{filesystem:"workspace-read-write",network:"none",allowedHosts:[],memoryLimitBytes:536870912,cpuTimeLimitMs:1800000,runtime:{kind:"oci",image:"omega-runner:local",expectedImageDigest:null,containerUser:"1000:1000",workspaceMountPath:"/workspace"}},harnessId:currentHarnessId,sessionId:start.session.id}},reply=>{
    if(!reply.result?.ok){completeTool(call,{returncode:-1,output:"",exception_info:reply.result?.error?.kind||"process start failed"},true);return}
    observeProcess(reply.result.value.id,call);
  });
}
function modelEvent(event){
  if(event.kind==="tool-call")toolCalls.set(event.call.callId,event.call);
  if(event.kind==="failed"){activeStream=null;finish("failed");return}
  if(event.kind!=="completed")return;
  if(activeStream!==null&&event.completion.streamId!==activeStream)return;
  activeStream=null;
  for(const part of event.completion.content)if(part.kind==="tool-call")toolCalls.set(part.callId,part);
  const calls=[...toolCalls.values()];
  if(calls.length===0){
    formatErrors+=1;
    messages.push({role:"assistant",content:event.completion.content});
    if(formatErrors>=3){finish("failed");return}
    messages.push({role:"user",content:[{kind:"text",text:'Every response must include at least one bash tool call. Call bash with {"command":"your_command_here"}. When finished, call bash with exactly: echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT'}]});
    modelRequest();return;
  }
  formatErrors=0;
  messages.push({role:"assistant",content:event.completion.content});
  executeCall(calls[0]);
}
function accept(envelope){
  if(envelope.protocol!=="omega-runner-jsonl"||envelope.version!==1)throw new Error("unsupported kernel envelope");
  const message=envelope.message;
  if(message?.kind==="kernel.start"){
    if(start!==null)throw new Error("duplicate kernel.start");
    start=message.start;currentHarnessId=start.harness.id;
    messages=[
      {role:"system",content:[{kind:"text",text:"You are a helpful assistant that can interact with a computer to solve programming tasks."}]},
      {role:"user",content:[{kind:"text",text:"Please solve this issue: "+start.session.objective+"\n\nYou can execute bash commands and edit files to implement the necessary changes. Work step by step: inspect the repository, make the smallest correct change, verify it, then finish by calling bash with exactly: echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\n\nCommand execution rules:\n- Every response must include at least one bash tool call.\n- Each command runs in a fresh non-interactive Linux subshell. Directory and environment changes do not persist.\n- Workspace file changes do persist.\n- Use non-interactive commands and inspect command output before continuing.\n- Do not combine the completion command with another command."}]}
    ];
    emit({kind:"runner.ready",harnessId:currentHarnessId});modelRequest();return;
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

export async function createMiniSweBaselineCandidate(
  incumbent: HarnessManifest,
  objects: ObjectStore,
  harnesses: Pick<HarnessRepository, "putComponent" | "putHarness">,
): Promise<Result<HarnessManifest, HarnessError>> {
  const payload = await putBytes(objects, "text/javascript", MINI_SWE_BASELINE_RUNNER);
  if (!payload.ok) return payload;

  const runnerBody: Omit<ComponentManifest, "id"> = {
    kind: "runner",
    runtime: "node",
    objectHash: payload.value,
    entrypoint: `inline-base64:${Buffer.from(MINI_SWE_BASELINE_RUNNER, "utf8").toString("base64")}`,
    credentialEnvNames: [],
    capabilities: ["model-call"],
  };
  const runner: ComponentManifest = {
    id: `component_${hash(canonical(componentBody(runnerBody)))}` as ComponentId,
    ...runnerBody,
  };
  const storedRunner = await harnesses.putComponent(runner);
  if (!storedRunner.ok) return storedRunner;

  const body = {
    projectId: incumbent.projectId,
    alias: `${incumbent.alias}+baseline:mini-swe-agent-v${MINI_SWE_BASELINE_VERSION}`,
    parents: [incumbent.id],
    components: [runner, ...incumbent.components.filter((component) => component.kind !== "runner")],
    sourceArtifacts: [...incumbent.sourceArtifacts],
    createdAt: BASELINE_CREATED_AT,
  } as const;
  const manifest: HarnessManifest = {
    id: `harness_${hash(canonical(harnessBody(body)))}` as HarnessId,
    ...body,
  };
  return harnesses.putHarness(manifest);
}

function componentBody(component: Omit<ComponentManifest, "id">): JsonObject {
  return {
    kind: component.kind,
    runtime: component.runtime,
    objectHash: component.objectHash,
    entrypoint: component.entrypoint,
    credentialEnvNames: [...component.credentialEnvNames],
    capabilities: [...component.capabilities],
  };
}

function harnessBody(manifest: Omit<HarnessManifest, "id">): JsonObject {
  return {
    projectId: manifest.projectId,
    alias: manifest.alias,
    parents: [...manifest.parents],
    components: manifest.components.map((component) => ({ id: component.id, ...componentBody(component) })),
    sourceArtifacts: [...manifest.sourceArtifacts],
    createdAt: manifest.createdAt,
  };
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as JsonObject;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key] ?? null)}`).join(",")}}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function putBytes(objects: ObjectStore, mediaType: string, source: string): Promise<Result<ObjectHash, HarnessError>> {
  async function* chunks(): AsyncIterable<Uint8Array> { yield Buffer.from(source, "utf8"); }
  const stored = await objects.put(mediaType, chunks());
  return stored.ok ? { ok: true, value: stored.value.hash } : stored;
}
