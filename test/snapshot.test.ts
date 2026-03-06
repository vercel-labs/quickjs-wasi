/**
 * Tests for QuickJS WASM: snapshot/restore, host callbacks, dump, promise bridging.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { QuickJS } from '../ts/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(__dirname, '..', 'quickjs.wasm');

let wasmBytes: Buffer;

beforeAll(() => {
  wasmBytes = readFileSync(wasmPath);
});

describe('Basic Eval', () => {
  it('should evaluate arithmetic', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const result = vm.evalCode('1 + 2');
    expect(result.isException).toBe(false);
    expect(result.toNumber()).toBe(3);
    result.dispose();
    vm.dispose();
  });

  it('should evaluate string concatenation', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const result = vm.evalCode('"hello" + " " + "world"');
    expect(result.toString()).toBe('hello world');
    result.dispose();
    vm.dispose();
  });
});

describe('Promise Creation', () => {
  it('should create and resolve a promise', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const { promise, resolve: resolveFunc, reject: rejectFunc } = vm.newPromise();
    expect(promise.promiseState).toBe(0);

    const global = vm.getGlobal();
    global.setProp('testPromise', promise);

    vm.evalCode(`
      globalThis.promiseResult = undefined;
      testPromise.then(value => {
        globalThis.promiseResult = "resolved: " + value;
      });
    `).dispose();
    vm.executePendingJobs();

    const beforeResolve = global.getProp('promiseResult');
    expect(beforeResolve.isUndefined).toBe(true);
    beforeResolve.dispose();

    const resolveValue = vm.newString('hello from host');
    const undefinedVal = vm.getUndefined();
    vm.callFunction(resolveFunc, undefinedVal, resolveValue).dispose();
    vm.executePendingJobs();

    const afterResolve = global.getProp('promiseResult');
    expect(afterResolve.toString()).toBe('resolved: hello from host');
    afterResolve.dispose();

    resolveValue.dispose();
    undefinedVal.dispose();
    resolveFunc.dispose();
    rejectFunc.dispose();
    promise.dispose();
    global.dispose();
    vm.dispose();
  });
});

describe('Host Callbacks', () => {
  it('should call a sync host function that adds numbers', async () => {
    const vm = await QuickJS.create(wasmBytes);

    const addFn = vm.newFunction('add', (_this, ...args) => {
      const a = args[0].toNumber();
      const b = args[1].toNumber();
      return vm.newNumber(a + b);
    });

    const global = vm.getGlobal();
    global.setProp('add', addFn);
    addFn.dispose();

    const result = vm.evalCode('add(3, 4)');
    expect(result.isException).toBe(false);
    expect(result.toNumber()).toBe(7);
    result.dispose();

    global.dispose();
    vm.dispose(false);
  });

  it('should call a host function that returns a string', async () => {
    const vm = await QuickJS.create(wasmBytes);

    const greetFn = vm.newFunction('greet', (_this, ...args) => {
      const name = args[0].toString();
      return vm.newString(`Hello, ${name}!`);
    });
    const global = vm.getGlobal();
    global.setProp('greet', greetFn);
    greetFn.dispose();

    const result = vm.evalCode('greet("World")');
    expect(result.toString()).toBe('Hello, World!');
    result.dispose();

    global.dispose();
    vm.dispose(false);
  });

  it('should call a host function multiple times', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const calls: string[] = [];

    const logFn = vm.newFunction('log', (_this, ...args) => {
      calls.push(args[0].toString());
      return vm.getUndefined();
    });
    const global = vm.getGlobal();
    global.setProp('log', logFn);
    logFn.dispose();

    vm.evalCode('log("first"); log("second"); log("third")').dispose();

    expect(calls).toEqual(['first', 'second', 'third']);

    global.dispose();
    vm.dispose(false);
  });
});

describe('Async Host Callback', () => {
  it('should simulate an async host function with promise bridging', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const global = vm.getGlobal();

    const dnsResolveFn = vm.newFunction('dnsResolve', (_this, ...args) => {
      const hostname = args[0].toString();
      const { promise, resolve, reject } = vm.newPromise();

      const ip = hostname === 'example.com' ? '93.184.216.34' : '127.0.0.1';
      const ipHandle = vm.newString(ip);
      const undef = vm.getUndefined();
      vm.callFunction(resolve, undef, ipHandle).dispose();
      vm.executePendingJobs();
      ipHandle.dispose();
      undef.dispose();
      resolve.dispose();
      reject.dispose();

      return promise;
    });

    global.setProp('dnsResolve', dnsResolveFn);
    dnsResolveFn.dispose();

    vm.evalCode(`
      globalThis.resolvedIP = "pending";
      dnsResolve("example.com").then(ip => {
        globalThis.resolvedIP = ip;
      });
    `).dispose();
    vm.executePendingJobs();

    const ipResult = global.getProp('resolvedIP');
    expect(ipResult.toString()).toBe('93.184.216.34');
    ipResult.dispose();

    global.dispose();
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

    const arr = vm.evalCode('[1, 2, 3]');
    const dumped = vm.dump(arr) as number[];
    expect(Array.isArray(dumped)).toBe(true);
    expect(dumped).toEqual([1, 2, 3]);
    arr.dispose();

    vm.dispose(false);
  });

  it('should dump Error objects', async () => {
    const vm = await QuickJS.create(wasmBytes);

    const err = vm.evalCode('new Error("test error")');
    const dumped = vm.dump(err);
    expect(dumped).toBeInstanceOf(Error);
    expect((dumped as Error).message).toBe('test error');
    err.dispose();

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
      const handle = vm.evalCode(code);
      expect(vm.typeof(handle)).toBe(expected);
      handle.dispose();
    }

    vm.dispose(false);
  });
});

describe('handle.consume()', () => {
  it('should use-then-dispose a handle', async () => {
    const vm = await QuickJS.create(wasmBytes);

    const result = vm.evalCode('1 + 2').consume(h => h.toNumber());
    expect(result).toBe(3);

    const global = vm.getGlobal();
    vm.newString('consumed').consume(h => global.setProp('test', h));
    const check = global.getProp('test');
    expect(check.toString()).toBe('consumed');
    check.dispose();

    global.dispose();
    vm.dispose(false);
  });
});

describe('hostToHandle', () => {
  it('should convert host values to QuickJS handles', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const global = vm.getGlobal();

    vm.hostToHandle('hello').consume(h => global.setProp('s', h));
    vm.hostToHandle(42).consume(h => global.setProp('n', h));
    vm.hostToHandle(true).consume(h => global.setProp('b', h));
    vm.hostToHandle(null).consume(h => global.setProp('nil', h));
    vm.hostToHandle([1, 2, 3]).consume(h => global.setProp('arr', h));
    vm.hostToHandle({ x: 10, y: 20 }).consume(h => global.setProp('obj', h));

    expect(vm.evalCode('s').consume(h => h.toString())).toBe('hello');
    expect(vm.evalCode('n').consume(h => h.toNumber())).toBe(42);
    expect(vm.evalCode('b').consume(h => vm.dump(h))).toBe(true);
    expect(vm.evalCode('nil').consume(h => vm.dump(h))).toBe(null);
    expect(vm.evalCode('arr.length').consume(h => h.toNumber())).toBe(3);
    expect(vm.evalCode('arr[1]').consume(h => h.toNumber())).toBe(2);
    expect(vm.evalCode('obj.x').consume(h => h.toNumber())).toBe(10);

    global.dispose();
    vm.dispose(false);
  });
});

describe('Snapshot and Restore', () => {
  it('should preserve simple state across snapshot/restore', async () => {
    const vm1 = await QuickJS.create(wasmBytes);
    vm1.evalCode(`
      globalThis.counter = 42;
      globalThis.message = "hello from snapshot";
    `).dispose();

    const snapshot = vm1.snapshot();
    vm1.dispose(false);

    const vm2 = await QuickJS.restore(snapshot, wasmBytes);

    expect(vm2.evalCode('globalThis.counter').consume(h => h.toNumber())).toBe(42);
    expect(vm2.evalCode('globalThis.message').consume(h => h.toString())).toBe('hello from snapshot');
    expect(vm2.evalCode('globalThis.counter + 1').consume(h => h.toNumber())).toBe(43);

    vm2.dispose(false);
  });

  it('should resolve a pending promise in a restored VM', async () => {
    const vm1 = await QuickJS.create(wasmBytes);
    const { promise, resolve: resolveFunc } = vm1.newPromise();
    const global1 = vm1.getGlobal();
    global1.setProp('pendingStep', promise);
    global1.setProp('__resolveFunc', resolveFunc);

    vm1.evalCode(`
      globalThis.stepResult = "not yet";
      globalThis.pendingStep.then(value => {
        globalThis.stepResult = "completed: " + value;
      });
    `).dispose();
    vm1.executePendingJobs();

    expect(global1.getProp('stepResult').consume(h => h.toString())).toBe('not yet');

    const snapshot = vm1.snapshot();
    vm1.dispose(false);

    // Restore in a fresh instance
    const vm2 = await QuickJS.restore(snapshot, wasmBytes);

    expect(vm2.evalCode('globalThis.stepResult').consume(h => h.toString())).toBe('not yet');

    const global2 = vm2.getGlobal();
    const restoredResolve = global2.getProp('__resolveFunc');
    expect(restoredResolve.isUndefined).toBe(false);

    const resolveArg = vm2.newString('step-42-result');
    const undef = vm2.getUndefined();
    vm2.callFunction(restoredResolve, undef, resolveArg).dispose();
    vm2.executePendingJobs();

    expect(global2.getProp('stepResult').consume(h => h.toString())).toBe('completed: step-42-result');

    resolveArg.dispose();
    undef.dispose();
    restoredResolve.dispose();
    global2.dispose();
    vm2.dispose(false);
  });

  it('should support host callback re-registration after restore', async () => {
    const vm1 = await QuickJS.create(wasmBytes);
    const global1 = vm1.getGlobal();

    const fn = vm1.newFunction('hostAdd', (_this, ...args) => {
      return vm1.newNumber(args[0].toNumber() + args[1].toNumber());
    });
    global1.setProp('hostAdd', fn);
    fn.dispose();

    expect(vm1.evalCode('hostAdd(10, 20)').consume(h => h.toNumber())).toBe(30);

    const snapshot = vm1.snapshot();
    global1.dispose();
    vm1.dispose(false);

    const vm2 = await QuickJS.restore(snapshot, wasmBytes);

    // Re-register callback ID 1
    vm2.registerHostCallback(1, (_this, ...args) => {
      return vm2.newNumber(args[0].toNumber() + args[1].toNumber());
    });

    const result = vm2.evalCode('hostAdd(100, 200)');
    expect(result.isException).toBe(false);
    expect(result.toNumber()).toBe(300);
    result.dispose();

    vm2.dispose(false);
  });
});
