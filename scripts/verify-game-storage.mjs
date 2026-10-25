/** Read representative assets from the real site store without starting a server. */
import { getStore } from '@netlify/blobs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { serveGameAsset } from '../hosting/serve-game-assets.mjs';

async function main() {

const catalog = JSON.parse(await readFile(new URL('../hosting/game-assets.json', import.meta.url)));
const manifestCode = await readFile(new URL('../public/chunk-index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(manifestCode.slice('globalThis.GAME_CHUNKS='.length).replace(/;\s*$/, ''));
const inventory = JSON.parse(await readFile(new URL('../file-inventory.json', import.meta.url)));
const store = getStore({ name: catalog.store, consistency: 'strong', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });
const request = (path, headers = {}, method = 'GET') => new Request('https://bta-storage-check.invalid' + path, { headers, method });
const status = await serveGameAsset(request('/api/game-status'), store, catalog);
if (status.status !== 200 || !(await status.json()).ready) throw new Error('Complete-copy readiness check failed.');
console.log('Complete-copy readiness: passed.');

const wasm = inventory.files.find(r => r.path.endsWith('/game.wasm'));
const wasmPath = '/' + wasm.path.slice('mirror/playgta5.com/'.length);
const engine = manifest.files[wasmPath];
const hash = createHash('sha256');
for (let offset = 0, i = 0; offset < wasm.bytes; offset += manifest.chunkSize, i++) {
  const path = `${engine.prefix}/${String(i).padStart(4, '0')}.bin`;
  const response = await serveGameAsset(request(path), store, catalog);
  if (response.status !== 200) throw new Error('Engine chunk delivery failed.');
  const bytes = Buffer.from(await response.arrayBuffer());
  const expected = catalog.files[path];
  if (bytes.length !== expected.size || 'sha256/' + createHash('sha256').update(bytes).digest('hex') !== expected.key) throw new Error('Stored chunk checksum mismatch.');
  hash.update(bytes);
}
if (hash.digest('hex') !== wasm.sha256) throw new Error('Complete WebAssembly engine checksum mismatch.');
console.log('Complete stored WebAssembly engine SHA-256: passed.');

const sample = Object.entries(catalog.files).find(([path]) => path.startsWith('/__chunks/'));
const range = await serveGameAsset(request(sample[0], { Range: 'bytes=0-3' }), store, catalog);
if (range.status !== 206 || (await range.arrayBuffer()).byteLength !== 4) throw new Error('Stored asset range check failed.');
const missing = await serveGameAsset(request('/data/nonexistent-bta-check'), store, catalog);
if (missing.status !== 404) throw new Error('Missing asset check failed.');
const loader = Object.keys(catalog.files).find(path => path.endsWith('/loader.js'));
const worker = await serveGameAsset(request(loader), store, catalog);
if (worker.status !== 200 || !(await worker.text()).startsWith("importScripts('/chunk-index.js', '/chunk-fetch.js');")) throw new Error('Worker transport check failed.');
console.log('Stored ranges, worker transport, and genuine 404 responses: passed.');

}

main().catch(() => { console.error('Independent storage verification failed.'); process.exitCode = 1; });
