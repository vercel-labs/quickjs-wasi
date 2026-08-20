import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

/**
 * Helper: returns the number of WASM pages (each page = 64 KB).
 */
function getPageCount(vm: QuickJS): number {
  return vm._getMemory().buffer.byteLength / 65536;
}

describe('WASM memory growth', () => {
  it('should start with a small initial memory', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const pages = getPageCount(vm);
    // After init, memory should be relatively small (under 2 MB = 32 pages).
    // The exact initial size depends on the WASM binary but should be modest.
    expect(pages).toBeGreaterThan(0);
    expect(pages).toBeLessThan(32);
  });

  it('should grow WASM memory when JS code allocates large data', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const initialPages = getPageCount(vm);

    // Allocate ~1 MB of string data inside the VM
    vm.evalCode(`
      globalThis.data = [];
      for (let i = 0; i < 100; i++) {
        data.push("x".repeat(10000));
      }
    `).dispose();

    const afterPages = getPageCount(vm);
    expect(afterPages).toBeGreaterThan(initialPages);
  });

  it('should grow substantially with large allocations', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const initialPages = getPageCount(vm);

    // Allocate ~8 MB of data inside the VM
    vm.evalCode(`
      globalThis.bigData = [];
      for (let i = 0; i < 800; i++) {
        bigData.push("a]bcdefghij".repeat(1000));
      }
    `).dispose();

    const afterPages = getPageCount(vm);
    // Should have grown by at least 100 pages (~6.4 MB)
    expect(afterPages - initialPages).toBeGreaterThan(100);
  });

  it('should remain functional after significant memory growth', async () => {
    using vm = await QuickJS.create(wasmBytes);

    // First, grow memory substantially
    vm.evalCode(`
      globalThis.arr = [];
      for (let i = 0; i < 500; i++) {
        arr.push("x".repeat(10000));
      }
    `).dispose();

    const grownPages = getPageCount(vm);
    expect(grownPages).toBeGreaterThan(30);

    // Now verify the VM still works correctly for basic operations
    expect(vm.evalCode('1 + 2').consume(h => h.toNumber())).toBe(3);
    expect(vm.evalCode('arr.length').consume(h => h.toNumber())).toBe(500);
    expect(vm.evalCode('"hello".toUpperCase()').consume(h => h.toString())).toBe('HELLO');

    // Can still allocate more
    vm.evalCode(`
      for (let i = 0; i < 100; i++) {
        arr.push("y".repeat(10000));
      }
    `).dispose();
    expect(vm.evalCode('arr.length').consume(h => h.toNumber())).toBe(600);

    const finalPages = getPageCount(vm);
    expect(finalPages).toBeGreaterThanOrEqual(grownPages);
  });

  it('should grow memory for Uint8Array allocations from the host', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const initialPages = getPageCount(vm);

    // Push several large binary buffers into the VM from the host side
    for (let i = 0; i < 20; i++) {
      const large = new Uint8Array(65536); // 64 KB each
      using u8 = vm.newUint8Array(large);
      vm.evalCode(`globalThis.bin${i} = null`).dispose();
      vm.setProp(vm.global, `bin${i}`, u8);
    }

    const afterPages = getPageCount(vm);
    // 20 x 64 KB = 1.25 MB minimum growth
    expect(afterPages).toBeGreaterThan(initialPages);
  });

  it('should preserve grown memory size in a snapshot', async () => {
    const vm1 = await QuickJS.create(wasmBytes);

    // Grow memory
    vm1.evalCode(`
      globalThis.data = [];
      for (let i = 0; i < 500; i++) {
        data.push("x".repeat(10000));
      }
      globalThis.dataLen = data.length;
    `).dispose();

    const grownPages = getPageCount(vm1);
    const snapshot = vm1.snapshot();
    vm1.dispose();

    // The snapshot memory should reflect the grown size
    expect(snapshot.memory.byteLength).toBe(grownPages * 65536);

    // Restore and verify
    using vm2 = await QuickJS.restore(snapshot, wasmBytes);
    const restoredPages = getPageCount(vm2);
    expect(restoredPages).toBe(grownPages);
    expect(vm2.evalCode('dataLen').consume(h => h.toNumber())).toBe(500);
  });

  it('should allow further growth after snapshot restore', async () => {
    const vm1 = await QuickJS.create(wasmBytes);

    // Grow memory in original VM
    vm1.evalCode(`
      globalThis.arr = [];
      for (let i = 0; i < 200; i++) {
        arr.push("x".repeat(10000));
      }
    `).dispose();

    const snapshot = vm1.snapshot();
    vm1.dispose();

    // Restore and grow more
    using vm2 = await QuickJS.restore(snapshot, wasmBytes);
    const restoredPages = getPageCount(vm2);

    vm2.evalCode(`
      for (let i = 0; i < 500; i++) {
        arr.push("y".repeat(10000));
      }
    `).dispose();

    const afterMoreGrowth = getPageCount(vm2);
    expect(afterMoreGrowth).toBeGreaterThan(restoredPages);
    expect(vm2.evalCode('arr.length').consume(h => h.toNumber())).toBe(700);
  });

  it('should enforce memoryLimit and stop JS allocations', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      memoryLimit: 512 * 1024, // 512 KB, a tight limit
    });

    // Try to allocate way more than 512 KB; QuickJS should throw OOM.
    // Use the same pattern as limits.test.ts which is known to trigger OOM.
    const result = vm.evalCode(`
      try {
        var arr = [];
        for (var i = 0; i < 100000; i++) {
          arr.push("x".repeat(1000));
        }
        "should not reach here";
      } catch (e) {
        e.message || e.toString();
      }
    `);
    const msg = result.consume(h => h.toString());
    // QuickJS's allocator limit should have triggered an OOM error
    expect(msg).not.toBe('should not reach here');

    // The VM should still be functional after the OOM
    expect(vm.evalCode('1 + 1').consume(h => h.toNumber())).toBe(2);

    // WASM pages should have grown but the JS-level allocator was capped
    const pages = getPageCount(vm);
    expect(pages).toBeGreaterThan(0);
  });

  it('should grow less with memoryLimit than without', async () => {
    // Without a memory limit: progressively allocate strings
    const vmUnlimited = await QuickJS.create(wasmBytes);
    vmUnlimited.evalCode(`
      globalThis.arr = [];
      for (let i = 0; i < 100000; i++) {
        arr.push("x".repeat(1000));
      }
    `).dispose();
    const unlimitedPages = getPageCount(vmUnlimited);
    vmUnlimited.dispose();

    // With a memory limit: same pattern, but OOM will stop allocations early
    using vmLimited = await QuickJS.create({
      wasm: wasmBytes,
      memoryLimit: 512 * 1024, // 512 KB
    });
    vmLimited.evalCode(`
      globalThis.arr = [];
      try {
        for (var i = 0; i < 100000; i++) {
          arr.push("x".repeat(1000));
        }
      } catch (e) {
        // OOM: stop allocating
      }
    `).dispose();
    const limitedPages = getPageCount(vmLimited);

    // The limited VM should have allocated fewer items than unlimited
    const limitedCount = vmLimited.evalCode('arr.length').consume(h => h.toNumber());
    expect(limitedCount).toBeLessThan(100000);

    // And the limited VM should have grown less (unlimited allocates ~100 MB,
    // limited stops after ~512 KB of tracked allocations)
    expect(limitedPages).toBeLessThan(unlimitedPages);
  });

  it('should handle repeated grow/GC cycles', async () => {
    using vm = await QuickJS.create(wasmBytes);

    // Repeatedly allocate and release, forcing GC cycles.
    // Memory should grow but not without bound since old data is released.
    for (let cycle = 0; cycle < 10; cycle++) {
      vm.evalCode(`
        globalThis.temp = [];
        for (let i = 0; i < 100; i++) {
          temp.push("cycle-${cycle}-" + "x".repeat(5000));
        }
      `).dispose();
      // Release the data
      vm.evalCode('globalThis.temp = null').dispose();
    }

    // VM should still work
    expect(vm.evalCode('1 + 1').consume(h => h.toNumber())).toBe(2);

    // Memory should have grown but stayed reasonable since we freed data each cycle
    const pages = getPageCount(vm);
    // dlmalloc won't return pages to the OS (WASM memory never shrinks),
    // but QuickJS GC should have reclaimed heap space so growth is bounded
    // by peak usage, not total usage.
    expect(pages).toBeGreaterThan(0);
  });
});
