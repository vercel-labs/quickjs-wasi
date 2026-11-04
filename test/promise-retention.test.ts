import { describe, expect, it, vi } from 'vitest';
import { JSException, JSValueHandle, QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('settled deferred ownership', () => {
  it.each([
    ['resolve', 'native exception'], ['reject', 'native exception'],
    ['resolve', 'host throw'], ['reject', 'host throw'],
    ['resolve', 'error shaping'], ['reject', 'error shaping'],
  ] as const)('releases the one-shot pair after %s %s', async (settle, stage) => {
    using vm = await QuickJS.create(wasmBytes);
    using reason = vm.newError('resolver failed');
    vm.global.setProp('reason', reason);
    using thrower = vm.evalCode('() => { throw reason; }');
    const original = vm._getExports();
    const owner = vm as unknown as { exports: typeof original; _ownedHandles: Set<JSValueHandle> };
    const before = owner._ownedHandles.size;

    const deferred = vm.newPromise();
    using source = deferred.handle;
    const resolvers = [...owner._ownedHandles];
    expect(resolvers).toHaveLength(before + 2);
    const releases = resolvers.map(resolver => vi.spyOn(resolver, 'dispose'));
    const failure = new Error('native invocation failed');
    // Substitute only the fallible call boundary. Native exception creation,
    // exception ownership, and resolver disposal still use the real WASM.
    const call = vi.fn((...args: Parameters<typeof original.qjs_call>) => {
      if (stage === 'host throw') throw failure;
      return original.qjs_call(thrower.ptr, args[1], args[2], args[3]);
    });
    const format = stage === 'error shaping'
      ? vi.spyOn(JSValueHandle.prototype, 'getProp').mockImplementationOnce(() => { throw failure; })
      : undefined;
    owner.exports = { ...original, qjs_call: call };
    let caught: unknown;
    try {
      try { deferred[settle](vm.true); } catch (error) { caught = error; }
      if (stage === 'native exception') {
        expect(caught).toBeInstanceOf(JSException);
        expect((caught as JSException).handle.identity).toBe(reason.identity);
        expect((caught as JSException).message).toBe('resolver failed');
      } else {
        expect(caught).toBe(failure);
      }
      deferred.resolve(vm.undefined);
      deferred.reject(vm.undefined);
      expect(call).toHaveBeenCalledTimes(1);
      for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
      expect(source.promiseState).toBe(0);
    } finally {
      owner.exports = original;
      format?.mockRestore();
      if (caught instanceof JSException) caught.dispose();
      for (const release of releases) release.mockRestore();
    }
    if (stage === 'error shaping') {
      // Error shaping failed after the native reason escaped into VM ownership.
      // Resolver cleanup must preserve that reason until its owner releases it.
      expect(owner._ownedHandles.size).toBe(before + 1);
      const escaped = [...owner._ownedHandles].find(value => value.identity === reason.identity);
      expect(escaped).toBeDefined();
      escaped!.dispose();
    }
    expect(owner._ownedHandles.size).toBe(before);
    using pending = vm.getException();
    expect(original.qjs_typeof(pending.ptr)).toBe(4);

    const fresh = vm.newPromise();
    using handle = fresh.handle;
    fresh.resolve(vm.true);
    expect(handle.promiseState).toBe(1);
  });

  it.each(['resolve', 'reject'] as const)('preserves earlier pending exceptions on successful %s', async settle => {
    using vm = await QuickJS.create(wasmBytes);
    const e = vm._getExports();
    for (const previous of [vm.newError('previous'), vm.null, vm.undefined]) {
      using reason = previous;
      const deferred = vm.newPromise();
      using handle = deferred.handle;
      using sentinel = new JSValueHandle(vm, e.qjs_throw(reason.ptr));
      deferred[settle](vm.true);
      using pending = vm.getException();
      expect(pending.identity).toBe(reason.identity);
      expect(handle.promiseState).toBe(settle === 'resolve' ? 1 : 2);
    }
  });

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
