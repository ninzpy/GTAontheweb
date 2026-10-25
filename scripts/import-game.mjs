/** Import the verified release files into this site's persistent Netlify Blobs store. */
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

async function main() {

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stagingRoot = resolve(process.env.BTA_GAME_STAGING_DIR || resolve(tmpdir(), 'bta-game-assets'));
if (stagingRoot === root || stagingRoot.startsWith(root + '/')) throw new Error('Game staging must be outside the repository.');
const step = 4 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inventoryBytes = await readFile(resolve(root, 'file-inventory.json'));
const inventory = JSON.parse(inventoryBytes);
const inventoryHash = sha(inventoryBytes);
const records = inventory.files.filter(r => r.path.startsWith('mirror/playgta5.com/'));
const mime = path => ({ js: 'text/javascript; charset=utf-8', json: 'application/json', html: 'text/html; charset=utf-8', wasm: 'application/wasm', png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', woff: 'font/woff', woff2: 'font/woff2', svg: 'image/svg+xml', css: 'text/css; charset=utf-8', txt: 'text/plain; charset=utf-8' }[path.split('.').pop()] || 'application/octet-stream');
const index = { version: 1, store: 'bta-game-v1', inventoryHash, sourceFiles: records.length, sourceBytes: records.reduce((sum, r) => sum + r.bytes, 0), files: {} };
const manifest = { chunkSize: step, files: {} };
const dryRun = process.argv.includes('--catalog-only');
let store;
let existing = new Set();
if (!dryRun) {
  if (!process.env.NETLIFY_SITE_ID || !process.env.NETLIFY_AUTH_TOKEN) throw new Error('The import needs Netlify site credentials in the process environment.');
  // Explicit credentials are used only by this offline administration script, never in browser code or Functions.
  store = getStore({ name: index.store, consistency: 'strong', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });
  const listed = await store.list();
  existing = new Set(listed.blobs.map(b => b.key));
}
let uploaded = 0;
let processed = 0;
let verifiedBytes = 0;
const expectedKeys = new Set();
async function put(bytes) {
  const key = 'sha256/' + sha(bytes);
  expectedKeys.add(key);
  if (store && !existing.has(key)) {
    for (let attempt = 0; ; attempt++) {
      try { await store.set(key, bytes); break; }
      catch { if (attempt >= 4) throw new Error('Storage upload failed after retries; rerun to resume.'); await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); }
    }
    existing.add(key);
    uploaded++;
  }
  return key;
}
async function verify(path, record) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of createReadStream(path)) { hash.update(bytes); size += bytes.length; }
  if (size !== record.bytes || hash.digest('hex') !== record.sha256) throw new Error('Source verification failed: ' + record.path);
}
function patchWorker(relative, bytes) {
  let code = bytes.toString('utf8');
  if (relative.endsWith('/io_worker.js')) {
    const old = 'if (wanted.size) await batchFetch(full, true, wanted);';
    if (code.split(old).length !== 2) throw new Error('Unexpected I/O worker source.');
    code = code.replace(old, 'for (const r of full) { if (wanted.has(r.id)) await ensureBlocks(r.id, r.a, r.b, true); }');
  }
  return Buffer.from("importScripts('/chunk-index.js', '/chunk-fetch.js');\n" + code);
}
async function processRecord(record) {
  const relative = record.path.slice('mirror/playgta5.com/'.length);
  const path = resolve(stagingRoot, record.path);
  await verify(path, record);
  if (record.bytes > step) {
    const handle = await open(path, 'r');
    try {
      for (let offset = 0, part = 0; offset < record.bytes; offset += step, part++) {
        const bytes = Buffer.alloc(Math.min(step, record.bytes - offset));
        let filled = 0;
        while (filled < bytes.length) {
          const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, offset + filled);
          if (!bytesRead) throw new Error('Truncated source file: ' + relative);
          filled += bytesRead;
        }
        const key = await put(bytes);
        const url = `/__chunks/${record.sha256}/${String(part).padStart(4, '0')}.bin`;
        index.files[url] = { key, size: bytes.length, type: 'application/octet-stream' };
      }
    } finally { await handle.close(); }
    manifest.files['/' + relative] = { size: record.bytes, prefix: '/__chunks/' + record.sha256, type: mime(relative) };
  } else {
    let bytes = await readFile(path);
    if (relative.endsWith('/loader.js') || relative.endsWith('/io_worker.js')) bytes = patchWorker(relative, bytes);
    const key = await put(bytes);
    index.files['/' + relative] = { key, size: bytes.length, type: mime(relative) };
    if (relative.startsWith('data/')) manifest.files['/' + relative] = { size: bytes.length, url: '/' + relative, type: mime(relative) };
  }
  processed++;
  verifiedBytes += record.bytes;
  if (processed % 500 === 0 || processed === records.length) console.log(`Verified ${processed}/${records.length} source files; ${(verifiedBytes / 1e9).toFixed(2)} GB; ${uploaded} new stored objects.`);
}
let cursor = 0;
await Promise.all(Array.from({ length: 16 }, async () => {
  while (cursor < records.length) await processRecord(records[cursor++]);
}));
index.files = Object.fromEntries(Object.entries(index.files).sort(([a], [b]) => a.localeCompare(b)));
manifest.files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)));
await mkdir(resolve(root, 'hosting'), { recursive: true });
await writeFile(resolve(root, 'hosting/game-assets.json'), JSON.stringify(index));
await writeFile(resolve(root, 'public/chunk-index.js'), 'globalThis.GAME_CHUNKS=' + JSON.stringify(manifest) + ';\n');
if (store) {
  const listed = new Set((await store.list()).blobs.map(b => b.key));
  const missing = [...expectedKeys].filter(k => !listed.has(k));
  if (missing.length) throw new Error(`Storage audit found ${missing.length} missing objects. Rerun the import to resume.`);
  const receipt = { inventoryHash, sourceFiles: records.length, sourceBytes: index.sourceBytes, objects: expectedKeys.size, verifiedAt: new Date().toISOString() };
  await store.setJSON('ready/' + inventoryHash, receipt);
  console.log(`Independent copy complete: ${receipt.sourceFiles} verified files, ${receipt.sourceBytes} source bytes, ${receipt.objects} stored objects.`);
} else console.log('Catalog generated only. No storage writes occurred.');

}

main().catch(() => { console.error('Game import did not finish. Check source files and storage access, then rerun to resume.'); process.exitCode = 1; });
