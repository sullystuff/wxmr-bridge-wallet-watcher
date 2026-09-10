import { manifest, idl } from '../src/config.js';
import assert from 'node:assert/strict';

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'wxmr-public-watcher/0.1' } });
  if (!response.ok) throw new Error(`Public source returned HTTP ${response.status}`);
  return response.text();
}
const page = await download(manifest.source);
for (const value of [manifest.monero.primaryAddress, manifest.monero.publishedViewKey, manifest.solana.programId, manifest.solana.mint]) {
  assert.ok(page.includes(value), 'A pinned value is no longer present on the public transparency page');
}
const scripts = [...new Set([...page.matchAll(/src="([^"<>]+\.js)"/g)].map(match => match[1]))];
let found = false;
for (const script of scripts) {
  const url = new URL(script, manifest.source);
  if (url.origin !== new URL(manifest.source).origin || !url.pathname.startsWith('/_next/static/')) continue;
  const body = await download(url.href);
  // Decode only string literals passed to JSON.parse; never execute website JavaScript.
  for (const match of body.matchAll(/JSON\.parse\('((?:[^'\\]|\\.)*)'\)/g)) {
    let candidate;
    try { candidate = JSON.parse(match[1].replace(/\\(['\\])/g, '$1')); } catch { continue; }
    if (candidate.address === manifest.solana.programId && candidate.events) {
      assert.deepEqual(candidate, idl, 'Public bridge IDL changed; review before updating the pinned schema');
      found = true;
    }
  }
  if (found) break;
}
assert.ok(found, 'Could not locate the public bridge IDL');
console.log('Verified the pinned address, published view key, program, mint, and full IDL against wxmr.io. No files changed.');
