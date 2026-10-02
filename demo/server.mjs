import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { runComparison } from './engine.mjs';
import { loadDeepSeekConfig, publicConfig, safeError } from './deepseek.mjs';
const root = new URL('./', import.meta.url);
let latest;
try { latest = JSON.parse(await readFile(new URL('output/latest-run.json', root), 'utf8')); }
catch {
  try { latest = JSON.parse(await readFile(new URL('../results/online-2026-10-02.json', root), 'utf8')); }
  catch { latest = await runComparison(); }
}
let busy = false;
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, publicConfig(await loadDeepSeekConfig()));
    if (req.method === 'GET' && url.pathname === '/api/latest') return json(res, 200, latest);
    if (req.method === 'GET' && url.pathname === '/api/export') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="pi-demo-trace.json"' });
      return res.end(JSON.stringify(latest, null, 2));
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      if (busy) return json(res, 409, { error: '已有演示正在执行，请稍后再试。' });
      // This local endpoint only accepts numeric fixture settings, never executable code.
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Origin rejected' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1024) return json(res, 413, { error: 'Request too large' }); }
      const input = JSON.parse(body || '{}');
      const inference = input.inference ?? 'replay';
      if (!['replay', 'online'].includes(inference)) return json(res, 400, { error: 'Invalid inference mode' });
      const options = { count: input.count ?? 12, toolCount: input.toolCount ?? 18, delayMs: 25, inference };
      if (![12, 24, 48].includes(options.count) || ![3, 18, 60].includes(options.toolCount)) return json(res, 400, { error: 'Invalid fixture settings' });
      busy = true;
      try {
        latest = await runComparison(options);
        await mkdir(new URL('output/', root), { recursive: true });
        await writeFile(new URL('output/latest-run.json', root), JSON.stringify(latest, null, 2));
        if (inference === 'online') await writeFile(new URL(`output/online-${Date.now()}.json`, root), JSON.stringify(latest, null, 2));
        return json(res, 200, latest);
      } finally { busy = false; }
    }
    if (req.method === 'GET' && files[url.pathname]) {
      const [path, type] = files[url.pathname];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
      return res.end(await readFile(new URL(path, root)));
    }
    res.writeHead(404); res.end('Not found');
  } catch (error) { json(res, 500, { error: safeError(error, await loadDeepSeekConfig()) }); }
});
server.listen(Number(process.env.PI_DEMO_PORT || 4317), '127.0.0.1', () => console.log(`Pi comparison demo: http://127.0.0.1:${server.address().port}`));
process.on('SIGINT', () => { server.close(); });
