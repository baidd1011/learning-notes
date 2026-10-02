import {createInterface} from 'node:readline';
import {codingCatalog,executeCoding} from './coding-fixture.mjs';
const [root,countText]=process.argv.slice(2);const count=Number(countText);
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let active=0;const waiting=[];const gates=new Map();
async function dispatch(name,args){
 if(active>=8)await new Promise(r=>waiting.push(r));active++;
 const key=name==='replace_text'?args.path:name==='run_tests'?'$tests':null;
 const previous=key?gates.get(key):null;let unlock;const tail=key?new Promise(r=>unlock=r):null;if(key)gates.set(key,tail);
 try{await previous;return await executeCoding(root,count,name,args);}finally{if(key){unlock();if(gates.get(key)===tail)gates.delete(key);}active--;waiting.shift()?.();}
}
const input=createInterface({input:process.stdin});input.on('close',()=>process.exit(0));
input.on('line',async line=>{let r;try{
 r=JSON.parse(line);if(r.id===undefined)return;
 let result;if(r.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'coding-fixture',version:'1.0.0'},instructions:'Isolated TypeScript migration project. Use file tools to inspect and edit permitted module files. Tests and client/config are protected.'};
 else if(r.method==='tools/list')result={tools:codingCatalog};else if(r.method==='ping')result={};
 else if(r.method==='tools/call'){const value=await dispatch(r.params.name,r.params.arguments??{});result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:false};}
 else throw Error('Unknown method');send({jsonrpc:'2.0',id:r.id,result});
 }catch(e){if(r?.id!==undefined)send({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:e.message}],isError:true}});}});
