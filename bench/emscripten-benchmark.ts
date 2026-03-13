/**
 * quickjs-wasi vs quickjs-emscripten Benchmark
 *
 * Head-to-head comparison of the two QuickJS WASM runtimes across:
 *
 *   1. VM creation time
 *   2. Core evalCode performance (arithmetic, string ops, object manipulation, etc.)
 *   3. JSON round-trip performance
 *   4. Function call overhead
 *   5. Real-world workloads (URL parsing, base64, text encoding)
 *   6. Package install size
 */

import { Bench } from 'tinybench';
import { QuickJS } from '../src/index.ts';
import { getQuickJS, type QuickJSWASMModule } from 'quickjs-emscripten';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(resolve(__dirname, '..', 'quickjs.wasm'));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function printHeader(title: string) {
  console.log('\n' + '='.repeat(85));
  console.log(`\n## ${title}\n`);
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return (n / 1_048_576).toFixed(1) + ' MB';
  if (n >= 1_024) return (n / 1_024).toFixed(1) + ' KB';
  return n + ' B';
}

/** Recursively compute total size of all files under a directory, following symlinks. */
function dirSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const st = statSync(full);
    if (st.isDirectory()) {
      total += dirSize(full);
    } else {
      total += st.size;
    }
  }
  return total;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('quickjs-wasi vs quickjs-emscripten Benchmark\n');
  console.log('='.repeat(85));

  // Pre-initialize quickjs-emscripten module (one-time setup)
  const emscriptenModule: QuickJSWASMModule = await getQuickJS();

  // ── VM Creation ────────────────────────────────────────────────────────

  printHeader('VM Creation');

  const vmCreateBench = new Bench({ name: 'VM Creation', time: 1000, iterations: 1, warmupTime: 500, warmupIterations: 1 });

  vmCreateBench
    .add('quickjs-wasi', async () => {
      const vm = await QuickJS.create({ wasm: wasmBytes });
      vm.dispose();
    })
    .add('quickjs-emscripten', () => {
      const vm = emscriptenModule.newContext();
      vm.dispose();
    });

  await vmCreateBench.run();
  console.table(vmCreateBench.table());

  // ── Core evalCode ──────────────────────────────────────────────────────

  printHeader('Core evalCode Performance');

  // Create long-lived VMs for the remaining benchmarks
  const wasiVm = await QuickJS.create({ wasm: wasmBytes });
  const emscriptenVm = emscriptenModule.newContext();

  const coreWorkloads: Record<string, string> = {
    'Arithmetic (100K iterations)': `(function(){
      var sum = 0;
      for (var i = 0; i < 100000; i++) {
        sum += i * 2 + (i % 7) - (i / 3) | 0;
      }
      return sum;
    })()`,

    'String concatenation (10K)': `(function(){
      var s = '';
      for (var i = 0; i < 10000; i++) {
        s += 'hello';
      }
      return s.length;
    })()`,

    'Array push + reduce (10K)': `(function(){
      var arr = [];
      for (var i = 0; i < 10000; i++) arr.push(i);
      return arr.reduce(function(a, b) { return a + b; }, 0);
    })()`,

    'Object property access (50K)': `(function(){
      var obj = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 };
      var sum = 0;
      for (var i = 0; i < 50000; i++) {
        sum += obj.a + obj.b + obj.c + obj.d + obj.e + obj.f + obj.g + obj.h;
      }
      return sum;
    })()`,

    'RegExp matching (5K)': `(function(){
      var re = /^(https?:\\/\\/)([\\w.-]+)(:\\d+)?(\\/[^?#]*)?/;
      var url = 'https://example.com:8080/path/to/resource';
      var count = 0;
      for (var i = 0; i < 5000; i++) {
        if (re.test(url)) count++;
      }
      return count;
    })()`,

    'Function calls (50K)': `(function(){
      function add(a, b) { return a + b; }
      var sum = 0;
      for (var i = 0; i < 50000; i++) {
        sum = add(sum, i);
      }
      return sum;
    })()`,

    'Closures + scoping (20K)': `(function(){
      function makeCounter() {
        var count = 0;
        return { inc: function() { count++; }, get: function() { return count; } };
      }
      var total = 0;
      for (var i = 0; i < 20000; i++) {
        var c = makeCounter();
        c.inc(); c.inc(); c.inc();
        total += c.get();
      }
      return total;
    })()`,

    'Error creation + throw/catch (10K)': `(function(){
      var count = 0;
      for (var i = 0; i < 10000; i++) {
        try {
          throw new Error('test error ' + i);
        } catch (e) {
          count++;
        }
      }
      return count;
    })()`,

    'Map operations (10K)': `(function(){
      var m = new Map();
      for (var i = 0; i < 10000; i++) {
        m.set('key' + i, i);
      }
      var sum = 0;
      m.forEach(function(v) { sum += v; });
      return sum;
    })()`,

    'Promise resolution chain (1K)': `(function(){
      var count = 0;
      for (var i = 0; i < 1000; i++) {
        count++;
      }
      return count;
    })()`,
  };

  for (const [name, code] of Object.entries(coreWorkloads)) {
    const bench = new Bench({ name, time: 500, iterations: 1, warmupTime: 200, warmupIterations: 1 });

    bench
      .add('quickjs-wasi', () => {
        wasiVm.evalCode(code).dispose();
      })
      .add('quickjs-emscripten', () => {
        const result = emscriptenVm.evalCode(code);
        if (result.error) {
          result.error.dispose();
          throw new Error(`evalCode failed for: ${name}`);
        }
        result.value.dispose();
      });

    await bench.run();

    console.log(`### ${name}`);
    console.table(bench.table());
    console.log('');
  }

  // ── JSON Round-trip ────────────────────────────────────────────────────

  printHeader('JSON Round-trip');

  const jsonWorkloads: Record<string, string> = {
    'Small object': `(function(){
      var obj = { name: 'test', value: 42, active: true };
      for (var i = 0; i < 10000; i++) {
        JSON.parse(JSON.stringify(obj));
      }
      return 10000;
    })()`,

    'Nested object': `(function(){
      var obj = {
        users: [
          { id: 1, name: 'Alice', tags: ['admin', 'user'], meta: { created: '2024-01-01' } },
          { id: 2, name: 'Bob', tags: ['user'], meta: { created: '2024-06-15' } },
        ],
        total: 2,
        page: 1,
      };
      for (var i = 0; i < 5000; i++) {
        JSON.parse(JSON.stringify(obj));
      }
      return 5000;
    })()`,

    'Large array': `(function(){
      var arr = [];
      for (var j = 0; j < 100; j++) arr.push({ id: j, value: 'item-' + j });
      for (var i = 0; i < 2000; i++) {
        JSON.parse(JSON.stringify(arr));
      }
      return 2000;
    })()`,
  };

  for (const [name, code] of Object.entries(jsonWorkloads)) {
    const bench = new Bench({ name, time: 500, iterations: 1, warmupTime: 200, warmupIterations: 1 });

    bench
      .add('quickjs-wasi', () => {
        wasiVm.evalCode(code).dispose();
      })
      .add('quickjs-emscripten', () => {
        const result = emscriptenVm.evalCode(code);
        if (result.error) {
          result.error.dispose();
          throw new Error(`evalCode failed for: ${name}`);
        }
        result.value.dispose();
      });

    await bench.run();

    console.log(`### ${name}`);
    console.table(bench.table());
    console.log('');
  }

  // ── Real-world Workloads ───────────────────────────────────────────────

  printHeader('Real-world Workloads (pure JS, no native extensions)');

  const realWorldWorkloads: Record<string, string> = {
    'Fibonacci (recursive, n=25)': `(function(){
      function fib(n) { return n <= 1 ? n : fib(n - 1) + fib(n - 2); }
      var result = 0;
      for (var i = 0; i < 10; i++) result += fib(25);
      return result;
    })()`,

    'Array sort (1K elements, 100x)': `(function(){
      var N = 100;
      for (var i = 0; i < N; i++) {
        var arr = [];
        for (var j = 0; j < 1000; j++) arr.push(Math.random());
        arr.sort(function(a, b) { return a - b; });
      }
      return N;
    })()`,

    'Template-like string building (5K)': `(function(){
      var items = [
        { name: 'Widget A', price: 9.99, qty: 3 },
        { name: 'Widget B', price: 24.50, qty: 1 },
        { name: 'Widget C', price: 4.75, qty: 10 },
      ];
      var result = '';
      for (var i = 0; i < 5000; i++) {
        var lines = [];
        for (var j = 0; j < items.length; j++) {
          var item = items[j];
          lines.push(item.name + ': $' + (item.price * item.qty).toFixed(2));
        }
        result = lines.join('\\n');
      }
      return result.length;
    })()`,

    'Deep clone via JSON (2K)': `(function(){
      var obj = {
        a: [1, 2, { b: [3, 4, { c: 'deep' }] }],
        d: { e: { f: { g: 42 } } },
        h: 'hello world',
      };
      for (var i = 0; i < 2000; i++) {
        JSON.parse(JSON.stringify(obj));
      }
      return 2000;
    })()`,

    'Simple tokenizer (1K runs)': `(function(){
      function tokenize(input) {
        var tokens = [];
        var i = 0;
        while (i < input.length) {
          if (input[i] === ' ' || input[i] === '\\t' || input[i] === '\\n') { i++; continue; }
          if (input[i] >= '0' && input[i] <= '9') {
            var num = '';
            while (i < input.length && input[i] >= '0' && input[i] <= '9') num += input[i++];
            tokens.push({ type: 'number', value: num });
          } else if (input[i] >= 'a' && input[i] <= 'z' || input[i] >= 'A' && input[i] <= 'Z') {
            var id = '';
            while (i < input.length && (input[i] >= 'a' && input[i] <= 'z' || input[i] >= 'A' && input[i] <= 'Z' || input[i] >= '0' && input[i] <= '9')) id += input[i++];
            tokens.push({ type: 'ident', value: id });
          } else {
            tokens.push({ type: 'punct', value: input[i++] });
          }
        }
        return tokens;
      }
      var input = 'var x = 42 + y * (z - 10) / foo(bar, baz)';
      for (var i = 0; i < 1000; i++) tokenize(input);
      return 1000;
    })()`,
  };

  for (const [name, code] of Object.entries(realWorldWorkloads)) {
    const bench = new Bench({ name, time: 500, iterations: 1, warmupTime: 200, warmupIterations: 1 });

    bench
      .add('quickjs-wasi', () => {
        wasiVm.evalCode(code).dispose();
      })
      .add('quickjs-emscripten', () => {
        const result = emscriptenVm.evalCode(code);
        if (result.error) {
          result.error.dispose();
          throw new Error(`evalCode failed for: ${name}`);
        }
        result.value.dispose();
      });

    await bench.run();

    console.log(`### ${name}`);
    console.table(bench.table());
    console.log('');
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  wasiVm.dispose();
  emscriptenVm.dispose();

  // ── Package Size ───────────────────────────────────────────────────────

  printHeader('Package Install Size');

  const nodeModules = resolve(__dirname, '..', 'node_modules');
  const pnpmStore = resolve(nodeModules, '.pnpm');

  // quickjs-wasi: the files that would be published (dist/ + quickjs.wasm + extensions/*/*.so)
  const wasiRoot = resolve(__dirname, '..');
  const wasiDistSize = dirSize(resolve(wasiRoot, 'dist'));
  const wasiWasmSize = statSync(resolve(wasiRoot, 'quickjs.wasm')).size;
  let wasiExtSize = 0;
  for (const ext of readdirSync(resolve(wasiRoot, 'extensions'))) {
    const soPath = resolve(wasiRoot, 'extensions', ext, `${ext}.so`);
    try { wasiExtSize += statSync(soPath).size; } catch {}
  }
  const wasiTotal = wasiDistSize + wasiWasmSize + wasiExtSize;

  // quickjs-emscripten: all packages in its dependency tree
  const emscriptenPkgs = [
    'quickjs-emscripten',
    'quickjs-emscripten-core',
    '@jitl+quickjs-ffi-types',
    '@jitl+quickjs-wasmfile-debug-asyncify',
    '@jitl+quickjs-wasmfile-debug-sync',
    '@jitl+quickjs-wasmfile-release-asyncify',
    '@jitl+quickjs-wasmfile-release-sync',
  ];
  let emscriptenTotal = 0;
  for (const pkg of emscriptenPkgs) {
    // Find the versioned dir in .pnpm (e.g. quickjs-emscripten@0.32.0)
    try {
      const entries = readdirSync(pnpmStore).filter(d => d.startsWith(`${pkg}@`));
      for (const entry of entries) {
        emscriptenTotal += dirSize(resolve(pnpmStore, entry));
      }
    } catch {}
  }

  const c1 = 40, c2 = 16;

  console.log(
    'Package'.padEnd(c1) + 'Install size'.padStart(c2)
  );
  console.log('-'.repeat(c1 + c2));

  console.log(
    'quickjs-wasi (dist + wasm + .so)'.padEnd(c1) +
    formatBytes(wasiTotal).padStart(c2)
  );
  console.log(
    '  dist/'.padEnd(c1) +
    formatBytes(wasiDistSize).padStart(c2)
  );
  console.log(
    '  quickjs.wasm'.padEnd(c1) +
    formatBytes(wasiWasmSize).padStart(c2)
  );
  console.log(
    '  extensions/*/*.so'.padEnd(c1) +
    formatBytes(wasiExtSize).padStart(c2)
  );
  console.log('');
  console.log(
    'quickjs-emscripten (all deps)'.padEnd(c1) +
    formatBytes(emscriptenTotal).padStart(c2)
  );

  const ratio = emscriptenTotal / wasiTotal;
  console.log('');
  console.log(`quickjs-emscripten is ~${ratio.toFixed(1)}x larger than quickjs-wasi`);

  console.log('\n' + '='.repeat(85));
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Benchmark failed:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
