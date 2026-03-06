import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('newPromise / Deferred', () => {
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

    using val = vm.newString('hello from host');
    deferred.resolve(val);
    vm.executePendingJobs();

    using afterResolve = vm.global.getProp('promiseResult');
    expect(afterResolve.toString()).toBe('resolved: hello from host');

    deferred.handle.dispose();
    vm.dispose(false);
  });
});

describe('resolvePromise', () => {
  it('should resolve a fulfilled promise', async () => {
    const vm = await QuickJS.create(wasmBytes);
    using promiseHandle = vm.unwrapResult(vm.evalCode('Promise.resolve(42)'));
    vm.executePendingJobs();

    const result = await vm.resolvePromise(promiseHandle);
    expect('value' in result).toBe(true);
    if ('value' in result) {
      expect(result.value.toNumber()).toBe(42);
      result.value.dispose();
    }
    vm.dispose(false);
  });

  it('should resolve a rejected promise', async () => {
    const vm = await QuickJS.create(wasmBytes);
    using promiseHandle = vm.unwrapResult(vm.evalCode('Promise.reject(new Error("fail"))'));
    vm.executePendingJobs();

    const result = await vm.resolvePromise(promiseHandle);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      const dumped = vm.dump(result.error);
      expect(dumped).toBeInstanceOf(Error);
      expect((dumped as Error).message).toBe('fail');
      result.error.dispose();
    }
    vm.dispose(false);
  });

  it('should handle non-promise values', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using handle = vm.unwrapResult(vm.evalCode('"just a string"'));

    const result = await vm.resolvePromise(handle);
    expect('value' in result).toBe(true);
    if ('value' in result) {
      expect(result.value.toString()).toBe('just a string');
      result.value.dispose();
    }
  });
});
