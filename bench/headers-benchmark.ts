/**
 * Headers Extension Benchmark
 *
 * Compares the native WASM Headers extension against
 * a pure JavaScript polyfill (whatwg-fetch) across two dimensions:
 *
 *   1. Runtime performance: construct, get, set, append, iterate
 *   2. Snapshot size: raw bytes and gzip-compressed
 */

import { Bench } from 'tinybench';
import { QuickJS } from '../src/index.ts';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(resolve(__dirname, '..', 'quickjs.wasm'));
const headersExtBytes = readFileSync(resolve(__dirname, '..', 'extensions', 'headers', 'headers.so'));
const polyfillCode = readFileSync(resolve(__dirname, 'headers-polyfill-bundle.js'), 'utf-8');

// ─── Benchmark Workloads ─────────────────────────────────────────────────────

const workloads: Record<string, { code: string; description: string }> = {
  'construct empty': {
    description: 'Create empty Headers 50,000 times',
    code: `(function(){
      var N = 50000;
      for (var i = 0; i < N; i++) new Headers();
      return N;
    })()`,
  },
  'construct from record': {
    description: 'Create Headers from 5-field record 20,000 times',
    code: `(function(){
      var N = 20000;
      var init = {
        'Content-Type': 'application/json',
        'Accept': 'text/html',
        'Authorization': 'Bearer token123',
        'X-Request-Id': 'abc-def-123',
        'Cache-Control': 'no-cache'
      };
      for (var i = 0; i < N; i++) new Headers(init);
      return N;
    })()`,
  },
  'construct from pairs': {
    description: 'Create Headers from 5 pairs 20,000 times',
    code: `(function(){
      var N = 20000;
      var init = [
        ['Content-Type', 'application/json'],
        ['Accept', 'text/html'],
        ['Authorization', 'Bearer token123'],
        ['X-Request-Id', 'abc-def-123'],
        ['Cache-Control', 'no-cache']
      ];
      for (var i = 0; i < N; i++) new Headers(init);
      return N;
    })()`,
  },
  'get/has lookups': {
    description: 'get + has on 10-header object 50,000 times',
    code: `(function(){
      var N = 50000;
      var h = new Headers({
        'Content-Type': 'application/json',
        'Accept': 'text/html',
        'Authorization': 'Bearer token123',
        'X-Request-Id': 'abc-def-123',
        'Cache-Control': 'no-cache',
        'Accept-Language': 'en-US',
        'Content-Length': '1234',
        'User-Agent': 'benchmark/1.0',
        'Host': 'example.com',
        'Connection': 'keep-alive'
      });
      for (var i = 0; i < N; i++) {
        h.get('content-type');
        h.has('authorization');
        h.get('x-request-id');
        h.has('nonexistent');
      }
      return N;
    })()`,
  },
  'set operations': {
    description: 'Set 5 headers 20,000 times',
    code: `(function(){
      var N = 20000;
      var h = new Headers();
      for (var i = 0; i < N; i++) {
        h.set('Content-Type', 'text/plain');
        h.set('Accept', 'application/json');
        h.set('X-Count', String(i));
        h.set('Authorization', 'Bearer token');
        h.set('Cache-Control', 'max-age=3600');
      }
      return N;
    })()`,
  },
  'append + iterate': {
    description: 'Append 5 headers then iterate 10,000 times',
    code: `(function(){
      var N = 10000;
      for (var i = 0; i < N; i++) {
        var h = new Headers();
        h.append('Accept', 'text/html');
        h.append('Accept', 'application/json');
        h.append('Set-Cookie', 'a=1');
        h.append('Set-Cookie', 'b=2');
        h.append('Content-Type', 'text/plain');
        var entries = [];
        for (var pair of h) entries.push(pair);
      }
      return N;
    })()`,
  },
  'delete + reconstruct': {
    description: 'Build, delete, rebuild headers 20,000 times',
    code: `(function(){
      var N = 20000;
      for (var i = 0; i < N; i++) {
        var h = new Headers({'A': '1', 'B': '2', 'C': '3', 'D': '4'});
        h.delete('B');
        h.delete('D');
        h.set('E', '5');
        h.get('A');
        h.get('C');
        h.get('E');
      }
      return N;
    })()`,
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Headers Extension Benchmark: Native WASM vs JS Polyfill (whatwg-fetch)\n');
  console.log('='.repeat(85));

  // ── Part 1: Performance (tinybench) ────────────────────────────────────

  console.log('\n## Runtime Performance\n');

  const vmNative = await QuickJS.create({
    wasm: wasmBytes,
    extensions: [{ name: 'headers', wasm: headersExtBytes }],
  });

  const vmPolyfill = await QuickJS.create({ wasm: wasmBytes });
  vmPolyfill.evalCode(polyfillCode).dispose();

  // Warm up
  vmNative.evalCode("new Headers({'a': '1'}); var h = new Headers(); h.set('b', '2'); h.get('b');").dispose();
  vmPolyfill.evalCode("new Headers({'a': '1'}); var h = new Headers(); h.set('b', '2'); h.get('b');").dispose();

  for (const [name, { code }] of Object.entries(workloads)) {
    const bench = new Bench({ name, time: 500, iterations: 1, warmupTime: 200, warmupIterations: 1 });

    bench
      .add('Native WASM', () => {
        vmNative.evalCode(code).dispose();
      })
      .add('JS Polyfill (whatwg-fetch)', () => {
        vmPolyfill.evalCode(code).dispose();
      });

    await bench.run();

    console.log(`### ${name}`);
    console.table(bench.table());
    console.log('');
  }

  vmNative.dispose();
  vmPolyfill.dispose();

  // ── Part 2: Snapshot Size ──────────────────────────────────────────────

  console.log('='.repeat(85));
  console.log('\n## Snapshot Size Comparison\n');

  const vmBase = await QuickJS.create({ wasm: wasmBytes });
  const snapBase = QuickJS.serializeSnapshot(vmBase.snapshot());
  vmBase.dispose();

  const vmNSnap = await QuickJS.create({
    wasm: wasmBytes,
    extensions: [{ name: 'headers', wasm: headersExtBytes }],
  });
  const snapN = QuickJS.serializeSnapshot(vmNSnap.snapshot());
  vmNSnap.dispose();

  const vmPSnap = await QuickJS.create({ wasm: wasmBytes });
  vmPSnap.evalCode(polyfillCode).dispose();
  const snapP = QuickJS.serializeSnapshot(vmPSnap.snapshot());
  vmPSnap.dispose();

  const c1 = 30, c2 = 16, c3 = 16, c4 = 16;

  console.log(
    'Snapshot'.padEnd(c1) + 'Raw'.padStart(c2) +
    'Gzip'.padStart(c3) + 'Delta (raw)'.padStart(c4)
  );
  console.log('-'.repeat(c1 + c2 + c3 + c4));

  console.log(
    'Baseline'.padEnd(c1) +
    formatBytes(snapBase.byteLength).padStart(c2) +
    formatBytes(gzipSync(snapBase).byteLength).padStart(c3) +
    '—'.padStart(c4)
  );
  console.log(
    '+ Native extension'.padEnd(c1) +
    formatBytes(snapN.byteLength).padStart(c2) +
    formatBytes(gzipSync(snapN).byteLength).padStart(c3) +
    `+${formatBytes(snapN.byteLength - snapBase.byteLength)}`.padStart(c4)
  );
  console.log(
    '+ JS Polyfill'.padEnd(c1) +
    formatBytes(snapP.byteLength).padStart(c2) +
    formatBytes(gzipSync(snapP).byteLength).padStart(c3) +
    `+${formatBytes(snapP.byteLength - snapBase.byteLength)}`.padStart(c4)
  );

  console.log('\n' + '='.repeat(85));
  console.log('\nDone.');
}

main().catch(console.error);
