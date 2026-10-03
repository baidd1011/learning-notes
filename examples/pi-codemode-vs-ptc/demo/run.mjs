import { mkdir, writeFile } from 'node:fs/promises';
import { runComparison } from './engine.mjs';
const result = await runComparison();
await mkdir(new URL('./output/', import.meta.url), { recursive: true });
await writeFile(new URL('./output/latest-run.json', import.meta.url), JSON.stringify(result, null, 2));
console.table(Object.fromEntries(['before', 'after', 'batch'].map(k => [k, result[k].metrics])));
console.log(JSON.stringify(result.after.report, null, 2));
