// Render the unified article from frozen summaries; never rewrite experiment evidence.
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url);
const [order,hybrid,coding]=await Promise.all(['matrix','hybrid','coding'].map(async name=>JSON.parse(await readFile(new URL(`results/${name}/summary.json`,root),'utf8'))));
assert.equal(order.attempts,108);assert.equal(order.passed,108);
assert.equal(hybrid.tasks,81);assert.equal(hybrid.passed,81);
assert.equal(coding.tasks,27);assert.equal(coding.passed,24);
const n=x=>x.toLocaleString('en-US');
const range=a=>`${Math.min(...a).toFixed(1)}%–${Math.max(...a).toFixed(1)}%`;
const o=(count,toolCount,mode,field)=>{const g=order.groups.find(g=>g.count===count&&g.toolCount===toolCount&&g.mode===mode);assert.ok(g);return g.stats[field].median;};
const h=(count,toolCount,mode,field)=>{const g=hybrid.groups.find(g=>g.count===count&&g.toolCount===toolCount&&g.mode===mode);assert.ok(g);return g.medians[field];};
const counts=[1,12,48],tools=[3,18,60];
const latency=counts.flatMap(count=>tools.map(toolCount=>100*(1-o(count,toolCount,'ptc','localWallMs')/o(count,toolCount,'codemode','localWallMs'))));
assert.ok(latency.every(v=>v>0));
for(const count of counts)for(const toolCount of tools)assert.ok(h(count,toolCount,'ptc','localWallMs')<h(count,toolCount,'hybrid','localWallMs'));
const c=(count,mode)=>{const g=coding.groups.find(g=>g.count===count&&g.mode===mode);assert.ok(g);return g;};
for(const count of [3,8,16])for(const mode of ['codemode','ptc'])for(const field of ['inputTokens','localWallMs'])assert.ok(c(count,'hybrid').medians[field]<c(count,mode).medians[field]);
const replacements={
 ORDER_TASKS:n(order.attempts),HYBRID_TASKS:n(hybrid.tasks),CODING_TASKS:n(coding.tasks),CODING_PASSED:n(coding.passed),
 ORDER_TOOL_INPUT:['| 工具数 | 并行 Tool Calling 输入 | Codemode 输入 | 全量 DSH PTC 输入 |','|---|---:|---:|---:|',...tools.map(t=>`| ${t} | ${n(o(12,t,'direct-batch','inputTokens'))} | ${n(o(12,t,'codemode','inputTokens'))} | ${n(o(12,t,'ptc','inputTokens'))} |`)].join('\n'),
 ORDER_CODE_SAVING:range(counts.map(count=>100*(1-o(count,60,'codemode','inputTokens')/o(count,60,'ptc','inputTokens')))),
 ORDER_LARGE_BATCH:n(o(48,18,'direct-batch','inputTokens')),ORDER_LARGE_CODE:n(o(48,18,'codemode','inputTokens')),ORDER_LARGE_PTC:n(o(48,18,'ptc','inputTokens')),
 ORDER_DATA_SAVING_CODE:(100*(1-o(48,18,'codemode','inputTokens')/o(48,18,'direct-batch','inputTokens'))).toFixed(1)+'%',
 ORDER_DATA_SAVING_PTC:(100*(1-o(48,18,'ptc','inputTokens')/o(48,18,'direct-batch','inputTokens'))).toFixed(1)+'%',
 ORDER_TIME_SAVING:range(latency),
 ORDER_HYBRID_TABLE:['| 订单数 / 60工具 | 输入 token：Codemode / PTC / 融合 | 耗时 ms：Codemode / PTC / 融合 |','|---|---:|---:|',...counts.map(count=>`| ${count} | ${['codemode','ptc','hybrid'].map(mode=>n(h(count,60,mode,'inputTokens'))).join(' / ')} | ${['codemode','ptc','hybrid'].map(mode=>n(h(count,60,mode,'localWallMs'))).join(' / ')} |`)].join('\n'),
 HYBRID_INPUT_SAVING:range(counts.map(count=>100*(1-h(count,60,'hybrid','inputTokens')/h(count,60,'ptc','inputTokens')))),
 CODING_TABLE:['| 模块数 | 路径 | 验收通过 | 模型轮数 | 输入 token | 耗时秒 |','|---|---|---:|---:|---:|---:|',...coding.groups.map(g=>`| ${g.count} | ${{codemode:'Codemode',ptc:'全量 DSH PTC',hybrid:'融合'}[g.mode]} | ${g.passed}/3 | ${g.medians.modelRequests} | ${n(g.medians.inputTokens)} | ${(g.medians.localWallMs/1000).toFixed(2)} |`)].join('\n'),
};
for(const [mode,key]of [['codemode','CODING_CODE_PASS'],['ptc','CODING_PTC_PASS'],['hybrid','CODING_HYBRID_PASS']])replacements[key]=`${coding.groups.filter(g=>g.mode===mode).reduce((sum,g)=>sum+g.passed,0)}/9`;
replacements.CODING_ROUNDS=`${Math.min(...coding.groups.map(g=>g.ranges.modelRequests[0]))}–${Math.max(...coding.groups.map(g=>g.ranges.modelRequests[1]))}`;
const english={...replacements};
english.ORDER_TOOL_INPUT=replacements.ORDER_TOOL_INPUT.replace('工具数','Tools').replace('并行 Tool Calling 输入','Batched tool calling input').replace('Codemode 输入','Codemode input').replace('全量 DSH PTC 输入','Full-SDK DSH PTC input');
english.ORDER_HYBRID_TABLE=replacements.ORDER_HYBRID_TABLE.replace('订单数 / 60工具','Orders / 60 tools').replace('输入 token：Codemode / PTC / 融合','Input tokens: Codemode / PTC / hybrid').replace('耗时 ms：Codemode / PTC / 融合','Time (ms): Codemode / PTC / hybrid');
english.CODING_TABLE=replacements.CODING_TABLE.replace('模块数','Modules').replace('路径','Path').replace('验收通过','Passed').replace('模型轮数','Model requests').replace('输入 token','Input tokens').replace('耗时秒','Time (s)').replaceAll('全量 DSH PTC','Full-SDK DSH PTC').replaceAll('融合','Hybrid');
for(const [source,output,values] of [['scripts/article-body.md','README.md',replacements],['scripts/article-body.en.md','README.en.md',english]]){
 let body=await readFile(new URL(source,root),'utf8');
 for(const name of ['demo','docs','results','scripts'])body=body.replaceAll('(../'+name+'/', '('+name+'/');
 body=body.replaceAll('(../README', '(README');
 body=body.replace(/\{\{([A-Z_]+)\}\}/g,(_match,key)=>{assert.ok(key in values,`Unknown article value ${key}`);return values[key];});
 assert.ok(!/\{\{[A-Z_]+\}\}/.test(body));
 assert.ok(!/!\[|```mermaid|architecture-v1/.test(body),'Removed figure must not reappear');
 const target=new URL(output,root);
 if(process.argv.includes('--check'))assert.equal(await readFile(target,'utf8'),body,`${output} differs from article source and frozen results`);
 else await writeFile(target,body);
}
console.log(`Chinese and English articles ${process.argv.includes('--check')?'verified':'built'} from frozen 108 / 81 / 27 task summaries; evidence unchanged`);
