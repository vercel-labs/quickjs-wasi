/**
 * Encoding Extension Benchmark
 *
 * Compares the native WASM TextEncoder/TextDecoder extension against
 * a pure JavaScript polyfill (fast-text-encoding) across two dimensions:
 *
 *   1. Runtime performance: encode, encodeInto, decode operations
 *   2. Snapshot size: raw bytes and gzip-compressed
 */

import { QuickJS } from '../src/index.ts';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(resolve(__dirname, '..', 'quickjs.wasm'));
const encodingExtBytes = readFileSync(resolve(__dirname, '..', 'extensions', 'encoding', 'encoding.so'));
const polyfillCode = readFileSync(resolve(__dirname, 'encoding-polyfill-bundle.js'), 'utf-8');

// ─── Benchmark Workloads ─────────────────────────────────────────────────────

const workloads: Record<string, { code: string; description: string; nativeOnly?: boolean }> = {
  'encode ASCII (short)': {
    description: 'Encode a short ASCII string 20,000 times',
    code: `(function(){
      var N = 20000;
      var encoder = new TextEncoder();
      for (var i = 0; i < N; i++) {
        encoder.encode('Hello, world!');
      }
      return N;
    })()`,
  },
  'encode ASCII (long)': {
    description: 'Encode a 1KB ASCII string 5,000 times',
    code: `(function(){
      var N = 5000;
      var encoder = new TextEncoder();
      var str = '';
      for (var j = 0; j < 100; j++) str += 'Hello wor';
      str += 'ld!!!!!!!!';
      for (var i = 0; i < N; i++) {
        encoder.encode(str);
      }
      return N;
    })()`,
  },
  'encode multi-byte': {
    description: 'Encode strings with multi-byte chars 10,000 times',
    code: `(function(){
      var N = 10000;
      var encoder = new TextEncoder();
      var str = '日本語テキスト€£¥';
      for (var i = 0; i < N; i++) {
        encoder.encode(str);
      }
      return N;
    })()`,
  },
  'encode emoji': {
    description: 'Encode strings with emoji (4-byte UTF-8) 10,000 times',
    code: `(function(){
      var N = 10000;
      var encoder = new TextEncoder();
      var str = '🌍🌎🌏🎉🎊💯🔥✨';
      for (var i = 0; i < N; i++) {
        encoder.encode(str);
      }
      return N;
    })()`,
  },
  'encodeInto': {
    description: 'encodeInto with reused buffer 20,000 times',
    nativeOnly: true,
    code: `(function(){
      var N = 20000;
      var encoder = new TextEncoder();
      var buf = new Uint8Array(256);
      var str = 'Hello, world! 日本語 🌍';
      for (var i = 0; i < N; i++) {
        encoder.encodeInto(str, buf);
      }
      return N;
    })()`,
  },
  'decode ASCII (short)': {
    description: 'Decode a short ASCII byte array 20,000 times',
    code: `(function(){
      var N = 20000;
      var decoder = new TextDecoder();
      var bytes = new Uint8Array([72,101,108,108,111,44,32,119,111,114,108,100,33]);
      for (var i = 0; i < N; i++) {
        decoder.decode(bytes);
      }
      return N;
    })()`,
  },
  'decode multi-byte': {
    description: 'Decode multi-byte UTF-8 byte array 10,000 times',
    code: `(function(){
      var N = 10000;
      var decoder = new TextDecoder();
      // '日本語テキスト€£¥' in UTF-8
      var encoder = new TextEncoder();
      var bytes = encoder.encode('日本語テキスト€£¥');
      for (var i = 0; i < N; i++) {
        decoder.decode(bytes);
      }
      return N;
    })()`,
  },
  'encode + decode round-trip': {
    description: 'Encode then decode 10,000 times',
    code: `(function(){
      var N = 10000;
      var encoder = new TextEncoder();
      var decoder = new TextDecoder();
      var str = 'Hello 🌍! Привет мир! 日本語 €100';
      for (var i = 0; i < N; i++) {
        decoder.decode(encoder.encode(str));
      }
      return N;
    })()`,
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Encoding Extension Benchmark: Native WASM vs JS Polyfill (fast-text-encoding)\n');
  console.log('='.repeat(85));

  // ── Part 1: Performance ──────────────────────────────────────────────────

  console.log('\n## Runtime Performance\n');

  // Create VMs
  const vmNative = await QuickJS.create({
    wasm: wasmBytes,
    extensions: [{ name: 'encoding', wasm: encodingExtBytes }],
  });

  const vmPolyfill = await QuickJS.create({ wasm: wasmBytes });
  vmPolyfill.evalCode(polyfillCode).dispose();

  // Warm up both VMs
  vmNative.evalCode('(function(){ new TextEncoder().encode("warmup"); new TextDecoder().decode(new Uint8Array([119])); })()').dispose();
  vmPolyfill.evalCode('(function(){ new TextEncoder().encode("warmup"); new TextDecoder().decode(new Uint8Array([119])); })()').dispose();

  const results: { name: string; nativeMs: number; polyfillMs: number; ops: number; nativeOnly: boolean }[] = [];

  for (const [name, { code, nativeOnly }] of Object.entries(workloads)) {
    // Run native
    const nativeStart = performance.now();
    const nativeResult = vmNative.evalCode(code);
    const nativeMs = performance.now() - nativeStart;
    const ops = Number(nativeResult.toString());
    nativeResult.dispose();

    let polyfillMs = 0;
    if (!nativeOnly) {
      // Run polyfill
      const polyfillStart = performance.now();
      const polyfillResult = vmPolyfill.evalCode(code);
      polyfillMs = performance.now() - polyfillStart;
      polyfillResult.dispose();
    }

    results.push({ name, nativeMs, polyfillMs, ops, nativeOnly: !!nativeOnly });
  }

  // Print performance table
  const col1 = 36;
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
    if (r.nativeOnly) {
      console.log(
        padRight(r.name, col1) +
        padLeft(`${r.nativeMs.toFixed(1)}ms`, col2) +
        padLeft('n/a', col3) +
        padLeft('—', col4)
      );
    } else {
      const speedup = r.polyfillMs / r.nativeMs;
      console.log(
        padRight(r.name, col1) +
        padLeft(`${r.nativeMs.toFixed(1)}ms`, col2) +
        padLeft(`${r.polyfillMs.toFixed(1)}ms`, col3) +
        padLeft(`${speedup.toFixed(1)}x`, col4)
      );
    }
  }

  console.log('');

  // Summary (only comparable workloads)
  const comparable = results.filter(r => !r.nativeOnly);
  const totalNative = comparable.reduce((s, r) => s + r.nativeMs, 0);
  const totalPolyfill = comparable.reduce((s, r) => s + r.polyfillMs, 0);
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
  const snapBaseGzip = gzipSync(snapBaseBytes);
  vmBase.dispose();

  // Native extension snapshot
  const vmNativeSnap = await QuickJS.create({
    wasm: wasmBytes,
    extensions: [{ name: 'encoding', wasm: encodingExtBytes }],
  });
  const snapNative = vmNativeSnap.snapshot();
  const snapNativeBytes = QuickJS.serializeSnapshot(snapNative);
  const snapNativeGzip = gzipSync(snapNativeBytes);
  vmNativeSnap.dispose();

  // Polyfill snapshot
  const vmPolySnap = await QuickJS.create({ wasm: wasmBytes });
  vmPolySnap.evalCode(polyfillCode).dispose();
  const snapPoly = vmPolySnap.snapshot();
  const snapPolyBytes = QuickJS.serializeSnapshot(snapPoly);
  const snapPolyGzip = gzipSync(snapPolyBytes);
  vmPolySnap.dispose();

  const sCol1 = 30;
  const sCol2 = 16;
  const sCol3 = 16;
  const sCol4 = 16;

  console.log(
    padRight('Snapshot', sCol1) +
    padLeft('Raw', sCol2) +
    padLeft('Gzip', sCol3) +
    padLeft('Delta (raw)', sCol4)
  );
  console.log('-'.repeat(sCol1 + sCol2 + sCol3 + sCol4));

  console.log(
    padRight('Baseline (no extensions)', sCol1) +
    padLeft(formatBytes(snapBaseBytes.byteLength), sCol2) +
    padLeft(formatBytes(snapBaseGzip.byteLength), sCol3) +
    padLeft('—', sCol4)
  );

  console.log(
    padRight('+ Native extension', sCol1) +
    padLeft(formatBytes(snapNativeBytes.byteLength), sCol2) +
    padLeft(formatBytes(snapNativeGzip.byteLength), sCol3) +
    padLeft(`+${formatBytes(snapNativeBytes.byteLength - snapBaseBytes.byteLength)}`, sCol4)
  );

  console.log(
    padRight('+ JS Polyfill', sCol1) +
    padLeft(formatBytes(snapPolyBytes.byteLength), sCol2) +
    padLeft(formatBytes(snapPolyGzip.byteLength), sCol3) +
    padLeft(`+${formatBytes(snapPolyBytes.byteLength - snapBaseBytes.byteLength)}`, sCol4)
  );

  // Extension binary size
  console.log('\n## Extension Binary Size\n');
  const extRaw = encodingExtBytes.byteLength;
  const extGzip = gzipSync(encodingExtBytes).byteLength;
  const polyRaw = Buffer.byteLength(polyfillCode, 'utf-8');
  const polyGzip = gzipSync(Buffer.from(polyfillCode, 'utf-8')).byteLength;

  console.log(
    padRight('File', sCol1) +
    padLeft('Raw', sCol2) +
    padLeft('Gzip', sCol3)
  );
  console.log('-'.repeat(sCol1 + sCol2 + sCol3));

  console.log(
    padRight('encoding.so (native)', sCol1) +
    padLeft(formatBytes(extRaw), sCol2) +
    padLeft(formatBytes(extGzip), sCol3)
  );

  console.log(
    padRight('encoding-polyfill.js', sCol1) +
    padLeft(formatBytes(polyRaw), sCol2) +
    padLeft(formatBytes(polyGzip), sCol3)
  );

  console.log('\n' + '='.repeat(85));
  console.log('\nDone.');
}

main().catch(console.error);
