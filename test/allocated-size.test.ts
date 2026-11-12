import { describe, it, expect } from 'vitest';
import { QuickJS, JSException } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

// getAllocatedSize() counts what the runtime takes from linear memory, so
// it runs a little above or below getMemoryUsage().mallocSize (allocator
// rounding, partially filled small-object arenas, per-block overhead the
// engine adds). The two must stay close.
function expectCloseToMallocSize(vm: QuickJS): void {
  const usage = vm.getMemoryUsage();
  const allocated = vm.getAllocatedSize();
  expect(usage.allocatedSize).toBe(allocated);
  expect(Math.abs(allocated - usage.mallocSize)).toBeLessThan(256 * 1024 + usage.mallocSize * 0.05);
}

describe('vm.getAllocatedSize()', () => {
  it('should report the baseline of a fresh VM', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.getAllocatedSize()).toBeGreaterThan(0);
    expectCloseToMallocSize(vm);
  });

  it('should track mallocSize as a large array is allocated and freed', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const base = vm.getAllocatedSize();
    const baseMalloc = vm.getMemoryUsage().mallocSize;

    vm.evalCode(`
      globalThis.big = [];
      for (let i = 0; i < 100000; i++) big.push({ i, s: 'item-' + i });
    `).dispose();
    const grown = vm.getAllocatedSize();
    const grownMalloc = vm.getMemoryUsage().mallocSize;
    expect(grown - base).toBeGreaterThan(5 * 1024 * 1024);
    expect(Math.abs((grown - base) - (grownMalloc - baseMalloc))).toBeLessThan((grownMalloc - baseMalloc) * 0.05);
    expectCloseToMallocSize(vm);

    vm.evalCode('globalThis.big = null').dispose();
    vm.runGC();
    expect(vm.getAllocatedSize()).toBeLessThan(base + 64 * 1024);
    expectCloseToMallocSize(vm);
  });

  it('should count ArrayBuffer backing stores', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const base = vm.getAllocatedSize();
    vm.evalCode('globalThis.buf = new Uint8Array(32 * 1024 * 1024)').dispose();
    expect(vm.getAllocatedSize() - base).toBeGreaterThanOrEqual(32 * 1024 * 1024);
    expectCloseToMallocSize(vm);
  });

  it('should be the value memoryLimit is enforced against', async () => {
    const limit = 8 * 1024 * 1024;
    using vm = await QuickJS.create({ wasm: wasmBytes, memoryLimit: limit });
    try {
      vm.evalCode(`
        globalThis.held = [];
        for (let i = 0; i < 1000; i++) held.push(new Uint8Array(256 * 1024));
      `).dispose();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(JSException);
      (err as JSException).dispose();
    }
    // The retained buffers filled memory up to (but never past) the limit.
    const allocated = vm.getAllocatedSize();
    expect(allocated).toBeLessThanOrEqual(limit);
    expect(allocated).toBeGreaterThan(limit - 512 * 1024);
  });

  it('should survive snapshot and restore unchanged', async () => {
    const vm1 = await QuickJS.create(wasmBytes);
    vm1.evalCode(`
      globalThis.data = [];
      for (let i = 0; i < 50000; i++) data.push({ i, s: 'row-' + i });
    `).dispose();
    const before = vm1.getAllocatedSize();
    const snapshot = vm1.snapshot();
    vm1.dispose();

    using vm2 = await QuickJS.restore(snapshot, wasmBytes);
    expect(vm2.getAllocatedSize()).toBe(before);
    expectCloseToMallocSize(vm2);

    // The restored counter keeps tracking allocations and frees.
    vm2.evalCode('globalThis.more = new Uint8Array(4 * 1024 * 1024)').dispose();
    expect(vm2.getAllocatedSize() - before).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    vm2.evalCode('globalThis.more = null; globalThis.data = null').dispose();
    vm2.runGC();
    expect(vm2.getAllocatedSize()).toBeLessThan(before);
    expectCloseToMallocSize(vm2);
  });
});
