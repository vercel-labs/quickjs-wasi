/**
 * URL Extension Benchmark
 *
 * Compares the native WASM URL extension (backed by ada-url) against
 * a pure JavaScript polyfill (core-js-pure) across two dimensions:
 *
 *   1. Runtime performance: URL parsing, property access, URLSearchParams ops
 *   2. Snapshot size: raw bytes and gzip-compressed
 */

import { QuickJS } from '../src/index.ts';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(resolve(__dirname, '..', 'quickjs.wasm'));
const urlExtBytes = readFileSync(resolve(__dirname, '..', 'extensions', 'url', 'url.so'));
const polyfillCode = readFileSync(resolve(__dirname, 'url-polyfill-bundle.js'), 'utf-8');

// ─── Benchmark Workloads ─────────────────────────────────────────────────────

/**
 * Each workload is a JS string that runs inside the VM.
 * Returns the number of operations performed (for ops/sec calculation).
 */
const workloads: Record<string, { code: string; description: string }> = {
  'URL parse (simple)': {
    description: 'Parse a simple HTTPS URL 10,000 times',
    code: `(function(){
      var N = 10000;
      for (var i = 0; i < N; i++) {
        new URL('https://example.com/path?query=value#hash');
      }
      return N;
    })()`,
  },
  'URL parse (complex)': {
    description: 'Parse a complex URL with auth, port, encoded chars 5,000 times',
    code: `(function(){
      var N = 5000;
      for (var i = 0; i < N; i++) {
        new URL('https://user:p%40ss@sub.example.com:8080/path/to/resource?key=val%20ue&arr=1&arr=2#section-3');
      }
      return N;
    })()`,
  },
  'URL parse + base resolution': {
    description: 'Parse relative URLs against a base 5,000 times',
    code: `(function(){
      var N = 5000;
      var base = 'https://example.com/base/path/';
      for (var i = 0; i < N; i++) {
        new URL('../other/page?q=1', base);
      }
      return N;
    })()`,
  },
  'URL property access': {
    description: 'Parse once, read all properties 10,000 times',
    code: `(function(){
      var url = new URL('https://user:pass@example.com:8080/path?q=1#h');
      var N = 10000;
      for (var i = 0; i < N; i++) {
        url.href; url.protocol; url.username; url.password;
        url.host; url.hostname; url.port; url.pathname;
        url.search; url.hash; url.origin;
      }
      return N;
    })()`,
  },
  'URL property setters': {
    description: 'Mutate URL properties 5,000 times',
    code: `(function(){
      var N = 5000;
      for (var i = 0; i < N; i++) {
        var url = new URL('https://example.com/path');
        url.pathname = '/new';
        url.search = '?k=v';
        url.hash = '#h';
        url.hostname = 'other.com';
      }
      return N;
    })()`,
  },
  'URLSearchParams parse + iterate': {
    description: 'Parse search params and iterate entries 5,000 times',
    code: `(function(){
      var N = 5000;
      for (var i = 0; i < N; i++) {
        var p = new URLSearchParams('a=1&b=2&c=3&d=4&e=5');
        var count = 0;
        p.forEach(function() { count++; });
      }
      return N;
    })()`,
  },
  'URLSearchParams mutate + serialize': {
    description: 'Build search params and serialize 5,000 times',
    code: `(function(){
      var N = 5000;
      for (var i = 0; i < N; i++) {
        var p = new URLSearchParams();
        p.set('key1', 'value 1');
        p.set('key2', 'value&2');
        p.append('key1', 'value 3');
        p.delete('key2');
        p.toString();
      }
      return N;
    })()`,
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toFixed(0);
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return (n / 1_048_576).toFixed(2) + ' MB';
  if (n >= 1_024) return (n / 1_024).toFixed(1) + ' KB';
  return n + ' B';
}

function padRight(s: string, len: number): string {
  return s + ' '.repeat(Math.max(0, len - s.length));
}

function padLeft(s: string, len: number): string {
  return ' '.repeat(Math.max(0, len - s.length)) + s;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('URL Extension Benchmark: Native WASM (ada-url) vs JS Polyfill (core-js-pure)\n');
  console.log('='.repeat(85));

  // ── Part 1: Performance ──────────────────────────────────────────────────

  console.log('\n## Runtime Performance\n');

  // Create VMs
  const vmNative = await QuickJS.create({
    wasm: wasmBytes,
    extensions: [{ name: 'url', wasm: urlExtBytes }],
  });

  const vmPolyfill = await QuickJS.create({ wasm: wasmBytes });
  vmPolyfill.evalCode(polyfillCode).dispose();

  // Warm up both VMs
  vmNative.evalCode('(function(){ new URL("https://example.com"); new URLSearchParams("a=1"); })()').dispose();
  vmPolyfill.evalCode('(function(){ new URL("https://example.com"); new URLSearchParams("a=1"); })()').dispose();

  const results: { name: string; nativeMs: number; polyfillMs: number; ops: number }[] = [];

  for (const [name, { code }] of Object.entries(workloads)) {
    // Run native
    const nativeStart = performance.now();
    const nativeResult = vmNative.evalCode(code);
    const nativeMs = performance.now() - nativeStart;
    const ops = Number(nativeResult.toString());
    nativeResult.dispose();

    // Run polyfill
    const polyfillStart = performance.now();
    const polyfillResult = vmPolyfill.evalCode(code);
    const polyfillMs = performance.now() - polyfillStart;
    polyfillResult.dispose();

    results.push({ name, nativeMs, polyfillMs, ops });
  }

  // Print performance table
  const col1 = 40;
  const col2 = 14;
  const col3 = 14;
  const col4 = 12;

  console.log(
    padRight('Workload', col1) +
    padLeft('Native (ada)', col2) +
    padLeft('JS (core-js)', col3) +
    padLeft('Speedup', col4)
  );
  console.log('-'.repeat(col1 + col2 + col3 + col4));

  for (const r of results) {
    const speedup = r.polyfillMs / r.nativeMs;
    const nativeOpsPerSec = (r.ops / r.nativeMs) * 1000;
    const polyfillOpsPerSec = (r.ops / r.polyfillMs) * 1000;

    console.log(
      padRight(r.name, col1) +
      padLeft(`${r.nativeMs.toFixed(1)}ms`, col2) +
      padLeft(`${r.polyfillMs.toFixed(1)}ms`, col3) +
      padLeft(`${speedup.toFixed(1)}x`, col4)
    );
  }

  console.log('');

  // Summary
  const totalNative = results.reduce((s, r) => s + r.nativeMs, 0);
  const totalPolyfill = results.reduce((s, r) => s + r.polyfillMs, 0);
  console.log(
    padRight('TOTAL', col1) +
    padLeft(`${totalNative.toFixed(1)}ms`, col2) +
    padLeft(`${totalPolyfill.toFixed(1)}ms`, col3) +
    padLeft(`${(totalPolyfill / totalNative).toFixed(1)}x`, col4)
  );

  vmNative.dispose();
  vmPolyfill.dispose();

  // ── Part 2: Snapshot Size ────────────────────────────────────────────────

  console.log('\n' + '='.repeat(85));
  console.log('\n## Snapshot Size Comparison\n');

  // Baseline: empty VM snapshot
  const vmBase = await QuickJS.create({ wasm: wasmBytes });
  const snapBase = vmBase.snapshot();
  const snapBaseBytes = QuickJS.serializeSnapshot(snapBase);
  vmBase.dispose();

  // Native extension: VM + URL extension (no JS polyfill code in snapshot)
  const vmNativeSnap = await QuickJS.create({
    wasm: wasmBytes,
    extensions: [{ name: 'url', wasm: urlExtBytes }],
  });
  // Create some URL objects to have them in the snapshot
  vmNativeSnap.evalCode(`
    globalThis.url1 = new URL('https://example.com:8080/path?q=1#h');
    globalThis.url2 = new URL('https://user:pass@sub.example.org/a/b/c');
    globalThis.params = new URLSearchParams('a=1&b=2&c=3');
  `).dispose();
  const snapNative = vmNativeSnap.snapshot();
  const snapNativeBytes = QuickJS.serializeSnapshot(snapNative);
  vmNativeSnap.dispose();

  // Polyfill: VM + polyfill code evaluated (polyfill code is in the snapshot)
  const vmPolySnap = await QuickJS.create({ wasm: wasmBytes });
  vmPolySnap.evalCode(polyfillCode).dispose();
  vmPolySnap.evalCode(`
    globalThis.url1 = new URL('https://example.com:8080/path?q=1#h');
    globalThis.url2 = new URL('https://user:pass@sub.example.org/a/b/c');
    globalThis.params = new URLSearchParams('a=1&b=2&c=3');
  `).dispose();
  const snapPoly = vmPolySnap.snapshot();
  const snapPolyBytes = QuickJS.serializeSnapshot(snapPoly);
  vmPolySnap.dispose();

  // Polyfill: Snapshot WITHOUT URL objects (just the polyfill code loaded)
  const vmPolySnapEmpty = await QuickJS.create({ wasm: wasmBytes });
  vmPolySnapEmpty.evalCode(polyfillCode).dispose();
  const snapPolyEmpty = vmPolySnapEmpty.snapshot();
  const snapPolyEmptyBytes = QuickJS.serializeSnapshot(snapPolyEmpty);
  vmPolySnapEmpty.dispose();

  // Native extension: Snapshot WITHOUT URL objects (just the extension loaded)
  const vmNativeSnapEmpty = await QuickJS.create({
    wasm: wasmBytes,
    extensions: [{ name: 'url', wasm: urlExtBytes }],
  });
  const snapNativeEmpty = vmNativeSnapEmpty.snapshot();
  const snapNativeEmptyBytes = QuickJS.serializeSnapshot(snapNativeEmpty);
  vmNativeSnapEmpty.dispose();

  // Compress all snapshots
  const gzBase = gzipSync(snapBaseBytes);
  const gzNative = gzipSync(snapNativeBytes);
  const gzPoly = gzipSync(snapPolyBytes);
  const gzPolyEmpty = gzipSync(snapPolyEmptyBytes);
  const gzNativeEmpty = gzipSync(snapNativeEmptyBytes);

  // Print snapshot table
  const scol1 = 40;
  const scol2 = 16;
  const scol3 = 16;

  console.log(
    padRight('Snapshot', scol1) +
    padLeft('Raw', scol2) +
    padLeft('Gzip', scol3)
  );
  console.log('-'.repeat(scol1 + scol2 + scol3));

  const snapRows = [
    ['Baseline (empty VM)', snapBaseBytes.byteLength, gzBase.byteLength],
    ['Native ext (no URLs)', snapNativeEmptyBytes.byteLength, gzNativeEmpty.byteLength],
    ['Native ext (3 URLs)', snapNativeBytes.byteLength, gzNative.byteLength],
    ['JS polyfill (no URLs)', snapPolyEmptyBytes.byteLength, gzPolyEmpty.byteLength],
    ['JS polyfill (3 URLs)', snapPolyBytes.byteLength, gzPoly.byteLength],
  ] as const;

  for (const [label, raw, gz] of snapRows) {
    console.log(
      padRight(label, scol1) +
      padLeft(formatBytes(raw), scol2) +
      padLeft(formatBytes(gz), scol3)
    );
  }

  console.log('');

  // Delta comparison
  console.log(
    padRight('Scenario', scol1) +
    padLeft('Raw delta', scol2) +
    padLeft('Gzip delta', scol3)
  );
  console.log('-'.repeat(scol1 + scol2 + scol3));

  const nativeEmptyDelta = snapNativeEmptyBytes.byteLength - snapBaseBytes.byteLength;
  const nativeEmptyGzDelta = gzNativeEmpty.byteLength - gzBase.byteLength;
  const polyEmptyDelta = snapPolyEmptyBytes.byteLength - snapBaseBytes.byteLength;
  const polyEmptyGzDelta = gzPolyEmpty.byteLength - gzBase.byteLength;

  const nativeDelta = snapNativeBytes.byteLength - snapBaseBytes.byteLength;
  const nativeGzDelta = gzNative.byteLength - gzBase.byteLength;
  const polyDelta = snapPolyBytes.byteLength - snapBaseBytes.byteLength;
  const polyGzDelta = gzPoly.byteLength - gzBase.byteLength;

  const deltas = [
    ['Native ext (no URLs) vs baseline', nativeEmptyDelta, nativeEmptyGzDelta],
    ['Native ext (3 URLs) vs baseline', nativeDelta, nativeGzDelta],
    ['JS polyfill (no URLs) vs baseline', polyEmptyDelta, polyEmptyGzDelta],
    ['JS polyfill (3 URLs) vs baseline', polyDelta, polyGzDelta],
  ] as const;

  for (const [label, raw, gz] of deltas) {
    const rawSign = raw >= 0 ? '+' : '';
    const gzSign = gz >= 0 ? '+' : '';
    console.log(
      padRight(label, scol1) +
      padLeft(`${rawSign}${formatBytes(raw)}`, scol2) +
      padLeft(`${gzSign}${formatBytes(gz)}`, scol3)
    );
  }

  // Also note the on-disk extension size
  console.log('');
  console.log('Note: The native url.so extension binary is ' + formatBytes(urlExtBytes.byteLength) +
    ' (' + formatBytes(gzipSync(urlExtBytes).byteLength) + ' gzipped) loaded separately from the snapshot.');
  console.log('The JS polyfill is ' + formatBytes(Buffer.byteLength(polyfillCode)) +
    ' of source code baked into every snapshot.');
}

main().catch((err) => {
  console.error('Benchmark failed:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
