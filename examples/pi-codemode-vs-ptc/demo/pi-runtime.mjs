import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

// Prefer a project install; reuse the user's installed Pi without changing it.
const require = createRequire(import.meta.url);
function findEsmEntry(resolver, name) {
  for (const base of resolver.resolve.paths(name) ?? []) {
    const path = `${base}/${name}/dist/index.js`;
    if (existsSync(path)) return path;
  }
  throw new Error(`Package missing: ${name}`);
}
let entry;
try { entry = findEsmEntry(require, '@earendil-works/pi-coding-agent'); }
catch {
  const root = process.env.PI_DEMO_PACKAGE_ROOT || 'D:/nodejs/node_modules/@earendil-works/pi-coding-agent';
  entry = `${root}/dist/index.js`;
  if (!existsSync(entry)) throw new Error('Pi SDK missing. Run npm install in this directory or set PI_DEMO_PACKAGE_ROOT.');
}
export const pi = await import(pathToFileURL(entry).href);
const piRequire = createRequire(entry);
export const ai = await import(pathToFileURL(findEsmEntry(piRequire, '@earendil-works/pi-ai')).href);
export const runtimeEntry = entry;
