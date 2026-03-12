/**
 * Headers Extension Benchmark
 *
 * Compares the native WASM Headers extension against
 * a pure JavaScript polyfill (whatwg-fetch) across two dimensions:
 *
 *   1. Runtime performance: construct, get, set, append, iterate
 *   2. Snapshot size: raw bytes and gzip-compressed
 */

import { QuickJS } from '../src/index.ts';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(resolve(__dirname, '..', 'quickjs.wasm'));
const headersExtBytes = readFileSync(resolve(__dirname, '..', 'extensions', 'headers', 'headers.so'));
const polyfillCode = readFileSync(resolve(__dirname, 'headers-polyfill-bundle.js'), 'utf-8');

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

function padRight(s: string, len: number): string {
  return s + ' '.repeat(Math.max(0, len - s.length));
}

function padLeft(s: string, len: number): string {
  return ' '.repeat(Math.max(0, len - s.length)) + s;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
  console.log('Headers Extension Benchmark: Native WASM vs JS Polyfill (whatwg-fetch)\n');
  console.log('='.repeat(85));
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

  const results: { name: string; nativeMs: number; polyfillMs: number; ops: number }[] = [];

  for (const [name, { code }] of Object.entries(workloads)) {
    const nativeStart = performance.now();
    const nativeResult = vmNative.evalCode(code);
    const nativeMs = performance.now() - nativeStart;
    const ops = Number(nativeResult.toString());
    nativeResult.dispose();

    const polyfillStart = performance.now();
    const polyfillResult = vmPolyfill.evalCode(code);
    const polyfillMs = performance.now() - polyfillStart;
    polyfillResult.dispose();

    results.push({ name, nativeMs, polyfillMs, ops });
  }

  const col1 = 32;
  const col2 = 14;
  const col3 = 14;
  const col4 = 12;

  console.log(
    padRight('Workload', col1) +
    padLeft('Native', col2) +
    padLeft('JS Polyfill', col3) +
    padLeft('Speedup', col4)
  );
  console.log('-'.repeat(col1 + col2 + col3 + col4));

  for (const r of results) {
    const speedup = r.polyfillMs / r.nativeMs;
    console.log(
      padRight(r.name, col1) +
      padLeft(`${r.nativeMs.toFixed(1)}ms`, col2) +
      padLeft(`${r.polyfillMs.toFixed(1)}ms`, col3) +
      padLeft(`${speedup.toFixed(1)}x`, col4)
    );
  }

  console.log('');
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

  // Snapshot size
  console.log('\n' + '='.repeat(85));
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

  const sCol1 = 30;
  const sCol2 = 16;
  const sCol3 = 16;
  const sCol4 = 16;

  console.log(
    padRight('Snapshot', sCol1) + padLeft('Raw', sCol2) +
    padLeft('Gzip', sCol3) + padLeft('Delta (raw)', sCol4)
  );
  console.log('-'.repeat(sCol1 + sCol2 + sCol3 + sCol4));

  console.log(
    padRight('Baseline', sCol1) +
    padLeft(formatBytes(snapBase.byteLength), sCol2) +
    padLeft(formatBytes(gzipSync(snapBase).byteLength), sCol3) +
    padLeft('—', sCol4)
  );
  console.log(
    padRight('+ Native extension', sCol1) +
    padLeft(formatBytes(snapN.byteLength), sCol2) +
    padLeft(formatBytes(gzipSync(snapN).byteLength), sCol3) +
    padLeft(`+${formatBytes(snapN.byteLength - snapBase.byteLength)}`, sCol4)
  );
  console.log(
    padRight('+ JS Polyfill', sCol1) +
    padLeft(formatBytes(snapP.byteLength), sCol2) +
    padLeft(formatBytes(gzipSync(snapP).byteLength), sCol3) +
    padLeft(`+${formatBytes(snapP.byteLength - snapBase.byteLength)}`, sCol4)
  );

  console.log('\n' + '='.repeat(85));
  console.log('\nDone.');
}

main().catch(console.error);
