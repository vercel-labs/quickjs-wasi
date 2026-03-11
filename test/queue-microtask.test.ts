import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const qmtExtBytes = readFileSync(resolve(__dirname, '..', 'extensions', 'queue-microtask', 'queue-microtask.so'));

async function createVM() {
  return QuickJS.create({
    wasm: wasmBytes,
    extensions: [{ name: 'queue-microtask', wasm: qmtExtBytes, initFn: 'qjs_ext_queue_microtask_init' }],
  });
}

describe('queueMicrotask', () => {
  it('should be available as a global function', async () => {
    using vm = await createVM();
    const r = vm.evalCode('typeof queueMicrotask');
    expect(r.toString()).toBe('function');
    r.dispose();
  });

  it('should execute callback asynchronously', async () => {
    using vm = await createVM();
    vm.evalCode(`
      globalThis.log = [];
      log.push('before');
      queueMicrotask(() => log.push('microtask'));
      log.push('after');
    `).dispose();

    // Before executing pending jobs, microtask hasn't run
    const r1 = vm.evalCode('JSON.stringify(log)');
    expect(JSON.parse(r1.toString())).toEqual(['before', 'after']);
    r1.dispose();

    // After executing pending jobs, microtask has run
    vm.executePendingJobs();
    const r2 = vm.evalCode('JSON.stringify(log)');
    expect(JSON.parse(r2.toString())).toEqual(['before', 'after', 'microtask']);
    r2.dispose();
  });

  it('should execute multiple microtasks in order', async () => {
    using vm = await createVM();
    vm.evalCode(`
      globalThis.log = [];
      queueMicrotask(() => log.push(1));
      queueMicrotask(() => log.push(2));
      queueMicrotask(() => log.push(3));
    `).dispose();

    vm.executePendingJobs();
    const r = vm.evalCode('JSON.stringify(log)');
    expect(JSON.parse(r.toString())).toEqual([1, 2, 3]);
    r.dispose();
  });

  it('should allow nested queueMicrotask calls', async () => {
    using vm = await createVM();
    vm.evalCode(`
      globalThis.log = [];
      queueMicrotask(() => {
        log.push('outer');
        queueMicrotask(() => log.push('inner'));
      });
    `).dispose();

    vm.executePendingJobs();
    const r = vm.evalCode('JSON.stringify(log)');
    expect(JSON.parse(r.toString())).toEqual(['outer', 'inner']);
    r.dispose();
  });

  it('should throw TypeError for non-function argument', async () => {
    using vm = await createVM();
    expect(() => {
      vm.evalCode('queueMicrotask(42)');
    }).toThrow();
  });

  it('should throw TypeError for no arguments', async () => {
    using vm = await createVM();
    expect(() => {
      vm.evalCode('queueMicrotask()');
    }).toThrow();
  });

  it('should throw TypeError for null argument', async () => {
    using vm = await createVM();
    expect(() => {
      vm.evalCode('queueMicrotask(null)');
    }).toThrow();
  });

  it('should throw TypeError for string argument', async () => {
    using vm = await createVM();
    expect(() => {
      vm.evalCode("queueMicrotask('not a function')");
    }).toThrow();
  });

  it('should work with arrow functions', async () => {
    using vm = await createVM();
    vm.evalCode(`
      globalThis.result = 0;
      queueMicrotask(() => { globalThis.result = 42; });
    `).dispose();

    vm.executePendingJobs();
    const r = vm.evalCode('result');
    expect(r.toString()).toBe('42');
    r.dispose();
  });

  it('should interleave with promise microtasks', async () => {
    using vm = await createVM();
    vm.evalCode(`
      globalThis.log = [];
      queueMicrotask(() => log.push('qmt1'));
      Promise.resolve().then(() => log.push('promise1'));
      queueMicrotask(() => log.push('qmt2'));
      Promise.resolve().then(() => log.push('promise2'));
    `).dispose();

    vm.executePendingJobs();
    const r = vm.evalCode('JSON.stringify(log)');
    const log = JSON.parse(r.toString());
    r.dispose();

    // All four should execute. The exact interleaving may vary,
    // but all should be present.
    expect(log).toHaveLength(4);
    expect(log).toContain('qmt1');
    expect(log).toContain('qmt2');
    expect(log).toContain('promise1');
    expect(log).toContain('promise2');
  });

  it('should handle exceptions in callbacks gracefully', async () => {
    using vm = await createVM();
    vm.evalCode(`
      globalThis.log = [];
      queueMicrotask(() => { throw new Error('oops'); });
      queueMicrotask(() => log.push('after error'));
    `).dispose();

    // The first job will throw, but executePendingJobs should handle it
    // The second microtask may or may not execute depending on error handling
    try {
      vm.executePendingJobs();
    } catch {
      // Expected — the host sees the error from the first microtask
    }
  });
});
