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
