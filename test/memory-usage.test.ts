import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('vm.getMemoryUsage()', () => {
  it('should return valid stats on a fresh VM', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const usage = vm.getMemoryUsage();

    // A fresh VM should have some baseline allocations
    expect(usage.mallocSize).toBeGreaterThan(0);
    expect(usage.mallocCount).toBeGreaterThan(0);
    expect(usage.atomCount).toBeGreaterThan(0);
    expect(usage.objCount).toBeGreaterThan(0);
    expect(usage.shapeCount).toBeGreaterThan(0);
  });

  it('should show increased object count after allocations', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const before = vm.getMemoryUsage();

    vm.evalCode(`
      globalThis.arr = [];
      for (let i = 0; i < 100; i++) {
        arr.push({ x: i });
      }
    `).dispose();

    const after = vm.getMemoryUsage();
    expect(after.objCount).toBeGreaterThan(before.objCount);
    expect(after.mallocSize).toBeGreaterThan(before.mallocSize);
  });

  it('should show increased string count after string allocations', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const before = vm.getMemoryUsage();

    vm.evalCode(`
      globalThis.strings = [];
      for (let i = 0; i < 100; i++) {
        strings.push("string_" + i);
      }
    `).dispose();

    const after = vm.getMemoryUsage();
    expect(after.strCount).toBeGreaterThan(before.strCount);
    expect(after.strSize).toBeGreaterThan(before.strSize);
  });

  it('should show increased array count after array allocations', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const before = vm.getMemoryUsage();

    vm.evalCode(`
      globalThis.arrays = [];
      for (let i = 0; i < 50; i++) {
        arrays.push([1, 2, 3]);
      }
    `).dispose();

    const after = vm.getMemoryUsage();
    expect(after.arrayCount).toBeGreaterThan(before.arrayCount);
  });

  it('should show JS function count after function creation', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const before = vm.getMemoryUsage();

    vm.evalCode(`
      globalThis.funcs = [];
      for (let i = 0; i < 50; i++) {
        funcs.push(function() { return i; });
      }
    `).dispose();

    const after = vm.getMemoryUsage();
    expect(after.jsFuncCount).toBeGreaterThan(before.jsFuncCount);
  });

  it('should reflect GC in reduced counts', async () => {
    using vm = await QuickJS.create(wasmBytes);

    // Allocate objects
    vm.evalCode(`
      globalThis.temp = [];
      for (let i = 0; i < 200; i++) {
        temp.push({ data: "x".repeat(50) });
      }
    `).dispose();
    const afterAlloc = vm.getMemoryUsage();

    // Release references and run GC
    vm.evalCode('globalThis.temp = null').dispose();
    vm.runGC();
    const afterGC = vm.getMemoryUsage();

    // Object count should decrease after GC
    expect(afterGC.objCount).toBeLessThan(afterAlloc.objCount);
  });

  it('should report mallocLimit when memoryLimit is set', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      memoryLimit: 4 * 1024 * 1024,
    });
    const usage = vm.getMemoryUsage();
    expect(usage.mallocLimit).toBe(4 * 1024 * 1024);
  });

  it('should report 0 for mallocLimit when no limit is set', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const usage = vm.getMemoryUsage();
    expect(usage.mallocLimit).toBe(0);
  });

  it('should have all expected fields', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const usage = vm.getMemoryUsage();

    // Verify all fields exist and are numbers
    const fields = [
      'mallocSize', 'mallocLimit', 'memoryUsedSize',
      'mallocCount', 'memoryUsedCount', 'atomCount',
      'atomSize', 'strCount', 'strSize',
      'objCount', 'objSize', 'propCount',
      'propSize', 'shapeCount', 'shapeSize',
      'jsFuncCount', 'jsFuncSize', 'jsFuncCodeSize',
      'jsFuncPc2lineCount', 'jsFuncPc2lineSize',
      'cFuncCount', 'arrayCount', 'fastArrayCount',
      'fastArrayElements', 'binaryObjectCount', 'binaryObjectSize',
    ] as const;

    for (const field of fields) {
      expect(typeof usage[field]).toBe('number');
    }
  });

  it('should throw if VM is disposed', async () => {
    const vm = await QuickJS.create(wasmBytes);
    vm.dispose();
    expect(() => vm.getMemoryUsage()).toThrow();
  });
});
