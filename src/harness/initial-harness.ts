import type {
  CapabilityKind,
  ComponentId,
  ComponentManifest,
  CreateInitialHarness,
  HarnessError,
  HarnessId,
  JsonObject,
  JsonValue,
  HarnessManifest,
  HarnessRepository,
  ObjectHash,
  ObjectStore,
  Result,
  Timestamp,
} from "../contracts/index.js";

const INITIAL_MODEL_TOOLS = [
  { name: "artifact.read", description: "Read a supplied session evidence artifact by ID with byte-range paging.", inputSchema: { type: "object", properties: { artifactId: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 } }, required: ["artifactId"], additionalProperties: false } },
  { name: "file.read", description: "Read a UTF-8 workspace file and return content plus its SHA-256 interlock.", inputSchema: { type: "object", properties: { path: { type: "string", description: "Repository-relative POSIX path" } }, required: ["path"], additionalProperties: false } },
  { name: "file.write", description: "Create or replace a UTF-8 file. Pass the exact SHA from file.read when replacing; for a new file pass JSON null, never the string 'null'. A stale SHA is rejected.", inputSchema: { type: "object", properties: { path: { type: "string" }, expectedSha: { type: ["string", "null"], description: "Exact SHA-256 from file.read, or JSON null for a new file" }, content: { type: "string" } }, required: ["path", "expectedSha", "content"], additionalProperties: false } },
  { name: "process.start", description: "Start one isolated workspace process. Network defaults to none. Use process.observe to stream output and state.", inputSchema: { type: "object", properties: { executable: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, stdin: { enum: ["pipe", "closed"] }, timeoutMs: { type: ["integer", "null"] } }, required: ["executable", "args"], additionalProperties: false } },
  { name: "process.observe", description: "Observe process state and output after byte offsets for stdout and stderr.", inputSchema: { type: "object", properties: { processId: { type: "string" }, after: { type: "array", items: { type: "object", properties: { stream: { enum: ["stdout", "stderr"] }, offset: { type: "integer", minimum: 0 } }, required: ["stream", "offset"], additionalProperties: false } } }, required: ["processId", "after"], additionalProperties: false } },
  { name: "process.input", description: "Write stdin, close stdin, or send a signal to a running process. Use exactly one typed input variant.", inputSchema: { type: "object", properties: { processId: { type: "string" }, input: { oneOf: [
    { type: "object", properties: { kind: { const: "data" }, encoding: { enum: ["utf8", "base64"] }, data: { type: "string" } }, required: ["kind", "encoding", "data"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "close-stdin" } }, required: ["kind"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "signal" }, signal: { enum: ["SIGINT", "SIGTERM", "SIGHUP"] } }, required: ["kind", "signal"], additionalProperties: false },
  ] } }, required: ["processId", "input"], additionalProperties: false } },
  { name: "process.cancel", description: "Stop a running process and preserve its stdout/stderr artifacts.", inputSchema: { type: "object", properties: { processId: { type: "string" }, reason: { type: "string" } }, required: ["processId", "reason"], additionalProperties: false } },
  { name: "subagent.spawn", description: "Spawn an attenuated child session for a bounded subtask.", inputSchema: { type: "object", properties: { role: { type: "string" }, objective: { type: "string" }, contextArtifactIds: { type: "array", items: { type: "string" } }, capabilityEnvelope: { type: "object" } }, required: ["role", "objective", "contextArtifactIds", "capabilityEnvelope"], additionalProperties: false } },
  { name: "subagent.observe", description: "Read the current state of a child session.", inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"], additionalProperties: false } },
  { name: "knowledge.catalog", description: "Search short project-knowledge summaries before opening a full document.", inputSchema: { type: "object", properties: { text: { type: "string" }, tags: { type: "array", items: { type: "string" } }, relevantPaths: { type: "array", items: { type: "string" } }, limit: { type: "integer", minimum: 1 } }, required: ["text", "tags", "relevantPaths", "limit"], additionalProperties: false } },
  { name: "knowledge.read", description: "Open one full project-knowledge document by ID.", inputSchema: { type: "object", properties: { documentId: { type: "string" } }, required: ["documentId"], additionalProperties: false } },
  { name: "skill.read", description: "Open one installed project skill by component ID only after checking its catalog. A task matching any doesNotApplyWhen cue is a hard exclusion: never read that skill, even if positive cues also match.", inputSchema: { type: "object", properties: { componentId: { type: "string" } }, required: ["componentId"], additionalProperties: false } },
  { name: "knowledge.write", description: "Persist verified project knowledge. The runner injects the current project, session, and verification time. For a new document pass JSON null, never the string 'null'.", inputSchema: { type: "object", properties: { document: { type: "object", properties: { frontmatter: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, tags: { type: "array", items: { type: "string" } }, confidence: { type: "number", minimum: 0, maximum: 1 }, sourceArtifactIds: { type: "array", items: { type: "string" } }, relevantPaths: { type: "array", items: { type: "string" } }, invalidationConditions: { type: "array", items: { type: "string" } } }, required: ["id", "title", "summary", "tags", "confidence", "relevantPaths", "invalidationConditions"], additionalProperties: false }, markdown: { type: "string" } }, required: ["frontmatter", "markdown"], additionalProperties: false }, expectedSha: { type: ["string", "null"], description: "Exact current SHA-256, or JSON null for a new document" } }, required: ["document", "expectedSha"], additionalProperties: false } },
  { name: "marketplace.search", description: "Search locally created and vetted harness parts.", inputSchema: { type: "object", properties: { text: { type: "string" }, kinds: { type: "array", items: { type: "string" } }, states: { type: "array", items: { type: "string" } }, limit: { type: "integer", minimum: 1 } }, required: ["text", "kinds", "states", "limit"], additionalProperties: false } },
  { name: "marketplace.install", description: "Create a project-scoped candidate from a trusted local marketplace artifact.", inputSchema: { type: "object", properties: { artifactId: { type: "string" } }, required: ["artifactId"], additionalProperties: false } },
  { name: "harness.evolve", description: "Crystallize reusable session evidence into a bounded harness candidate. Skill-only requests independently synthesize a hidden three-fixture promotion suite.", inputSchema: { type: "object", properties: { goal: { type: "string" }, evidenceArtifactIds: { type: "array", items: { type: "string" } }, allowedComponentKinds: { type: "array", items: { type: "string" } }, budget: { type: "object" }, evaluationMode: { enum: ["development-suite", "synthetic-skill-suite"] } }, required: ["goal", "evidenceArtifactIds", "allowedComponentKinds", "budget"], additionalProperties: false } },
  { name: "harness.status", description: "Read the project's currently active harness manifest.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
] as const;

const INITIAL_RUNNER = String.raw`let buffer="",start=null,currentHarnessId=null,requestSequence=0,activeStream=null,toolCalls=new Map(),modelFailureRetries=0;
const MAX_MODEL_FAILURE_RETRIES=2;
const pending=new Map();
const skillCache=new Map();
const excludedSkillIds=new Set();
const eligibleSkillIds=new Set();
const tools=${JSON.stringify(INITIAL_MODEL_TOOLS)};
let messages=[];
function emit(message){process.stdout.write(JSON.stringify({protocol:"omega-runner-jsonl",version:1,message})+"\n")}
function request(value,done){const requestId="runner-"+(++requestSequence);pending.set(requestId,done);emit({kind:"runner.request",request:{...value,requestId}})}
function finish(outcome){request({kind:"session.complete",outcome},()=>{process.exitCode=outcome==="succeeded"?0:1;setImmediate(()=>process.exit())})}
function bootstrapPrompt(value){
  const instructions=value.instructions.map(item=>"Instruction file: "+item.path+"\nScope: "+item.scope+"\nSHA-256: "+item.sha+"\n"+item.content).join("\n\n");
  const catalogs=JSON.stringify({projectKnowledge:value.knowledgeCatalog,installedSkills:value.skillCatalog});
  const workspaceFiles=Array.isArray(value.workspaceFiles)?value.workspaceFiles:[];
  const inventory=JSON.stringify({files:workspaceFiles,truncated:value.workspaceInventoryTruncated===true});
  return "You are omega.dev's initial SWE runner. Use file SHA interlocks, isolated processes, and authoritative project verification. Preserve unrelated work. Continue until the objective is complete and verified; if a tool reports stale-read, re-read, merge, and retry.\n\nWorkspace and process protocol:\n- file.read accepts files, not directories, and every file path is repository-relative. The authoritative session-start workspace inventory below replaces initial find/ls/dir discovery. If truncated is false, do not run a process merely to list the tree. Refresh only paths you create yourself.\n- Omit process cwd for the repository root. The host path is mounted automatically; the sandbox sees that same repository at /workspace. Never probe / or /home/user to discover the project.\n- process.start returns a handle, never command output. After every process.start, call process.observe with the exact returned processId and stdout/stderr offsets 0 before starting another process. If it is still running, observe again using the returned end offsets. Use output only after observing a terminal state.\n- Separate process.start calls do not share localhost because each runs in its own isolated network namespace. For an HTTP/component verifier, start the server, issue requests, assert, and close the server inside one process (for Node: server.listen(0), built-in fetch, then server.close). Never start a server in one process and curl it from another.\n\nAuthoritative session-start workspace inventory:\n"+inventory+"\n\nRepository instructions are ordered from root to deeper scopes. Apply every instruction governing a path; a deeper AGENTS.md overrides its parent only where they conflict.\n\n"+(instructions||"No AGENTS.md files were discovered.")+"\n\nCompact durable-context catalogs:\n"+catalogs+"\n\nBefore acting, inspect these catalogs. Evaluate skill applicability negative-first: if the objective matches any doesNotApplyWhen cue, that skill is a hard exclusion and you must not call skill.read for it, even when an appliesWhen cue, tag, path, runtime, or keyword also matches. Only after eliminating excluded skills may you read one whose positive cues fit the objective. Read an immutable skill at most once per session. When a knowledge entry may be relevant, call knowledge.read. Do not infer omitted procedures from a summary.";
}
function normalizedToken(value){
  const token=String(value).toLowerCase().replace(/[^a-z0-9]+/g,"");
  if(token.startsWith("authenticat")||token.startsWith("authoriz")||token==="auth")return "auth";
  if(token.startsWith("install"))return "install";
  if(token==="frameworks")return "framework";
  if(token==="databases")return "database";
  if(token==="packages"||token==="dependencies"||token==="dependency")return "dependency";
  return token.replace(/s$/,"");
}
function cueTokens(value){return [...new Set(String(value).split(/[^A-Za-z0-9]+/).map(normalizedToken).filter(token=>(token.length>=4||/^\d{3}$/.test(token))&&!new Set(["with","when","need","using","another","required","existing","codebase","different"]).has(token)))];}
function affirmedCueTokens(value){
  const selected=[];
  for(const clause of String(value).split(/[.,;:!?]|\bbut\b|\bhowever\b/i)){
    const words=clause.split(/[^A-Za-z0-9]+/).filter(Boolean),normalized=words.map(normalizedToken);
    for(let index=0;index<normalized.length;index+=1){
      const token=normalized[index];
      if(!token||token.length<4||new Set(["with","when","need","using","another","required","existing","codebase","different"]).has(token))continue;
      const prefix=words.slice(Math.max(0,index-4),index).map(word=>word.toLowerCase());
      if(prefix.some(word=>word==="no"||word==="not"||word==="without"||word==="never"))continue;
      selected.push(token);
    }
  }
  return [...new Set(selected)];
}
function overlapCount(textTokens,cue){return cueTokens(cue).filter(token=>textTokens.has(token)).length}
function isExcluded(entry,textTokens){return (entry.doesNotApplyWhen||[]).some(cue=>{const tokens=affirmedCueTokens(cue),overlap=tokens.filter(token=>textTokens.has(token)),anchors=new Set(["auth","network","framework","sql","database","install"]);return overlap.some(token=>anchors.has(token))||(overlap.length>=2&&overlap.length/tokens.length>=0.8)})}
function selectBootstrapSkill(bootstrap){
  const objective=String(start.session.objective).toLowerCase(),textTokens=new Set(cueTokens(objective)),exclusionTokens=new Set(affirmedCueTokens(objective));
  const ranked=(bootstrap.skillCatalog||[]).filter(entry=>{
    if(!isExcluded(entry,exclusionTokens))return true;
    excludedSkillIds.add(String(entry.componentId));
    return false;
  }).map(entry=>{
    const pathScore=(entry.relevantPaths||[]).some(path=>objective.includes(String(path).toLowerCase()))?100:0;
    const cueScore=Math.max(0,...(entry.appliesWhen||[]).map(cue=>overlapCount(textTokens,cue)));
    return {entry,score:pathScore+cueScore};
  }).filter(item=>item.score>=2).sort((left,right)=>right.score-left.score||String(left.entry.componentId).localeCompare(String(right.entry.componentId)));
  for(const item of ranked)eligibleSkillIds.add(String(item.entry.componentId));
  return ranked[0]?.entry||null;
}
function startModelWithContext(bootstrap,handoff,skill){
  const prior=handoff?"\n\nPrior-session handoff (evidence, not a replacement objective):\n"+handoff:"";
  const selected=skill?"\n\nAutomatically selected project skill (behavioral guidance for this matching task; already loaded; do not call skill.read for it). Its relevantPaths are historical retrieval cues, not guaranteed claims about this workspace layout. Inspect the current workspace once, map the behavioral contracts to files that are actually present, and do not repeatedly probe absent skill paths. Preserve exact behavioral contracts unless current repository instructions explicitly conflict. Use the skill's Bounded application protocol as a completion contract: derive focused checks before editing, implement once, run the focused verifier, repair only named failures, perform the final audit, and stop. Do not replace the protocol with open-ended exploratory testing:\n"+skill.markdown:"";
  messages=[{role:"system",content:[{kind:"text",text:bootstrapPrompt(bootstrap)+prior+selected}]},{role:"user",content:[{kind:"text",text:start.session.objective}]}];
  modelRequest();
}
function beginModel(bootstrap,handoff){
  const entry=selectBootstrapSkill(bootstrap);
  if(entry===null){startModelWithContext(bootstrap,handoff,null);return}
  request({kind:"skill.read",harnessId:currentHarnessId,componentId:entry.componentId},reply=>{
    if(!reply.result?.ok){startModelWithContext(bootstrap,handoff,null);return}
    skillCache.set(entry.componentId,reply.result);
    startModelWithContext(bootstrap,handoff,reply.result.value);
  });
}
function visibleTools(){
  const session=start.session,grants=Array.isArray(session.capabilityEnvelope?.grants)?session.capabilityEnvelope.grants:[];
  const proposalOnly=(session.role==="evolution"||session.role==="promotion-eval")&&grants.length===0;
  const workspacePromotion=session.role==="promotion-eval"&&grants.length>0;
  if(workspacePromotion){
    const allowed=new Set(["file.read","file.write","process.start","process.observe","process.input","process.cancel"]);
    return tools.filter(tool=>allowed.has(tool.name));
  }
  if(!proposalOnly)return tools;
  const evidence=session.continuation?.contextArtifactIds;
  return Array.isArray(evidence)&&evidence.length>0?tools.filter(tool=>tool.name==="artifact.read"):[];
}
function modelRequest(){
  const route=start.session.initialModelRoutes.find(route=>route.role==="main-coder")||start.session.initialModelRoutes[0];
  request({kind:"model.start",request:{sessionId:start.session.id,harnessId:currentHarnessId,role:route?.role||"main-coder",messages,tools:visibleTools(),maxOutputTokens:Math.min(Number(route?.outputLimit||32768),Number(start.session.capabilityEnvelope.maxOutputTokens)),abortAfterMs:Number(start.session.capabilityEnvelope.wallTimeMs)}},reply=>{
    if(!reply.result?.ok){if(reply.result?.error?.recoverable===true&&modelFailureRetries<MAX_MODEL_FAILURE_RETRIES){modelFailureRetries+=1;modelRequest();return}finish("failed");return}
    activeStream=reply.result.value.streamId;toolCalls=new Map();
  });
}
function normalizeProcessInput(value){
  if(value&&typeof value==="object"){
    if(value.kind==="data"||value.kind==="close-stdin"||value.kind==="signal")return value;
    if(typeof value.stdin==="string")return {kind:"data",encoding:"utf8",data:value.stdin};
    if(value.close===true)return {kind:"close-stdin"};
  }
  return value;
}
function toolRequest(call){
  const input=call.input||{},session=start.session,workspace=start.workspace;
  switch(call.toolName){
    case "artifact.read":return {kind:"artifact.read",artifactId:input.artifactId,offset:Number(input.offset||0),limit:Number(input.limit||65536)};
    case "file.read":return {kind:"file.read",workspaceId:workspace.id,path:input.path};
    case "file.write":return {kind:"file.write",request:{sessionId:session.id,workspaceId:workspace.id,path:input.path,expectedSha:input.expectedSha==="null"?null:input.expectedSha??null,content:String(input.content??"")}};
    case "process.start":return {kind:"process.start",spec:{executable:String(input.executable??""),args:Array.isArray(input.args)?input.args.map(String):[],cwd:input.cwd||workspace.path,credentialEnvNames:Array.isArray(input.credentialEnvNames)?input.credentialEnvNames:[],stdin:input.stdin==="closed"?"closed":"pipe",timeoutMs:input.timeoutMs??null,sandbox:input.sandbox||{filesystem:"workspace-read-write",network:"none",allowedHosts:[],memoryLimitBytes:536870912,cpuTimeLimitMs:1800000,runtime:{kind:"oci",image:"omega-runner:local",expectedImageDigest:null,containerUser:"1000:1000",workspaceMountPath:"/workspace"}},harnessId:currentHarnessId,sessionId:session.id}};
    case "process.observe":return {kind:"process.observe",processId:input.processId,after:Array.isArray(input.after)?input.after:[]};
    case "process.input":return {kind:"process.input",processId:input.processId,input:normalizeProcessInput(input.input)};
    case "process.cancel":return {kind:"process.cancel",processId:input.processId,reason:String(input.reason||"cancelled by agent")};
    case "subagent.spawn":return {kind:"child.spawn",request:{...input,parentSessionId:session.id}};
    case "subagent.observe":return {kind:"child.observe",sessionId:input.sessionId};
    case "knowledge.catalog":return {kind:"knowledge.catalog",query:{...input,projectId:session.projectId}};
    case "knowledge.read":return {kind:"knowledge.read",documentId:input.documentId};
    case "skill.read":return {kind:"skill.read",harnessId:currentHarnessId,componentId:input.componentId};
    case "knowledge.write":{const document=input.document||{},frontmatter=document.frontmatter||{};return {kind:"knowledge.write",request:{projectId:session.projectId,expectedSha:input.expectedSha==="null"?null:input.expectedSha??null,document:{projectId:session.projectId,markdown:String(document.markdown??""),frontmatter:{...frontmatter,verifiedAt:new Date().toISOString(),sourceSessionIds:[session.id],sourceArtifactIds:Array.isArray(frontmatter.sourceArtifactIds)?frontmatter.sourceArtifactIds:[]}}}}}
    case "marketplace.search":return {kind:"marketplace.search",query:input};
    case "marketplace.install":return {kind:"marketplace.install",artifactId:input.artifactId};
    case "harness.evolve":{const skillOnly=Array.isArray(input.allowedComponentKinds)&&input.allowedComponentKinds.length===1&&input.allowedComponentKinds[0]==="skill";return {kind:"harness.evolve",request:{...input,evaluationMode:input.evaluationMode||(skillOnly?"synthetic-skill-suite":"development-suite"),projectId:session.projectId,sourceSessionId:session.id}}}
    case "harness.status":return {kind:"harness.status",projectId:session.projectId};
    default:return null;
  }
}
function runTools(calls,index=0,results=[]){
  if(index>=calls.length){messages.push({role:"assistant",content:calls});messages.push({role:"tool",content:results});modelRequest();return}
  const call=calls[index],mapped=toolRequest(call);
  if(!mapped){results.push({kind:"tool-result",callId:call.callId,toolName:call.toolName,result:{error:"unsupported tool"},isError:true});runTools(calls,index+1,results);return}
  const skillKey=call.toolName==="skill.read"&&typeof call.input?.componentId==="string"?call.input.componentId:null;
  if(skillKey!==null&&excludedSkillIds.has(skillKey)){results.push({kind:"tool-result",callId:call.callId,toolName:call.toolName,result:{ok:false,error:{kind:"validation",message:"Skill is excluded by doesNotApplyWhen for this session objective",field:"skill.componentId",recoverable:true,callerAction:"fix-input"}},isError:true});runTools(calls,index+1,results);return}
  if(skillKey!==null&&!eligibleSkillIds.has(skillKey)){results.push({kind:"tool-result",callId:call.callId,toolName:call.toolName,result:{ok:false,error:{kind:"validation",message:"Skill did not pass positive applicability for this session objective",field:"skill.componentId",recoverable:true,callerAction:"fix-input"}},isError:true});runTools(calls,index+1,results);return}
  if(skillKey!==null&&skillCache.has(skillKey)){results.push({kind:"tool-result",callId:call.callId,toolName:call.toolName,result:skillCache.get(skillKey),isError:false});runTools(calls,index+1,results);return}
  request(mapped,reply=>{const result=reply.result??reply,isError=reply.result?.ok===false||reply.kind==="request.rejected";if(skillKey!==null&&!isError)skillCache.set(skillKey,result);results.push({kind:"tool-result",callId:call.callId,toolName:call.toolName,result,isError});runTools(calls,index+1,results)});
}
function modelEvent(event){
  if(event.kind==="tool-call")toolCalls.set(event.call.callId,event.call);
  if(event.kind==="failed"){if(activeStream!==null&&event.streamId!==activeStream)return;activeStream=null;if(event.error?.recoverable===true&&modelFailureRetries<MAX_MODEL_FAILURE_RETRIES){modelFailureRetries+=1;modelRequest();return}finish("failed");return}
  if(event.kind!=="completed")return;
  if(activeStream!==null&&event.completion.streamId!==activeStream)return;
  activeStream=null;modelFailureRetries=0;
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
      const bootstrap=reply.result.value;
      if(start.handoffArtifactId===null){beginModel(bootstrap,null);return}
      request({kind:"artifact.read",artifactId:start.handoffArtifactId,offset:0,limit:65536},handoffReply=>{
        if(!handoffReply.result?.ok){finish("failed");return}
        const slice=handoffReply.result.value;
        beginModel(bootstrap,String(slice.data||""));
      });
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
  { name: "artifact.read", capabilities: [] },
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
  const runner = await materializeInitialRunner(objects);
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

/** Materialize and persist a direct descendant that adopts this daemon's built-in runner. */
export async function createInitialRunnerUpgrade(
  incumbent: HarnessManifest,
  objects: ObjectStore,
  harnesses: HarnessRepository,
  createdAt: Timestamp,
): Promise<Result<HarnessManifest, HarnessError>> {
  const runner = await materializeInitialRunner(objects);
  if (!runner.ok) return runner;
  const incumbentRunner = incumbent.components.find((component) => component.kind === "runner");
  if (incumbentRunner?.id === runner.value.id) {
    return conflict("built-in-runner", "different-component", runner.value.id);
  }
  const body = {
    projectId: incumbent.projectId,
    alias: `${incumbent.alias}+runner-${runner.value.id.slice(-8)}`,
    parents: [incumbent.id],
    components: [runner.value, ...incumbent.components.filter((component) => component.kind !== "runner")],
    sourceArtifacts: [...incumbent.sourceArtifacts],
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
  if (!stored.ok) return stored;
  return harnesses.putHarness({ id: `harness_${stored.value}` as HarnessId, ...body });
}

async function materializeInitialRunner(objects: ObjectStore): Promise<Result<ComponentManifest, HarnessError>> {
  const runnerPayload = await putBytes(objects, "application/javascript", INITIAL_RUNNER);
  if (!runnerPayload.ok) return runnerPayload;
  return materializeComponent(objects, {
    kind: "runner",
    runtime: "node",
    objectHash: runnerPayload.value,
    entrypoint: `inline-base64:${Buffer.from(INITIAL_RUNNER, "utf8").toString("base64")}`,
    credentialEnvNames: [],
    capabilities: ["model-call"],
  });
}

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
