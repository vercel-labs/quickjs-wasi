/**
 * Base64 Extension Benchmark
 *
 * Compares the native WASM atob/btoa extension against
 * a pure JavaScript polyfill (core-js-pure) across two dimensions:
 *
 *   1. Runtime performance: btoa encoding, atob decoding
 *   2. Snapshot size: raw bytes and gzip-compressed
 */

import { QuickJS } from '../src/index.ts';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(resolve(__dirname, '..', 'quickjs.wasm'));
const base64ExtBytes = readFileSync(resolve(__dirname, '..', 'extensions', 'base64', 'base64.so'));
const polyfillCode = readFileSync(resolve(__dirname, 'base64-polyfill-bundle.js'), 'utf-8');

const workloads: Record<string, { code: string; description: string }> = {
  'btoa short ASCII': {
    description: 'Encode short ASCII string 50,000 times',
    code: `(function(){
      var N = 50000;
      for (var i = 0; i < N; i++) btoa('Hello, world!');
      return N;
    })()`,
  },
  'btoa long string': {
    description: 'Encode 1KB string 10,000 times',
    code: `(function(){
      var N = 10000;
      var str = '';
      for (var j = 0; j < 100; j++) str += 'ABCDEFGHIJ';
      for (var i = 0; i < N; i++) btoa(str);
      return N;
    })()`,
  },
  'btoa binary (Latin-1)': {
    description: 'Encode string with bytes 0-255 10,000 times',
    code: `(function(){
      var N = 10000;
      var str = '';
      for (var j = 0; j < 256; j++) str += String.fromCharCode(j);
      for (var i = 0; i < N; i++) btoa(str);
      return N;
    })()`,
  },
  'atob short': {
    description: 'Decode short base64 string 50,000 times',
    code: `(function(){
      var N = 50000;
      for (var i = 0; i < N; i++) atob('SGVsbG8sIHdvcmxkIQ==');
      return N;
    })()`,
  },
  'atob long': {
    description: 'Decode 1KB base64 string 10,000 times',
    code: `(function(){
      var N = 10000;
      var str = '';
      for (var j = 0; j < 100; j++) str += 'ABCDEFGHIJ';
      var encoded = btoa(str);
      for (var i = 0; i < N; i++) atob(encoded);
      return N;
    })()`,
  },
  'btoa + atob round-trip': {
    description: 'Encode then decode 20,000 times',
    code: `(function(){
      var N = 20000;
      for (var i = 0; i < N; i++) atob(btoa('Hello, world!'));
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
  console.log('Base64 Extension Benchmark: Native WASM vs JS Polyfill (core-js-pure)\n');
  console.log('='.repeat(85));
  console.log('\n## Runtime Performance\n');

  const vmNative = await QuickJS.create({
    wasm: wasmBytes,
    extensions: [{ name: 'base64', wasm: base64ExtBytes }],
  });

  const vmPolyfill = await QuickJS.create({ wasm: wasmBytes });
  vmPolyfill.evalCode(polyfillCode).dispose();

  // Warm up
  vmNative.evalCode("btoa('warmup'); atob('d2FybXVw');").dispose();
  vmPolyfill.evalCode("btoa('warmup'); atob('d2FybXVw');").dispose();

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
    padLeft('JS (core-js)', col3) +
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
    extensions: [{ name: 'base64', wasm: base64ExtBytes }],
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
