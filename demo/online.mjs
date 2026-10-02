import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadDeepSeekConfig, publicConfig, safeError } from './deepseek.mjs';
import { runComparison } from './engine.mjs';
const config = await loadDeepSeekConfig();
try {
  if (!config.apiKey) throw new Error('请在 .env.local 填写 DEEPSEEK_API_KEY 后重试。');
  const response = await fetch(`${config.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`模型列表连接测试失败：HTTP ${response.status}`);
  const models = await response.json();
  if (!models.data?.some(m => m.id === config.model)) throw new Error(`官方模型列表中未找到 ${config.model}，请核对 DEEPSEEK_MODEL。`);
  console.log(JSON.stringify({ connection: 'authenticated', ...publicConfig(config) }));
  if (!process.argv.includes('--check')) {
    const result = await runComparison({ inference: 'online', onProgress: progress => console.log(JSON.stringify(progress)) });
    await mkdir(new URL('./output/', import.meta.url), { recursive: true });
    const file = new URL(`./output/online-${Date.now()}.json`, import.meta.url);
    await writeFile(file, JSON.stringify(result, null, 2));
    await writeFile(new URL('./output/latest-run.json', import.meta.url), JSON.stringify(result, null, 2));
    const keys = ['before', 'batch', 'after', ...(result.ptc ? ['ptc'] : [])];
    console.table(Object.fromEntries(keys.map(k => [k, result[k].metrics])));
    console.log(JSON.stringify({ file: fileURLToPath(file), verified: result.verified, results: Object.fromEntries(keys.map(k => [k, { validation: result[k].validation, error: result[k].error }])) }));
    if (!result.verified) process.exitCode = 1;
  }
} catch (error) { console.error(safeError(error, config)); process.exitCode = 1; }
