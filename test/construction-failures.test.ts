import { describe, expect, it } from 'vitest';
import { JSException, JSValueHandle, QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

const oversized = 'abcdefghijklmnopqrstuvwxyz012345'.repeat(32_768);
const memoryLimit = 512 * 1024;

function expectOOM(fn: () => unknown): void {
  try {
    const result = fn();
    if (result instanceof JSValueHandle) result.dispose();
    expect.unreachable('construction must throw instead of returning an exception handle');
  } catch (err) {
    try {
      expect(err).toBeInstanceOf(JSException);
      expect((err as JSException).name).toBe('InternalError');
      expect((err as JSException).message).toBe('out of memory');
      expect((err as JSException).handle.getProp('message').consume(h => h.toString())).toBe('out of memory');
    } finally {
      if (err instanceof JSException) err.dispose();
    }
  }
}

describe('guest allocation failures during host construction', () => {
  it.each(['string', 'symbol', 'ArrayBuffer', 'Uint8Array', 'Error'] as const)(
    'rejects an oversized %s and leaves the VM usable', async (kind) => {
      using vm = await QuickJS.create({ wasm: wasmBytes, memoryLimit });
      expectOOM(() => {
        switch (kind) {
          case 'string': return vm.newString(oversized);
          case 'symbol': return vm.newSymbolFor(oversized);
          case 'ArrayBuffer': return vm.newArrayBuffer(new Uint8Array(oversized.length));
          case 'Uint8Array': return vm.newUint8Array(new Uint8Array(oversized.length));
          case 'Error': return vm.newError(oversized);
        }
      });
      expect(vm.evalCode('6 * 7').consume(h => h.toNumber())).toBe(42);
    }
  );

  it('cleans up nested containers after a child allocation fails', async () => {
    using vm = await QuickJS.create({ wasm: wasmBytes, memoryLimit });
    // Warm the native error path before measuring retained guest objects.
    expectOOM(() => vm.newString(oversized));
    vm.runGC();
    const before = vm.getMemoryUsage().objCount;
    expectOOM(() => vm.hostToHandle({ rows: [{ ok: true }, { text: oversized }] }));
    vm.runGC();
    expect(vm.getMemoryUsage().objCount).toBe(before);
    expect(vm.hostToHandle({ rows: [false, null, true, undefined], text: 'intact' })
      .consume(h => vm.dump(h))).toEqual({ rows: [false, null, true, undefined], text: 'intact' });
  });

  it('keeps an exception alive across scope unwinding', async () => {
    using vm = await QuickJS.create({ wasm: wasmBytes, memoryLimit });
    expectOOM(() => vm.withScope(() => vm.newString(oversized)));
  });

  it('releases partially built containers when a host getter throws', async () => {
    using vm = await QuickJS.create({ wasm: wasmBytes, memoryLimit });
    const failure = new Error('host getter failed');
    const input = [{ ok: true }, { get value() { throw failure; } }];
    const before = vm.getMemoryUsage().objCount;
    expect(() => vm.hostToHandle(input)).toThrow(failure);
    vm.runGC();
    expect(vm.getMemoryUsage().objCount).toBe(before);
  });

  it.each(['construction', 'host error'] as const)(
    'makes callback %s OOM catchable in the guest', async (kind) => {
      using vm = await QuickJS.create({ wasm: wasmBytes, memoryLimit });
      using fn = vm.newFunction('fail', () => {
        if (kind === 'host error') throw new Error(oversized);
        return vm.hostToHandle({ nested: [oversized] });
      });
      vm.global.setProp('fail', fn);
      expect(vm.evalCode('try { fail(); "completed" } catch (e) { e.name + ": " + e.message }')
        .consume(h => h.toString())).toBe('InternalError: out of memory');
      expectOOM(() => vm.evalCode('fail()'));
      expect(vm.evalCode('6 * 7').consume(h => h.toNumber())).toBe(42);
    }
  );

  it('preserves a guest exception value when a callback propagates it', async () => {
    using vm = await QuickJS.create(wasmBytes);
    vm.evalCode('globalThis.failure = { message: "original", marker: 42 }').dispose();
    using fn = vm.newFunction('fail', () => vm.evalCode('throw failure'));
    vm.global.setProp('fail', fn);
    expect(vm.evalCode('try { fail() } catch (e) { e === failure && e.marker === 42 }')
      .consume(h => vm.dump(h))).toBe(true);
  });

  it.each(['fulfillment', 'rejection'] as const)(
    'rejects the guest promise when converting its %s exhausts the limit', async (kind) => {
      using vm = await QuickJS.create({ wasm: wasmBytes, memoryLimit });
      const host = kind === 'fulfillment' ? Promise.resolve(oversized) : Promise.reject(oversized);
      using converted = vm.hostToHandle(host);
      await Promise.resolve();
      expect(converted.promiseState).toBe(2);
      const settled = await vm.resolvePromise(converted);
      using error = 'error' in settled ? settled.error : settled.value;
      expect('error' in settled).toBe(true);
      expect(error.getProp('name').consume(h => h.toString())).toBe('InternalError');
      expect(error.getProp('message').consume(h => h.toString())).toBe('out of memory');
    }
  );
  it.each(['normalize', 'load'] as const)(
    'keeps a module %s error conversion OOM catchable in the guest', async (phase) => {
      using vm = await QuickJS.create({
        wasm: wasmBytes,
        memoryLimit,
        moduleLoader: {
          normalize: (_base, name) => { if (phase === 'normalize') throw new Error(oversized); return name; },
          load: () => { throw new Error(oversized); },
        },
      });
      using pending = vm.evalCode(`(async () => {
        try { await import('failure.js'); return 'completed' }
        catch (e) { return e.name + ': ' + e.message }
      })()`);
      vm.executePendingJobs();
      const settled = await vm.resolvePromise(pending);
      using result = 'value' in settled ? settled.value : settled.error;
      expect('value' in settled).toBe(true);
      expect(result.toString()).toBe('InternalError: out of memory');
    }
  );
});

describe('property write failures', () => {
  it('rejects array conversion when an inherited index setter throws', async () => {
    using vm = await QuickJS.create(wasmBytes);
    vm.evalCode(`Object.defineProperty(Array.prototype, '0', {
      configurable: true, set() { throw new RangeError('array setter failed') }
    })`).dispose();
    expect(() => vm.hostToHandle([42])).toThrow('array setter failed');
    vm.evalCode('delete Array.prototype[0]').dispose();
    expect(vm.hostToHandle([42]).consume(h => vm.dump(h))).toEqual([42]);
  });

  it.each(['vm string', 'vm symbol', 'handle string', 'handle symbol'] as const)(
    'propagates failed property writes through %s', async (path) => {
      using vm = await QuickJS.create(wasmBytes);
      using target = vm.evalCode(`new Proxy({}, {
        set() { throw new RangeError('setter failed') },
        defineProperty() { throw new RangeError('definition failed') }
      })`);
      using symbol = vm.newSymbolFor('key');
      using value = vm.newNumber(42);
      const key = path.endsWith('symbol') ? symbol : 'key';
      if (path === 'handle string') {
        expect(() => target.setProp('key', value)).toThrow('setter failed');
      } else if (path.startsWith('vm')) {
        expect(() => vm.setProp(target, key, value)).toThrow('setter failed');
      }
      expect(() => path.startsWith('vm')
        ? vm.defineProp(target, key, value)
        : target.defineProp(key, value)).toThrow('definition failed');
    }
  );

  it.each(['key', 'nul\0key', 'surrogate\ud800key'])(
    'preserves key %j while propagating setter failures', async (key) => {
      using vm = await QuickJS.create(wasmBytes);
      using target = vm.newObject();
      using first = vm.newNumber(1);
      using second = vm.newNumber(2);
      vm.defineProp(target, key, first);
      expect(target.getProp(key).consume(h => h.toNumber())).toBe(1);
      expect(() => vm.setProp(target, key, second)).toThrow(JSException);
    }
  );
});
