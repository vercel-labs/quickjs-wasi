/**
 * Base64 Extension Benchmark
 *
 * Compares the native WASM atob/btoa extension against
 * a pure JavaScript polyfill (core-js-pure) across two dimensions:
 *
 *   1. Runtime performance: btoa encoding, atob decoding
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
const base64ExtBytes = readFileSync(resolve(__dirname, '..', 'extensions', 'base64', 'base64.so'));
const polyfillCode = readFileSync(resolve(__dirname, 'base64-polyfill-bundle.js'), 'utf-8');

// ─── Benchmark Workloads ─────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Base64 Extension Benchmark: Native WASM vs JS Polyfill (core-js-pure)\n');
  console.log('='.repeat(85));

  // ── Part 1: Performance (tinybench) ────────────────────────────────────

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

  for (const [name, { code }] of Object.entries(workloads)) {
    const bench = new Bench({ name, time: 500, iterations: 1, warmupTime: 200, warmupIterations: 1 });

    bench
      .add('Native WASM', () => {
        vmNative.evalCode(code).dispose();
      })
      .add('JS Polyfill (core-js)', () => {
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
    extensions: [{ name: 'base64', wasm: base64ExtBytes }],
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
