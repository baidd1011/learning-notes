import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { runMode } from './engine.mjs';
import { runPtc } from './ptc.mjs';
import { loadDeepSeekConfig, publicConfig, safeError } from './deepseek.mjs';

const config = await loadDeepSeekConfig();
if (!config.apiKey) throw new Error('Missing local API key');
const root = fileURLToPath(new URL('./', import.meta.url)).replace(/[\\/]$/, '');
const output = new URL('./output/matrix-v2/', import.meta.url);
await mkdir(output, { recursive: true });
const manifestUrl = new URL('manifest.json', output);
let manifest;
try { manifest = JSON.parse(await readFile(manifestUrl, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
manifest ??= { revision: 'matrix-v2', startedAt: new Date().toISOString(), provider: publicConfig(config), orders: [1,12,48], tools: [3,18,60], repetitions: 3, delayMs: 25, runtime: { pi:'1.0.0', harness:'0.2.0-rc.2', node:process.version, platform:process.platform, ptcPendingLimit:64, ptcExecutionConcurrency:8 }, orderPolicy: 'sequential; rotate paths by cell and repetition; reverse cell order on odd repetitions', runs: [] };
const paths = ['direct', 'direct-batch', 'codemode', 'ptc'];
const cells = manifest.orders.flatMap(count => manifest.tools.map(toolCount => ({ count, toolCount })));
function sanitize(value) {
  if (typeof value === 'string') {
    if (value.includes(config.apiKey)) throw new Error('Credential in captured record');
    for (const p of [root, root.replaceAll('\\','/'), root.replaceAll('/','\\')]) value = value.split(p).join('<demo-root>');
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitize(v)]));
  return value;
}
for (let repeat = 0; repeat < 3; repeat++) {
  const sequence = repeat % 2 ? [...cells].reverse() : cells;
  for (const cell of sequence) {
    const offset = (cells.findIndex(c=>c.count===cell.count && c.toolCount===cell.toolCount)+repeat)%4;
    for (let i=0;i<4;i++) {
      const mode = paths[(i+offset)%4], id = `o${cell.count}-t${cell.toolCount}-r${repeat+1}-${mode}`;
      if (manifest.runs.some(r=>r.id===id)) continue;
      console.log(JSON.stringify({ event:'start', id, completed:manifest.runs.length, total:108 }));
      let result;
      const start = performance.now();
      try {
        const options = { ...cell, delayMs:25, inference:'online', testConfig:config };
        result = mode==='ptc' ? await runPtc(options) : await runMode(mode, options);
      } catch (e) { result = { mode, error:safeError(e,config), validation:{passed:false}, metrics:{localWallMs:Math.round(performance.now()-start)}, calls:[], requests:[] }; }
      const file = `${id}.json.gz`;
      await writeFile(new URL(file,output), gzipSync(JSON.stringify(sanitize({ id, options:cell, repeat:repeat+1, capturedAt:new Date().toISOString(), publication:{pathRedacted:true,bytes:'original capture before path replacement'}, result }))));
      manifest.runs.push({ id, ...cell, repeat:repeat+1, mode, file, passed:result.validation.passed, error:result.error, validation:result.validation, metrics:result.metrics });
      manifest.updatedAt = new Date().toISOString();
      await writeFile(manifestUrl, JSON.stringify(manifest,null,2));
      console.log(JSON.stringify({ event:'done', id, passed:result.validation.passed, error:result.error, metrics:result.metrics }));
    }
  }
}
manifest.completedAt = new Date().toISOString();
await writeFile(manifestUrl, JSON.stringify(manifest,null,2));
console.log(JSON.stringify({ event:'complete', total:manifest.runs.length, passed:manifest.runs.filter(r=>r.passed).length }));
