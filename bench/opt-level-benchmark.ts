/**
 * -O2 vs -Oz A/B Benchmark
 *
 * Runs an identical set of CPU-bound JS workloads against two builds of our
 * own quickjs.wasm, one compiled with -O2 (speed) and one with -Oz (size),
 * to quantify the runtime cost of optimizing for size.
 *
 * Usage:
 *   QJS_O2_WASM=/tmp/qjs-O2.wasm QJS_OZ_WASM=/tmp/qjs-Oz.wasm \
 *     bun run bench/opt-level-benchmark.ts
 */

import { Bench } from 'tinybench';
import { QuickJS } from '../src/index.ts';
import { readFileSync } from 'node:fs';

const O2_PATH = process.env.QJS_O2_WASM ?? '/tmp/qjs-O2.wasm';
const OZ_PATH = process.env.QJS_OZ_WASM ?? '/tmp/qjs-Oz.wasm';

const o2Bytes = readFileSync(O2_PATH);
const ozBytes = readFileSync(OZ_PATH);

const workloads: Record<string, string> = {
  'Arithmetic (100K)': `(function(){
    var sum = 0;
    for (var i = 0; i < 100000; i++) sum += i * 2 + (i % 7) - (i / 3) | 0;
    return sum;
  })()`,

  'String concat (10K)': `(function(){
    var s = '';
    for (var i = 0; i < 10000; i++) s += 'hello';
    return s.length;
  })()`,

  'Array push + reduce (10K)': `(function(){
    var arr = [];
    for (var i = 0; i < 10000; i++) arr.push(i);
    return arr.reduce(function(a, b){ return a + b; }, 0);
  })()`,

  'Object prop access (50K)': `(function(){
    var obj = { a:1,b:2,c:3,d:4,e:5,f:6,g:7,h:8 };
    var sum = 0;
    for (var i = 0; i < 50000; i++) sum += obj.a+obj.b+obj.c+obj.d+obj.e+obj.f+obj.g+obj.h;
    return sum;
  })()`,

  'RegExp matching (5K)': `(function(){
    var re = /^(https?:\\/\\/)([\\w.-]+)(:\\d+)?(\\/[^?#]*)?/;
    var url = 'https://example.com:8080/path/to/resource';
    var count = 0;
    for (var i = 0; i < 5000; i++) if (re.test(url)) count++;
    return count;
  })()`,

  'Function calls (50K)': `(function(){
    function add(a,b){ return a+b; }
    var sum = 0;
    for (var i = 0; i < 50000; i++) sum = add(sum, i);
    return sum;
  })()`,

  'Fibonacci (recursive n=25)': `(function(){
    function fib(n){ return n <= 1 ? n : fib(n-1) + fib(n-2); }
    var result = 0;
    for (var i = 0; i < 10; i++) result += fib(25);
    return result;
  })()`,

  'Array sort (1K x100)': `(function(){
    for (var i = 0; i < 100; i++) {
      var arr = [];
      for (var j = 0; j < 1000; j++) arr.push(Math.random());
      arr.sort(function(a,b){ return a - b; });
    }
    return 100;
  })()`,

  'JSON round-trip nested (5K)': `(function(){
    var obj = { users:[{id:1,name:'Alice',tags:['admin','user']},{id:2,name:'Bob',tags:['user']}], total:2 };
    for (var i = 0; i < 5000; i++) JSON.parse(JSON.stringify(obj));
    return 5000;
  })()`,

  'Map operations (10K)': `(function(){
    var m = new Map();
    for (var i = 0; i < 10000; i++) m.set('key'+i, i);
    var sum = 0;
    m.forEach(function(v){ sum += v; });
    return sum;
  })()`,
};

function fmt(n: number | undefined): string {
  if (n == null) return '-';
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

async function main() {
  console.log('-O2 vs -Oz A/B Benchmark (quickjs-wasi)\n');
  console.log(`  -O2 wasm: ${O2_PATH} (${o2Bytes.length.toLocaleString()} bytes)`);
  console.log(`  -Oz wasm: ${OZ_PATH} (${ozBytes.length.toLocaleString()} bytes)`);
  console.log('='.repeat(78));

  const o2Vm = await QuickJS.create({ wasm: o2Bytes });
  const ozVm = await QuickJS.create({ wasm: ozBytes });

  const rows: Array<{ Workload: string; 'O2 ops/s': string; 'Oz ops/s': string; 'Oz vs O2': string }> = [];

  for (const [name, code] of Object.entries(workloads)) {
    const bench = new Bench({ name, time: 800, iterations: 5, warmupTime: 300, warmupIterations: 3 });
    bench
      .add('O2', () => { o2Vm.evalCode(code).dispose(); })
      .add('Oz', () => { ozVm.evalCode(code).dispose(); });
    await bench.run();

    const o2Task = bench.getTask('O2')!;
    const ozTask = bench.getTask('Oz')!;
    const o2Hz = o2Task.result?.throughput.mean ?? 0;
    const ozHz = ozTask.result?.throughput.mean ?? 0;
    const ratio = o2Hz > 0 ? ozHz / o2Hz : 0;
    const pct = (ratio - 1) * 100;

    rows.push({
      Workload: name,
      'O2 ops/s': fmt(o2Hz),
      'Oz ops/s': fmt(ozHz),
      'Oz vs O2': `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`,
    });
  }

  o2Vm.dispose();
  ozVm.dispose();

  console.table(rows);

  // Geometric mean of the ratios
  const ratios = rows.map((r) => 1 + parseFloat(r['Oz vs O2']) / 100);
  const geo = Math.exp(ratios.reduce((a, b) => a + Math.log(b), 0) / ratios.length);
  console.log(`\nGeometric mean: Oz runs at ${(geo * 100).toFixed(1)}% of O2 throughput ` +
    `(${geo >= 1 ? '+' : ''}${((geo - 1) * 100).toFixed(1)}%)`);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
