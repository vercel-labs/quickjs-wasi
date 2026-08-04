import { describe, it, expect } from 'vitest';
import { QuickJS, JSException } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('memoryLimit', () => {
  it('should throw when memory limit is exceeded', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      memoryLimit: 512 * 1024, // 512 KB
    });

    // Progressively allocate until we hit the limit
    const result = vm.evalCode(`
      try {
        var arr = [];
        for (var i = 0; i < 100000; i++) {
          arr.push("x".repeat(1000));
        }
        "ok";
      } catch (e) {
        e.message;
      }
    `);
    const msg = result.consume(h => h.toString());
    expect(msg).not.toBe('ok');
  });

  it('bounds RETAINED ArrayBuffer/TypedArray memory (issue #30)', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      memoryLimit: 8 * 1024 * 1024, // 8 MiB
    });

    // Regression: quickjs-ng's default usable-size returns 0 on
    // wasm32-wasi, so allocations were recorded as overhead only — the
    // per-allocation limit check saw each incoming size, but nothing
    // accumulated in malloc_size. Many sub-limit buffers (each well
    // under 8 MiB) therefore grew real linear memory without bound:
    // this exact loop reached ~150 MiB resident under the 8 MiB limit
    // with no exception. With wasi-libc's malloc_usable_size wired into
    // the runtime's malloc functions, retention is accounted and the
    // loop must throw close to the limit.
    const result = vm.evalCode(`
      globalThis.keep = [];
      try {
        for (var i = 0; i < 300; i++) {
          var b = new Uint8Array(512 * 1024);
          b[0] = 1;
          keep.push(b);
        }
        "no-throw";
      } catch (e) {
        "threw at " + keep.length;
      }
    `);
    const msg = result.consume((h) => h.toString());
    expect(msg).not.toBe('no-throw');
    // 8 MiB limit / 512 KiB buffers ⇒ must stop well before 32 pushes
    // (heap baseline eats some budget; the pre-fix behavior was 300).
    const count = Number(msg.replace('threw at ', ''));
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(32);

    // The accounting is real: mallocSize reflects the retained bytes.
    const usage = vm.getMemoryUsage();
    expect(usage.mallocSize).toBeGreaterThan(4 * 1024 * 1024);
    expect(usage.mallocSize).toBeLessThanOrEqual(9 * 1024 * 1024);
  });

  it('should allow normal operations within the limit', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      memoryLimit: 4 * 1024 * 1024, // 4 MB
    });

    expect(vm.evalCode('1 + 2').consume(h => h.toNumber())).toBe(3);

    const arrResult = vm.evalCode(`
      const arr = [];
      for (let i = 0; i < 100; i++) arr.push(i);
      arr.length;
    `).consume(h => h.toNumber());
    expect(arrResult).toBe(100);
  });

  it('should re-apply after snapshot restore', async () => {
    const vm1 = await QuickJS.create({
      wasm: wasmBytes,
      memoryLimit: 4 * 1024 * 1024,
    });
    vm1.evalCode('globalThis.x = 1').dispose();
    const snapshot = vm1.snapshot();
    vm1.dispose();

    // Restore with a tighter limit
    using vm2 = await QuickJS.restore(snapshot, {
      wasm: wasmBytes,
      memoryLimit: 512 * 1024,
    });

    expect(vm2.evalCode('x').consume(h => h.toNumber())).toBe(1);

    // Should hit the tighter limit
    const result = vm2.evalCode(`
      try {
        var arr = [];
        for (var i = 0; i < 100000; i++) {
          arr.push("x".repeat(1000));
        }
        "ok";
      } catch (e) {
        e.message;
      }
    `);
    const msg = result.consume(h => h.toString());
    expect(msg).not.toBe('ok');
  });
});

describe('interruptHandler', () => {
  it('should interrupt an infinite loop', async () => {
    let calls = 0;
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      interruptHandler: () => {
        calls++;
        return calls > 100;
      },
    });

    try {
      vm.evalCode('while (true) {}');
      expect.unreachable('should have been interrupted');
    } catch (err) {
      expect(err).toBeInstanceOf(JSException);
      (err as JSException).dispose();
    }
    expect(calls).toBeGreaterThan(100);

    // VM is still usable after interrupt
    expect(vm.evalCode('1 + 2').consume(h => h.toNumber())).toBe(3);
  });

  it('should not interrupt normal execution', async () => {
    let calls = 0;
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      interruptHandler: () => {
        calls++;
        return false;
      },
    });

    const result = vm.evalCode('1 + 2').consume(h => h.toNumber());
    expect(result).toBe(3);
    expect(calls).toBeGreaterThan(0);
  });

  it('should support time-based interrupts', async () => {
    const start = Date.now();
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      interruptHandler: () => {
        return Date.now() - start > 100; // 100ms timeout
      },
    });

    try {
      vm.evalCode('while (true) {}');
      expect.unreachable('should have been interrupted');
    } catch (err) {
      expect(err).toBeInstanceOf(JSException);
      (err as JSException).dispose();
    }
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('should work after snapshot restore', async () => {
    const vm1 = await QuickJS.create(wasmBytes);
    vm1.evalCode('globalThis.x = 1').dispose();
    const snapshot = vm1.snapshot();
    vm1.dispose();

    let calls = 0;
    using vm2 = await QuickJS.restore(snapshot, {
      wasm: wasmBytes,
      interruptHandler: () => {
        calls++;
        return calls > 100;
      },
    });

    expect(vm2.evalCode('x').consume(h => h.toNumber())).toBe(1);

    try {
      vm2.evalCode('while (true) {}');
      expect.unreachable('should have been interrupted');
    } catch (err) {
      expect(err).toBeInstanceOf(JSException);
      (err as JSException).dispose();
    }
  });
});
