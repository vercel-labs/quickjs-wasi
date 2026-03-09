import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('custom clock (wasi.now)', () => {
  it('should use a fixed timestamp for Date.now()', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      wasi: {
        now: () => BigInt(1700000000000) * 1_000_000n,
      },
    });

    const result = vm.evalCode('Date.now()').consume(h => h.toNumber());
    expect(result).toBe(1700000000000);
  });

  it('should use a fixed timestamp for new Date()', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      wasi: {
        now: () => BigInt(1700000000000) * 1_000_000n,
      },
    });

    const result = vm.evalCode('new Date().toISOString()').consume(h => h.toString());
    expect(result).toBe('2023-11-14T22:13:20.000Z');
  });

  it('should support advancing time between calls', async () => {
    let currentTime = 1700000000000n;
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      wasi: {
        now: () => currentTime * 1_000_000n,
      },
    });

    const t1 = vm.evalCode('Date.now()').consume(h => h.toNumber());
    expect(t1).toBe(1700000000000);

    currentTime = 1700000001000n; // advance 1 second
    const t2 = vm.evalCode('Date.now()').consume(h => h.toNumber());
    expect(t2).toBe(1700000001000);
  });
});

describe('Math.random() PRNG seeding via wasi.now', () => {
  it('should produce identical sequences from two VMs with the same now() value', async () => {
    // QuickJS seeds its xorshift64* PRNG from the clock value during
    // context creation. Two VMs with the same now() produce the same sequence.
    const opts = {
      wasm: wasmBytes,
      wasi: { now: () => BigInt(1700000000000) * 1_000_000n },
    };

    using vm1 = await QuickJS.create(opts);
    using vm2 = await QuickJS.create(opts);

    const results1: number[] = [];
    const results2: number[] = [];
    for (let i = 0; i < 10; i++) {
      results1.push(vm1.evalCode('Math.random()').consume(h => h.toNumber()));
      results2.push(vm2.evalCode('Math.random()').consume(h => h.toNumber()));
    }
    expect(results1).toEqual(results2);
  });

  it('should produce different sequences with different now() values', async () => {
    using vm1 = await QuickJS.create({
      wasm: wasmBytes,
      wasi: { now: () => BigInt(1000) * 1_000_000n },
    });
    using vm2 = await QuickJS.create({
      wasm: wasmBytes,
      wasi: { now: () => BigInt(2000) * 1_000_000n },
    });

    const r1 = vm1.evalCode('Math.random()').consume(h => h.toNumber());
    const r2 = vm2.evalCode('Math.random()').consume(h => h.toNumber());
    expect(r1).not.toBe(r2);
  });
});

describe('options backwards compatibility', () => {
  it('should accept raw WASM bytes (Buffer)', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.evalCode('1 + 1').consume(h => h.toNumber())).toBe(2);
  });

  it('should accept QuickJSOptions with wasm field', async () => {
    using vm = await QuickJS.create({ wasm: wasmBytes });
    expect(vm.evalCode('1 + 1').consume(h => h.toNumber())).toBe(2);
  });

  it('should accept QuickJSOptions with wasi field', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      wasi: { now: () => BigInt(0) * 1_000_000n },
    });
    expect(vm.evalCode('Date.now()').consume(h => h.toNumber())).toBe(0);
  });
});

describe('restore with wasi options', () => {
  it('should use custom clock after restore', async () => {
    const vm1 = await QuickJS.create(wasmBytes);
    vm1.evalCode('globalThis.x = 42').dispose();
    const snapshot = vm1.snapshot();
    vm1.dispose();

    using vm2 = await QuickJS.restore(snapshot, {
      wasm: wasmBytes,
      wasi: {
        now: () => BigInt(9999999999999) * 1_000_000n,
      },
    });

    expect(vm2.evalCode('x').consume(h => h.toNumber())).toBe(42);
    expect(vm2.evalCode('Date.now()').consume(h => h.toNumber())).toBe(9999999999999);
  });
});
