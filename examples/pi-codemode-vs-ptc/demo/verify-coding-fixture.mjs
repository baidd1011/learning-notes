import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {createCodingFixture,evaluateCoding,executeCoding} from './coding-fixture.mjs';
const base=fileURLToPath(new URL('./.runtime/coding-checks/',import.meta.url));await mkdir(base,{recursive:true});
for(const count of [3,8,16]){
 const root=await mkdtemp(join(base,'fixture-'));await createCodingFixture(root,count);
 assert.equal((await evaluateCoding(root,count)).passed,false);
 await assert.rejects(executeCoding(root,count,'replace_text',{path:'src/client.ts',oldText:'send',newText:'request'}),/Protected/);
 for(let i=1;i<=count;i++){
  const path=join(root,`src/modules/module${i}.ts`);let text=await readFile(path,'utf8');
  text=text.replace(/client\.request\(('\/items\/\d+'), options\)/g,'client.send({ url: $1, ...options })');
  text=text.replace(/client\.request\(('(?:\/items|\/health)\/\d+'), \{([^}]*(?:\{[^}]*\}[^}]*)?)\}\)/g,'client.send({ url: $1,$2 })');
  await writeFile(path,text);
 }
 const good=await evaluateCoding(root,count);assert.ok(good.passed,JSON.stringify(good));assert.equal(good.behavior.passedTests,count*4);
 const path=join(root,'src/modules/module1.ts'),correct=await readFile(path,'utf8');
 await writeFile(path,correct.replace('timeoutMs: 1101','timeoutMs: 1'));assert.equal((await evaluateCoding(root,count)).passed,false);
 await writeFile(path,correct.replace('.score + 1','.score + 99'));assert.equal((await evaluateCoding(root,count)).passed,false);
 console.log(JSON.stringify({fixture:count,checks:'unmigrated rejected, protected edit blocked, reference migration passes, timeout and response corruption rejected'}));
}
