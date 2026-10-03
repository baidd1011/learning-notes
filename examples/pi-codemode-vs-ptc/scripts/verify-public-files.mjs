import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
const root=fileURLToPath(new URL('../',import.meta.url));
let key=process.env.DEEPSEEK_API_KEY;
const keyFile=process.argv.find(a=>a.startsWith('--key-file='))?.slice(11);
if(keyFile) {
  const env=await readFile(resolve(keyFile),'utf8');
  key=env.match(/^DEEPSEEK_API_KEY\s*=\s*(.*)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g,'');
}
let files=0,links=0,totalBytes=0;
async function walk(dir) {
  for(const d of await readdir(dir,{withFileTypes:true})) {
    if(['.git','.runtime','node_modules','output'].includes(d.name)) continue;
    const path=resolve(dir,d.name);
    if(d.isDirectory()) { await walk(path); continue; }
    assert.notEqual(d.name,'.env.local');
    const raw=await readFile(path);
    totalBytes+=raw.length;
    const source=(path.endsWith('.gz')?gunzipSync(raw):raw).toString('utf8');
    if(key) assert.ok(!source.includes(key),'Credential in public candidate file');
    assert.ok(!/sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|[CD]:[\\/]+Users[\\/]/i.test(source),'Secret or home path in '+path);
    if(extname(path)==='.md') for(const match of source.matchAll(/\]\(([^)]+)\)/g)) {
      const target=match[1];
      if(/^(https?:|#)/.test(target)) continue;
      await stat(resolve(dirname(path),target.split('#')[0]));
      links++;
    }
    files++;
  }
}
await walk(root);
console.log(JSON.stringify({publicFiles:files,localLinks:links,totalBytes,credentialScan:'passed'}));
