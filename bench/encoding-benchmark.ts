/**
 * Encoding Extension Benchmark
 *
 * Compares the native WASM TextEncoder/TextDecoder extension against
 * a pure JavaScript polyfill (fast-text-encoding) across two dimensions:
 *
 *   1. Runtime performance: encode, encodeInto, decode operations
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Encoding Extension Benchmark: Native WASM vs JS Polyfill (fast-text-encoding)\n');
  console.log('='.repeat(85));

  // ── Part 1: Performance (tinybench) ────────────────────────────────────

  console.log('\n## Runtime Performance\n');

  const vmNative = await QuickJS.create({
    wasm: wasmBytes,
    extensions: [{ name: 'encoding', wasm: encodingExtBytes }],
  });

  const vmPolyfill = await QuickJS.create({ wasm: wasmBytes });
  vmPolyfill.evalCode(polyfillCode).dispose();

  // Warm up both VMs
  vmNative.evalCode('(function(){ new TextEncoder().encode("warmup"); new TextDecoder().decode(new Uint8Array([119])); })()').dispose();
  vmPolyfill.evalCode('(function(){ new TextEncoder().encode("warmup"); new TextDecoder().decode(new Uint8Array([119])); })()').dispose();

  for (const [name, { code, nativeOnly }] of Object.entries(workloads)) {
    const bench = new Bench({ name, time: 500, iterations: 1, warmupTime: 200, warmupIterations: 1 });

    bench.add('Native WASM', () => {
      vmNative.evalCode(code).dispose();
    });

    if (!nativeOnly) {
      bench.add('JS Polyfill (fast-text-encoding)', () => {
        vmPolyfill.evalCode(code).dispose();
      });
    }

    await bench.run();

    console.log(`### ${name}${nativeOnly ? ' (native only — polyfill lacks encodeInto)' : ''}`);
    console.table(bench.table());
    console.log('');
  }

  vmNative.dispose();
  vmPolyfill.dispose();

  // ── Part 2: Snapshot Size ──────────────────────────────────────────────

  console.log('='.repeat(85));
  console.log('\n## Snapshot Size Comparison\n');

  const vmBase = await QuickJS.create({ wasm: wasmBytes });
  const snapBaseBytes = QuickJS.serializeSnapshot(vmBase.snapshot());
  const snapBaseGzip = gzipSync(snapBaseBytes);
  vmBase.dispose();

  const vmNativeSnap = await QuickJS.create({
    wasm: wasmBytes,
    extensions: [{ name: 'encoding', wasm: encodingExtBytes }],
  });
  const snapNativeBytes = QuickJS.serializeSnapshot(vmNativeSnap.snapshot());
  const snapNativeGzip = gzipSync(snapNativeBytes);
  vmNativeSnap.dispose();

  const vmPolySnap = await QuickJS.create({ wasm: wasmBytes });
  vmPolySnap.evalCode(polyfillCode).dispose();
  const snapPolyBytes = QuickJS.serializeSnapshot(vmPolySnap.snapshot());
  const snapPolyGzip = gzipSync(snapPolyBytes);
  vmPolySnap.dispose();

  const c1 = 30, c2 = 16, c3 = 16, c4 = 16;

  console.log(
    'Snapshot'.padEnd(c1) + 'Raw'.padStart(c2) +
    'Gzip'.padStart(c3) + 'Delta (raw)'.padStart(c4)
  );
  console.log('-'.repeat(c1 + c2 + c3 + c4));

  console.log(
    'Baseline (no extensions)'.padEnd(c1) +
    formatBytes(snapBaseBytes.byteLength).padStart(c2) +
    formatBytes(snapBaseGzip.byteLength).padStart(c3) +
    '—'.padStart(c4)
  );
  console.log(
    '+ Native extension'.padEnd(c1) +
    formatBytes(snapNativeBytes.byteLength).padStart(c2) +
    formatBytes(snapNativeGzip.byteLength).padStart(c3) +
    `+${formatBytes(snapNativeBytes.byteLength - snapBaseBytes.byteLength)}`.padStart(c4)
  );
  console.log(
    '+ JS Polyfill'.padEnd(c1) +
    formatBytes(snapPolyBytes.byteLength).padStart(c2) +
    formatBytes(snapPolyGzip.byteLength).padStart(c3) +
    `+${formatBytes(snapPolyBytes.byteLength - snapBaseBytes.byteLength)}`.padStart(c4)
  );

  // Extension binary size
  console.log('\n## Extension Binary Size\n');
  const extRaw = encodingExtBytes.byteLength;
  const extGzip = gzipSync(encodingExtBytes).byteLength;
  const polyRaw = Buffer.byteLength(polyfillCode, 'utf-8');
  const polyGzip = gzipSync(Buffer.from(polyfillCode, 'utf-8')).byteLength;

  console.log(
    'File'.padEnd(c1) + 'Raw'.padStart(c2) + 'Gzip'.padStart(c3)
  );
  console.log('-'.repeat(c1 + c2 + c3));

  console.log(
    'encoding.so (native)'.padEnd(c1) +
    formatBytes(extRaw).padStart(c2) +
    formatBytes(extGzip).padStart(c3)
  );
  console.log(
    'encoding-polyfill.js'.padEnd(c1) +
    formatBytes(polyRaw).padStart(c2) +
    formatBytes(polyGzip).padStart(c3)
  );

  console.log('\n' + '='.repeat(85));
  console.log('\nDone.');
}

main().catch(console.error);
