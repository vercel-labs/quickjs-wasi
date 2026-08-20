import { describe, it, expect } from 'vitest';
import { QuickJS, EvalFlags } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('newPromise / Deferred', () => {
  it('should create and resolve a promise via Deferred', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const deferred = vm.newPromise();
    expect(deferred.handle.promiseState).toBe(0);

    vm.setProp(vm.global, 'testPromise', deferred.handle);

    vm.evalCode(`
      globalThis.promiseResult = undefined;
      testPromise.then(value => {
        globalThis.promiseResult = "resolved: " + value;
      });
    `).dispose();
    vm.executePendingJobs();

    using val = vm.newString('hello from host');
    deferred.resolve(val);
    vm.executePendingJobs();

    using afterResolve = vm.global.getProp('promiseResult');
    expect(afterResolve.toString()).toBe('resolved: hello from host');

    deferred.handle.dispose();
    vm.dispose();
  });
});

describe('resolvePromise', () => {
  it('should resolve a fulfilled promise', async () => {
    const vm = await QuickJS.create(wasmBytes);
    using promiseHandle = vm.evalCode('Promise.resolve(42)');
    vm.executePendingJobs();

    const result = await vm.resolvePromise(promiseHandle);
    expect('value' in result).toBe(true);
    if ('value' in result) {
      expect(result.value.toNumber()).toBe(42);
      result.value.dispose();
    }
    vm.dispose();
  });

  it('should resolve a rejected promise', async () => {
    const vm = await QuickJS.create(wasmBytes);
    using promiseHandle = vm.evalCode('Promise.reject(new Error("fail"))');
    vm.executePendingJobs();

    const result = await vm.resolvePromise(promiseHandle);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      const dumped = vm.dump(result.error);
      expect(dumped).toBeInstanceOf(Error);
      expect((dumped as Error).message).toBe('fail');
      result.error.dispose();
    }
    vm.dispose();
  });

  it('should handle non-promise values', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using handle = vm.evalCode('"just a string"');

    const result = await vm.resolvePromise(handle);
    expect('value' in result).toBe(true);
    if ('value' in result) {
      expect(result.value.toString()).toBe('just a string');
      result.value.dispose();
    }
  });

  it('cannot be intercepted by patching Promise.prototype.then or Symbol.species', async () => {
    using vm = await QuickJS.create(wasmBytes);

    // Guest sabotages the prototype BEFORE the host ever touches a promise:
    // the subscription goes through the engine-level JS_PromiseThen, which
    // consults neither Promise.prototype.then nor Symbol.species.
    vm.evalCode(`
      globalThis.thenCalls = 0;
      const realThen = Promise.prototype.then;
      Promise.prototype.then = function (...args) {
        globalThis.thenCalls++;
        return realThen.apply(this, args);
      };
      Object.defineProperty(Promise, Symbol.species, {
        get() { globalThis.thenCalls += 1000; return Promise; }
      });
    `).dispose();

    using pending = vm.evalCode(`
      globalThis.trigger = null;
      new Promise((resolve) => { globalThis.trigger = resolve; })
    `);
    const resultPromise = vm.resolvePromise(pending);
    vm.evalCode('trigger("untouched")').dispose();
    vm.executePendingJobs();

    const result = await resultPromise;
    expect('value' in result).toBe(true);
    if ('value' in result) {
      expect(result.value.toString()).toBe('untouched');
      result.value.dispose();
    }

    using calls = vm.evalCode('globalThis.thenCalls');
    expect(calls.toNumber()).toBe(0);
  });

  it('module namespace resolution is not observable via patched then', async () => {
    using vm = await QuickJS.create(wasmBytes);
    vm.evalCode(`
      globalThis.thenCalls = 0;
      const realThen = Promise.prototype.then;
      Promise.prototype.then = function (...args) {
        globalThis.thenCalls++;
        return realThen.apply(this, args);
      };
    `).dispose();

    // Module evaluation chains eval_promise -> namespace in C via
    // JS_PromiseThen; the patched then must not observe (or hijack) it.
    using promise = vm.evalCode('export const x = 7;', '<mod>', EvalFlags.TYPE_MODULE);
    vm.executePendingJobs();
    const result = await vm.resolvePromise(promise);
    expect('value' in result).toBe(true);
    if ('value' in result) {
      expect(result.value.getProp('x').consume(h => h.toNumber())).toBe(7);
      result.value.dispose();
    }

    using calls = vm.evalCode('globalThis.thenCalls');
    expect(calls.toNumber()).toBe(0);
  });
});
