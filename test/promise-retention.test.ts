import { describe, expect, it } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('settled deferred ownership', () => {
  it.each(['resolve', 'reject'] as const)('releases both resolvers after %s', async (settle) => {
    using vm = await QuickJS.create({ wasm: wasmBytes, memoryLimit: 4 * 1024 * 1024 });
    vm.evalCode('globalThis.total = 0').dispose();
    for (let i = 0; i < 32; i++) {
      const deferred = vm.newPromise();
      vm.setProp(vm.global, 'pending', deferred.handle);
      vm.evalCode('pending.then(value => { total += value.length }, value => { total += value.length }); delete globalThis.pending').dispose();
      using value = vm.newString('x'.repeat(256 * 1024));
      deferred[settle](value);
      deferred.handle.dispose();
      vm.executePendingJobs();
      vm.runGC();
    }
    expect(vm.evalCode('total').consume(value => value.toNumber())).toBe(32 * 256 * 1024);
  });

  it.each(['resolve', 'reject'] as const)('keeps the first %s outcome when settled again', async (settle) => {
    using vm = await QuickJS.create(wasmBytes);
    const deferred = vm.newPromise();
    using value = vm.newString('first');
    deferred[settle](value);
    deferred.resolve(vm.undefined);
    deferred.reject(vm.undefined);
    const result = await vm.resolvePromise(deferred.handle);
    const handle = 'value' in result ? result.value : result.error;
    expect('value' in result).toBe(settle === 'resolve');
    expect(handle.toString()).toBe('first');
    handle.dispose();
    deferred.handle.dispose();
  });

  it('continues adopting a pending promise after releasing its resolvers', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const deferred = vm.newPromise();
    const inner = vm.newPromise();
    const settled = deferred.settled;
    deferred.resolve(inner.handle);
    deferred.reject(vm.undefined);
    using value = vm.newString('adopted');
    inner.resolve(value);
    inner.handle.dispose();
    vm.executePendingJobs();
    await settled;
    const result = await vm.resolvePromise(deferred.handle);
    expect('value' in result).toBe(true);
    if ('value' in result) {
      expect(result.value.toString()).toBe('adopted');
      result.value.dispose();
    }
    deferred.handle.dispose();
  });

  it.each(['resolve', 'reject'] as const)('ignores a reentrant %s while resolving with a thenable', async (nested) => {
    using vm = await QuickJS.create(wasmBytes);
    const deferred = vm.newPromise();
    const settleNow = vm.newFunction('settleNow', () => {
      deferred[nested](vm.undefined);
      return vm.undefined;
    });
    vm.setProp(vm.global, 'settleNow', settleNow);
    settleNow.dispose();
    using thenable = vm.evalCode(`({
      marker: 'thenable',
      get then() {
        settleNow();
        globalThis.keep = [];
        for (let i = 0; i < 5000; i++) keep.push({ x: i }, 'ab'.repeat(i % 7 + 1), [i]);
        return undefined;
      },
    })`);
    deferred.resolve(thenable);
    vm.executePendingJobs();
    expect(deferred.handle.promiseState).toBe(1); // fulfilled
    const result = await vm.resolvePromise(deferred.handle);
    expect('value' in result).toBe(true);
    if ('value' in result) {
      expect(result.value.consume(value => value.getProp('marker').consume(marker => marker.toString()))).toBe('thenable');
    }
    deferred.handle.dispose();
  });
});
