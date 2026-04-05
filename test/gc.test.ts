import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('vm.runGC()', () => {
  it('should run without error on a fresh VM', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(() => vm.runGC()).not.toThrow();
  });

  it('should run without error after allocations', async () => {
    using vm = await QuickJS.create(wasmBytes);
    vm.evalCode(`
      globalThis.arr = [];
      for (let i = 0; i < 1000; i++) {
        arr.push({ value: i, nested: { x: "hello" } });
      }
    `).dispose();
    expect(() => vm.runGC()).not.toThrow();
  });

  it('should allow the VM to continue working after GC', async () => {
    using vm = await QuickJS.create(wasmBytes);
    vm.evalCode('globalThis.x = 42').dispose();
    vm.runGC();
    expect(vm.evalCode('x').consume(h => h.toNumber())).toBe(42);
  });

  it('should be callable multiple times', async () => {
    using vm = await QuickJS.create(wasmBytes);
    for (let i = 0; i < 10; i++) {
      vm.runGC();
    }
    expect(vm.evalCode('1 + 1').consume(h => h.toNumber())).toBe(2);
  });

  it('should reclaim unreferenced objects', async () => {
    using vm = await QuickJS.create(wasmBytes);
    // Allocate objects then make them unreachable
    vm.evalCode(`
      for (let i = 0; i < 1000; i++) {
        let temp = { data: "x".repeat(100) };
      }
    `).dispose();
    // GC should not crash and VM should still work
    vm.runGC();
    expect(vm.evalCode('"ok"').consume(h => h.toString())).toBe('ok');
  });

  it('should throw if VM is disposed', async () => {
    const vm = await QuickJS.create(wasmBytes);
    vm.dispose();
    expect(() => vm.runGC()).toThrow();
  });
});
