import {runCodingPi} from './coding-pi.mjs';
import {runCodingPtc} from './coding-ptc.mjs';
import {CODING_TASK,codingCatalog} from './coding-fixture.mjs';
import {ai} from './pi-runtime.mjs';
export async function runCodingHybrid(options){
 const start=performance.now();const discovery=await runCodingPi({...options,discoveryOnly:true});
 const selectedTools=discovery.selectedTools;
 const expected=codingCatalog.map(t=>'mcp__coding__'+t.name).sort();
 if(!discovery.validation.passed||JSON.stringify([...selectedTools].sort())!==JSON.stringify(expected))return {mode:'hybrid',discovery,requests:discovery.requests,calls:[],metrics:discovery.metrics,validation:{passed:false},error:'Invalid discovery selection'};
 const response=discovery.responses[0],result=discovery.messages.find(m=>m.role==='toolResult'&&m.toolName==='codemode');
 const handoffMessages=[{role:'user',content:CODING_TASK},{role:'assistant',content:ai.contentText(response.content)||null,tool_calls:response.content.filter(b=>b.type==='toolCall').map(b=>({id:b.id,type:'function',function:{name:b.name,arguments:JSON.stringify(b.arguments)}}))},{role:'tool',tool_call_id:result.toolCallId,content:ai.contentText(result.content)}];
 const execution=await runCodingPtc({...options,selectedTools,handoffMessages});
 const requests=[...discovery.requests,...execution.requests].map((r,i)=>({...r,round:i+1,phase:i?'ptc-execution':'codemode-discovery'}));
 const metrics={...execution.metrics,modelRequests:requests.length,externalLlmRequests:requests.length,localWallMs:Math.round(performance.now()-start),surfacedResultBytes:discovery.metrics.surfacedResultBytes+(execution.metrics.surfacedResultBytes??0)};
 for(const [f,k]of [['inputTokens','prompt_tokens'],['outputTokens','completion_tokens'],['cacheHitTokens','prompt_cache_hit_tokens']])metrics[f]=requests.every(r=>r.apiUsage)?requests.reduce((s,r)=>s+(r.apiUsage[k]??0),0):null;
 metrics.modelWallMs=requests.reduce((s,r)=>s+(r.modelWallMs??0),0);metrics.wireRequestBytes=requests.reduce((s,r)=>s+(r.wireBytes??0),0);
 return {...execution,mode:'hybrid',execution,discovery,selectedTools,handoffMessages,requests,metrics};
}
