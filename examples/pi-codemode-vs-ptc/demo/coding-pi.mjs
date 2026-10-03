import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pi,ai} from './pi-runtime.mjs';
import {createDeepSeekStream,safeError} from './deepseek.mjs';
import {CODING_PROMPT,CODING_TASK,evaluateCoding} from './coding-fixture.mjs';
const base=fileURLToPath(new URL('./',import.meta.url));
const bytes=x=>Buffer.byteLength(JSON.stringify(x));
const copy=x=>JSON.parse(JSON.stringify(x));
export async function runCodingPi(options){
 const start=performance.now(),requests=[],responses=[],calls=[],pending=new Map();let active=0,peak=0;
 const agentDir=join(options.projectRoot,'.agent');await mkdir(agentDir,{recursive:true});
 const config=options.testConfig;
 const settingsManager=pi.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},defaultTools:['codemode'],cacheWarming:{enabled:false}});
 const modelRuntime=await pi.ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:null,modelsStorePath:join(agentDir,'models-cache.json'),refreshOnCreate:false});
 modelRuntime.registerProvider('demo-deepseek',{name:'DeepSeek online',api:'openai-completions',baseUrl:config.baseUrl,apiKey:'local-transport-placeholder',streamSimple:createDeepSeekStream({config,requests,responses,maxRequests:24,deadlineMs:600000}),models:[{id:config.model,name:config.model,api:'openai-completions',input:['text'],reasoning:false,contextWindow:1000000,maxTokens:6000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});
 const runtimePrompt=' Use codemode scripts to discover and call the project tools. searchTools(), describeTool(), and tools.<name>() are asynchronous: await them. searchTools(query,{limit,namespace}) returns an array of {name,description}. describeTool(name) returns input/output declarations. MCP results are CallToolResult wrappers: check isError then unwrap structuredContent ?? JSON.parse(content.find(b=>b.type==="text").text). text() is synchronous. Expose relevant source and diagnostics to yourself when needed; do not discard source necessary for correct edits. You may use multiple scripts and test/fix cycles. No fixed stage or model round count is prescribed.';
 const discoveryPrompt=' This is the interface-discovery stage for the coding task. Use ONE codemode call, await ONE combined searchTools query for listing/searching/reading/editing project files and running tests, namespace:"coding", limit:5. Return the five distinct exact tool names using text({selectedTools:names}). Print only that JSON object. Do not execute project tools. Host lookup and official SDK generation will prepare subsequent PTC execution. Do not guess identifiers.';
 const loader=new pi.DefaultResourceLoader({cwd:options.projectRoot,agentDir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:CODING_PROMPT+(options.discoveryOnly?discoveryPrompt:runtimePrompt),extensionFactories:[
  pi.createCodemodeExtension({mode:'only',models:false}),
  pi.createMcpExtension({loadConfig:()=>({servers:[{name:'coding',scope:'extension',source:'demo',config:{command:process.execPath,args:[join(base,'coding-mcp-server.mjs'),options.projectRoot,String(options.count)],exposure:'codemode',description:'Isolated TypeScript project file search, reads, text edits and build/behavior tests.'}}],errors:[]}),logPath:join(agentDir,'mcp.log')}),
  api=>{
   api.on('tool_call',e=>{
    if(!e.toolName.startsWith('mcp__coding__'))return;
    if(options.discoveryOnly)return {block:true,reason:'Discovery cannot execute project tools'};
    if(calls.length>=300)return {block:true,reason:'Coding tool call limit'};
    active++;peak=Math.max(peak,active);const call={id:e.toolCallId,name:e.toolName,arguments:copy(e.input),parentToolCallId:e.parentToolCallId??null,startMs:Math.round(performance.now()-start)};calls.push(call);pending.set(e.toolCallId,call);
   });
   api.on('tool_result',e=>{const c=pending.get(e.toolCallId);if(!c)return;active--;pending.delete(e.toolCallId);Object.assign(c,{endMs:Math.round(performance.now()-start),result:copy(e.content),rawResultBytes:bytes(e.content),isError:e.isError??false});});
  },
 ]});
 await loader.reload();if(loader.getExtensions().errors.length)throw Error(JSON.stringify(loader.getExtensions().errors));
 const {session}=await pi.createAgentSession({cwd:options.projectRoot,agentDir,modelRuntime,model:modelRuntime.getModel('demo-deepseek',config.model),thinkingLevel:'off',settingsManager,resourceLoader:loader,noTools:'builtin',sessionManager:pi.SessionManager.inMemory(options.projectRoot)});
 let error=null;
 try{
  await session.bindExtensions({});session.agent.toolExecution='parallel';
  if(options.discoveryOnly)session.agent.subscribe(e=>{if(e.type==='tool_execution_end'&&e.toolName==='codemode')session.agent.abort();});
  const timer=setTimeout(()=>session.agent.abort(),600000);
  try{await session.prompt(CODING_TASK);}catch(e){error=safeError(e,config);}finally{clearTimeout(timer);}
  const messages=copy(session.messages);let selectedTools=[];
  if(options.discoveryOnly){for(const m of messages.filter(m=>m.role==='toolResult'))for(const b of m.content.filter(b=>b.type==='text'))try{const parsed=JSON.parse(b.text);const values=Array.isArray(parsed)?parsed:parsed.selectedTools; if(Array.isArray(values))selectedTools=[...new Set(values.map(t=>typeof t==='string'?t:t?.name))];}catch{}}
  const validation=options.discoveryOnly?{passed:requests.length===1&&calls.length===0&&selectedTools.length===5&&messages.filter(m=>m.role==='toolResult').every(m=>!m.isError)}:await evaluateCoding(options.projectRoot,options.count);
  if(!requests.length||requests.some(r=>!r.apiUsage))validation.passed=false;
  const sum=k=>requests.every(r=>r.apiUsage)?requests.reduce((s,r)=>s+(r.apiUsage[k]??0),0):null;
  return {mode:options.discoveryOnly?'discovery':'codemode',requests,responses,calls,messages,selectedTools,validation,error,finalText:session.getLastAssistantText()??'',metrics:{modelRequests:requests.length,inputTokens:sum('prompt_tokens'),outputTokens:sum('completion_tokens'),cacheHitTokens:sum('prompt_cache_hit_tokens'),modelWallMs:requests.reduce((s,r)=>s+(r.modelWallMs??0),0),wireRequestBytes:requests.reduce((s,r)=>s+(r.wireBytes??0),0),rawMcpResultBytes:calls.reduce((s,c)=>s+(c.rawResultBytes??0),0),mcpCalls:calls.length,peakMcpConcurrency:Math.min(8,peak),peakSubmittedCalls:peak,surfacedResultBytes:messages.filter(m=>m.role==='toolResult').reduce((s,m)=>s+bytes(m.content),0),localWallMs:Math.round(performance.now()-start)}};
 }finally{await session.extensionRunner.emit({type:'session_shutdown',reason:'exit'});session.dispose();}
}
