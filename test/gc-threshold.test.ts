import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('vm.gcThreshold', () => {
  it('should return the default GC threshold', async () => {
    using vm = await QuickJS.create(wasmBytes);
    // Default threshold should be a positive number
    expect(vm.gcThreshold).toBeGreaterThan(0);
  });

  it('should set and get a custom GC threshold', async () => {
    using vm = await QuickJS.create(wasmBytes);
    vm.gcThreshold = 1024 * 1024; // 1 MB
    expect(vm.gcThreshold).toBe(1024 * 1024);
  });

  it('should round-trip various threshold values', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const values = [0, 1024, 65536, 1024 * 1024, 10 * 1024 * 1024];
    for (const val of values) {
      vm.gcThreshold = val;
      expect(vm.gcThreshold).toBe(val);
    }
  });

  it('should allow the VM to function with a custom threshold', async () => {
    using vm = await QuickJS.create(wasmBytes);
    vm.gcThreshold = 64 * 1024; // Low threshold, so GC runs frequently

    // Allocate a bunch of objects. This should still work, with more GC runs
    vm.evalCode(`
      for (let i = 0; i < 1000; i++) {
        let obj = { data: "x".repeat(100) };
      }
    `).dispose();

    expect(vm.evalCode('"ok"').consume(h => h.toString())).toBe('ok');
  });

  it('should throw if VM is disposed', async () => {
    const vm = await QuickJS.create(wasmBytes);
    vm.dispose();
    expect(() => vm.gcThreshold).toThrow();
    expect(() => { vm.gcThreshold = 1024; }).toThrow();
  });
});
