import { runMode } from './engine.mjs';
import { runPtc } from './ptc.mjs';
import { ai } from './pi-runtime.mjs';
export async function runHybrid(options={}) {
  const started=performance.now();
  const discovery=await runMode('codemode',{...options,discoveryOnly:true});
  if(!discovery.validation.passed) return {mode:'hybrid',discovery,validation:{passed:false},error:'Discovery/handoff validation failed',metrics:discovery.metrics,requests:discovery.requests,calls:[]};
  const selectedTools=discovery.selectedTools;
  const first=discovery.responses[0];
  const tools=first.content.filter(c=>c.type==='toolCall').map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.arguments)}}));
  const result=discovery.messages.find(m=>m.role==='toolResult'&&m.toolName==='codemode');
  const handoffMessages=[{role:'user',content:discovery.requests[0].wirePayload.messages.find(m=>m.role==='user').content},{role:'assistant',content:ai.contentText(first.content)||null,tool_calls:tools},{role:'tool',tool_call_id:result.toolCallId,content:ai.contentText(result.content)}];
  const execution=await runPtc({...options,selectedTools,handoffMessages});
  const requests=[...discovery.requests,...execution.requests].map((r,i)=>({...r,round:i+1,phase:i===0?'codemode-discovery':'ptc-execution'}));
  const metrics={...execution.metrics,modelRequests:requests.length,externalLlmRequests:requests.length,localWallMs:Math.round(performance.now()-started),initialToolDeclarationBytes:discovery.requests[0].wirePayload.tools?Buffer.byteLength(JSON.stringify(discovery.requests[0].wirePayload.tools)):0,surfacedResultBytes:discovery.metrics.surfacedResultBytes+execution.metrics.surfacedResultBytes};
  for(const [f,v] of [['inputTokens','prompt_tokens'],['outputTokens','completion_tokens'],['cacheHitTokens','prompt_cache_hit_tokens']]) metrics[f]=requests.every(r=>r.apiUsage)?requests.reduce((s,r)=>s+(r.apiUsage[v]??0),0):null;
  for(const [f,v] of [['wireRequestBytes','wireBytes'],['modelWallMs','modelWallMs'],['accumulatedRequestBytes','bytes']]) metrics[f]=requests.reduce((s,r)=>s+(r[v]??0),0);
  return {...execution,mode:'hybrid',requests,metrics,discovery,selectedTools,handoffMessages,execution,validation:{...execution.validation,passed:discovery.validation.passed&&execution.validation.passed,discoveryPassed:discovery.validation.passed,selectedToolsValid:true}};
}
