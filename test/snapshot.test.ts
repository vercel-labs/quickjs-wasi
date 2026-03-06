/**
 * Tests for QuickJS WASM.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { QuickJS } from '../src/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(__dirname, '..', 'quickjs.wasm');

let wasmBytes: Buffer;

beforeAll(() => {
  wasmBytes = readFileSync(wasmPath);
});

describe('Basic Eval', () => {
  it('should evaluate arithmetic', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using result = vm.evalCode('1 + 2');
    expect(result.isException).toBe(false);
    expect(result.toNumber()).toBe(3);
  });

  it('should evaluate string concatenation', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using result = vm.evalCode('"hello" + " " + "world"');
    expect(result.toString()).toBe('hello world');
  });
});

describe('unwrapResult', () => {
  it('should return the handle on success', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using result = vm.unwrapResult(vm.evalCode('42'));
    expect(result.toNumber()).toBe(42);
  });

  it('should throw on exception', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(() => {
      vm.unwrapResult(vm.evalCode('throw new Error("boom")'));
    }).toThrow('boom');
  });

  it('should throw with error name and message preserved', async () => {
    using vm = await QuickJS.create(wasmBytes);
    try {
      vm.unwrapResult(vm.evalCode('throw new TypeError("bad type")'));
      expect.unreachable();
    } catch (err: any) {
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('TypeError');
      expect(err.message).toBe('bad type');
    }
  });
});

describe('Cached Properties', () => {
  it('should provide cached vm.global', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.global).toBe(vm.global);
  });

  it('should provide cached vm.undefined, vm.null, vm.true, vm.false', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.undefined.isUndefined).toBe(true);
    expect(vm.null.isNull).toBe(true);
    expect(vm.dump(vm.true)).toBe(true);
    expect(vm.dump(vm.false)).toBe(false);
    expect(vm.undefined).toBe(vm.undefined);
    expect(vm.null).toBe(vm.null);
    expect(vm.true).toBe(vm.true);
    expect(vm.false).toBe(vm.false);
  });
});

describe('Promise Creation', () => {
  it('should create and resolve a promise via Deferred', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const deferred = vm.newPromise();
    expect(deferred.handle.promiseState).toBe(0);

    vm.setProp(vm.global, 'testPromise', deferred.handle);

    vm.unwrapResult(vm.evalCode(`
      globalThis.promiseResult = undefined;
      testPromise.then(value => {
        globalThis.promiseResult = "resolved: " + value;
      });
    `)).dispose();
    vm.executePendingJobs();

    // Resolve using the deferred API
    const val = vm.newString('hello from host');
    deferred.resolve(val);
    val.dispose();
    vm.executePendingJobs();

    const afterResolve = vm.global.getProp('promiseResult');
    expect(afterResolve.toString()).toBe('resolved: hello from host');
    afterResolve.dispose();

    deferred.handle.dispose();
    vm.dispose(false);
  });
});

describe('resolvePromise', () => {
  it('should resolve a fulfilled promise', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const promiseHandle = vm.unwrapResult(vm.evalCode('Promise.resolve(42)'));
    vm.executePendingJobs();

    const result = await vm.resolvePromise(promiseHandle);
    expect('value' in result).toBe(true);
    if ('value' in result) {
      expect(result.value.toNumber()).toBe(42);
      result.value.dispose();
    }
    promiseHandle.dispose();
    vm.dispose(false);
  });

  it('should resolve a rejected promise', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const promiseHandle = vm.unwrapResult(vm.evalCode('Promise.reject(new Error("fail"))'));
    vm.executePendingJobs();

    const result = await vm.resolvePromise(promiseHandle);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      const dumped = vm.dump(result.error);
      expect(dumped).toBeInstanceOf(Error);
      expect((dumped as Error).message).toBe('fail');
      result.error.dispose();
    }
    promiseHandle.dispose();
    vm.dispose(false);
  });
});

describe('Host Callbacks', () => {
  it('should call a sync host function that adds numbers', async () => {
    const vm = await QuickJS.create(wasmBytes);

    const addFn = vm.newFunction('add', (_this, ...args) => {
      return vm.newNumber(args[0].toNumber() + args[1].toNumber());
    });
    vm.setProp(vm.global, 'add', addFn);
    addFn.dispose();

    const result = vm.unwrapResult(vm.evalCode('add(3, 4)'));
    expect(result.toNumber()).toBe(7);
    result.dispose();

    vm.dispose(false);
  });

  it('should call a host function that returns a string', async () => {
    const vm = await QuickJS.create(wasmBytes);

    const greetFn = vm.newFunction('greet', (_this, ...args) => {
      return vm.newString(`Hello, ${args[0].toString()}!`);
    });
    vm.setProp(vm.global, 'greet', greetFn);
    greetFn.dispose();

    expect(vm.unwrapResult(vm.evalCode('greet("World")')).consume(h => h.toString())).toBe('Hello, World!');
    vm.dispose(false);
  });

  it('should call a host function multiple times', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const calls: string[] = [];

    const logFn = vm.newFunction('log', (_this, ...args) => {
      calls.push(args[0].toString());
      return vm.undefined;
    });
    vm.setProp(vm.global, 'log', logFn);
    logFn.dispose();

    vm.unwrapResult(vm.evalCode('log("first"); log("second"); log("third")')).dispose();
    expect(calls).toEqual(['first', 'second', 'third']);
    vm.dispose(false);
  });
});

describe('Async Host Callback', () => {
  it('should simulate an async host function with promise bridging', async () => {
    const vm = await QuickJS.create(wasmBytes);

    const dnsResolveFn = vm.newFunction('dnsResolve', (_this, ...args) => {
      const hostname = args[0].toString();
      const deferred = vm.newPromise();

      const ip = hostname === 'example.com' ? '93.184.216.34' : '127.0.0.1';
      const ipHandle = vm.newString(ip);
      deferred.resolve(ipHandle);
      ipHandle.dispose();
      vm.executePendingJobs();

      return deferred.handle;
    });

    vm.setProp(vm.global, 'dnsResolve', dnsResolveFn);
    dnsResolveFn.dispose();

    vm.unwrapResult(vm.evalCode(`
      globalThis.resolvedIP = "pending";
      dnsResolve("example.com").then(ip => {
        globalThis.resolvedIP = ip;
      });
    `)).dispose();
    vm.executePendingJobs();

    expect(vm.global.getProp('resolvedIP').consume(h => h.toString())).toBe('93.184.216.34');
    vm.dispose(false);
  });
});

describe('BigInt', () => {
  it('should create and extract bigint values', async () => {
    const vm = await QuickJS.create(wasmBytes);

    const h = vm.newBigInt(42n);
    expect(vm.typeof(h)).toBe('bigint');
    expect(h.toBigInt()).toBe(42n);
    h.dispose();

    // Negative
    const neg = vm.newBigInt(-1n);
    expect(neg.toBigInt()).toBe(-1n);
    neg.dispose();

    // Large value
    const large = vm.newBigInt(0x1_0000_0000n);
    expect(large.toBigInt()).toBe(4294967296n);
    large.dispose();

    vm.dispose(false);
  });
});

describe('newError', () => {
  it('should accept a string message', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const err = vm.newError('test message');
    const dumped = vm.dump(err) as Error;
    expect(dumped).toBeInstanceOf(Error);
    expect(dumped.message).toBe('test message');
    err.dispose();
    vm.dispose(false);
  });

  it('should accept a native Error object', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const nativeErr = new TypeError('bad type');
    const err = vm.newError(nativeErr);
    const dumped = vm.dump(err) as Error;
    expect(dumped).toBeInstanceOf(Error);
    expect(dumped.name).toBe('TypeError');
    expect(dumped.message).toBe('bad type');
    err.dispose();
    vm.dispose(false);
  });
});

describe('dump()', () => {
  it('should dump primitives', async () => {
    const vm = await QuickJS.create(wasmBytes);

    expect(vm.evalCode('42').consume(h => vm.dump(h))).toBe(42);
    expect(vm.evalCode('"hello"').consume(h => vm.dump(h))).toBe('hello');
    expect(vm.evalCode('true').consume(h => vm.dump(h))).toBe(true);
    expect(vm.evalCode('null').consume(h => vm.dump(h))).toBe(null);
    expect(vm.evalCode('undefined').consume(h => vm.dump(h))).toBe(undefined);

    vm.dispose(false);
  });

  it('should dump arrays', async () => {
    const vm = await QuickJS.create(wasmBytes);
    expect(vm.evalCode('[1, 2, 3]').consume(h => vm.dump(h))).toEqual([1, 2, 3]);
    vm.dispose(false);
  });

  it('should dump Error objects with name, message, and stack', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const err = vm.evalCode('new TypeError("test error")');
    const dumped = vm.dump(err) as Error;
    expect(dumped).toBeInstanceOf(Error);
    expect(dumped.name).toBe('TypeError');
    expect(dumped.message).toBe('test error');
    expect(dumped.stack).toBeDefined();
    err.dispose();
    vm.dispose(false);
  });

  it('should dump bigint', async () => {
    const vm = await QuickJS.create(wasmBytes);
    expect(vm.evalCode('BigInt(42)').consume(h => vm.dump(h))).toBe(42n);
    vm.dispose(false);
  });
});

describe('typeof', () => {
  it('should return correct typeof strings', async () => {
    const vm = await QuickJS.create(wasmBytes);

    const cases: [string, string][] = [
      ['42', 'number'],
      ['"hello"', 'string'],
      ['true', 'boolean'],
      ['undefined', 'undefined'],
      ['null', 'object'],
      ['({})', 'object'],
      ['(() => {})', 'function'],
      ['Symbol("test")', 'symbol'],
      ['BigInt(42)', 'bigint'],
    ];

    for (const [code, expected] of cases) {
      expect(vm.evalCode(code).consume(h => vm.typeof(h))).toBe(expected);
    }
    vm.dispose(false);
  });
});

describe('handle.consume()', () => {
  it('should use-then-dispose a handle', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.evalCode('1 + 2').consume(h => h.toNumber())).toBe(3);
  });
});

describe('Symbol.dispose', () => {
  it('should auto-dispose JSValueHandle with using', async () => {
    using vm = await QuickJS.create(wasmBytes);
    {
      using result = vm.unwrapResult(vm.evalCode('1 + 2'));
      expect(result.toNumber()).toBe(3);
    }
    // result is now disposed — vm should still be usable
    using result2 = vm.unwrapResult(vm.evalCode('3 + 4'));
    expect(result2.toNumber()).toBe(7);
  });

  it('should auto-dispose QuickJS VM with using', async () => {
    let leaked: QuickJS;
    {
      using vm = await QuickJS.create(wasmBytes);
      leaked = vm;
      using result = vm.unwrapResult(vm.evalCode('"alive"'));
      expect(result.toString()).toBe('alive');
    }
    // vm is now disposed
    expect(() => leaked.evalCode('1')).toThrow('disposed');
  });

  it('should work with multiple handles in sequence', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      using handle = vm.unwrapResult(vm.evalCode(`${i} * ${i}`));
      results.push(handle.toNumber());
    }
    expect(results).toEqual([0, 1, 4, 9, 16]);
  });
});

describe('hostToHandle', () => {
  it('should convert host values to QuickJS handles', async () => {
    const vm = await QuickJS.create(wasmBytes);

    vm.hostToHandle('hello').consume(h => vm.setProp(vm.global, 's', h));
    vm.hostToHandle(42).consume(h => vm.setProp(vm.global, 'n', h));
    vm.hostToHandle(true).consume(h => vm.setProp(vm.global, 'b', h));
    vm.hostToHandle(null).consume(h => vm.setProp(vm.global, 'nil', h));
    vm.hostToHandle([1, 2, 3]).consume(h => vm.setProp(vm.global, 'arr', h));
    vm.hostToHandle({ x: 10 }).consume(h => vm.setProp(vm.global, 'obj', h));

    expect(vm.evalCode('s').consume(h => h.toString())).toBe('hello');
    expect(vm.evalCode('n').consume(h => h.toNumber())).toBe(42);
    expect(vm.evalCode('b').consume(h => vm.dump(h))).toBe(true);
    expect(vm.evalCode('nil').consume(h => vm.dump(h))).toBe(null);
    expect(vm.evalCode('arr.length').consume(h => h.toNumber())).toBe(3);
    expect(vm.evalCode('obj.x').consume(h => h.toNumber())).toBe(10);

    vm.dispose(false);
  });

  it('should convert bigint', async () => {
    const vm = await QuickJS.create(wasmBytes);
    vm.hostToHandle(42n).consume(h => vm.setProp(vm.global, 'bi', h));
    expect(vm.evalCode('bi').consume(h => vm.dump(h))).toBe(42n);
    vm.dispose(false);
  });

  it('should convert Error', async () => {
    const vm = await QuickJS.create(wasmBytes);
    vm.hostToHandle(new TypeError('boom')).consume(h => vm.setProp(vm.global, 'e', h));
    expect(vm.evalCode('e.name').consume(h => h.toString())).toBe('TypeError');
    expect(vm.evalCode('e.message').consume(h => h.toString())).toBe('boom');
    vm.dispose(false);
  });
});

describe('vm.setProp', () => {
  it('should set properties via vm.setProp with string key', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const val = vm.newNumber(99);
    vm.setProp(vm.global, 'x', val);
    val.dispose();
    expect(vm.evalCode('x').consume(h => h.toNumber())).toBe(99);
    vm.dispose(false);
  });
});

describe('Snapshot and Restore', () => {
  it('should preserve simple state across snapshot/restore', async () => {
    const vm1 = await QuickJS.create(wasmBytes);
    vm1.unwrapResult(vm1.evalCode('globalThis.counter = 42')).dispose();

    const snapshot = vm1.snapshot();
    vm1.dispose(false);

    const vm2 = await QuickJS.restore(snapshot, wasmBytes);
    expect(vm2.evalCode('counter').consume(h => h.toNumber())).toBe(42);
    vm2.dispose(false);
  });

  it('should resolve a pending promise in a restored VM', async () => {
    // Create a promise inside QuickJS and store the resolve func on global
    const vm1 = await QuickJS.create(wasmBytes);
    vm1.unwrapResult(vm1.evalCode(`
      globalThis.stepResult = "not yet";
      let __resolve;
      globalThis.pendingStep = new Promise(r => { __resolve = r; });
      globalThis.__resolveFunc = __resolve;
      globalThis.pendingStep.then(value => {
        globalThis.stepResult = "completed: " + value;
      });
    `)).dispose();
    vm1.executePendingJobs();

    expect(vm1.global.getProp('stepResult').consume(h => h.toString())).toBe('not yet');

    const snapshot = vm1.snapshot();
    vm1.dispose(false);

    // Restore and resolve
    const vm2 = await QuickJS.restore(snapshot, wasmBytes);
    const restoredResolve = vm2.global.getProp('__resolveFunc');
    const arg = vm2.newString('step-42-result');
    vm2.callFunction(restoredResolve, vm2.undefined, arg).dispose();
    vm2.executePendingJobs();

    expect(vm2.global.getProp('stepResult').consume(h => h.toString())).toBe('completed: step-42-result');

    arg.dispose();
    restoredResolve.dispose();
    vm2.dispose(false);
  });

  it('should support host callback re-registration after restore', async () => {
    const vm1 = await QuickJS.create(wasmBytes);

    const fn = vm1.newFunction('hostAdd', (_this, ...args) => {
      return vm1.newNumber(args[0].toNumber() + args[1].toNumber());
    });
    vm1.setProp(vm1.global, 'hostAdd', fn);
    fn.dispose();

    expect(vm1.evalCode('hostAdd(10, 20)').consume(h => h.toNumber())).toBe(30);

    const snapshot = vm1.snapshot();
    vm1.dispose(false);

    const vm2 = await QuickJS.restore(snapshot, wasmBytes);
    vm2.registerHostCallback(1, (_this, ...args) => {
      return vm2.newNumber(args[0].toNumber() + args[1].toNumber());
    });

    const result = vm2.unwrapResult(vm2.evalCode('hostAdd(100, 200)'));
    expect(result.toNumber()).toBe(300);
    result.dispose();
    vm2.dispose(false);
  });
});
