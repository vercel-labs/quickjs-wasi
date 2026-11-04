import { describe, expect, it, vi } from 'vitest';
import { JSException, JSValueHandle, QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

const ampleMemory = 16 * 1024 * 1024;
const constrainedMemory = 227185;

async function capture(fillers: number) {
  using seed = await QuickJS.create({ wasm: wasmBytes, memoryLimit: ampleMemory });
  using holder = seed.evalCode('Object.create(Function.prototype)');
  const holderToken = seed.exportHandle(holder);
  void seed.true; void seed.undefined;
  seed.getMemoryUsage();
  const handles: JSValueHandle[] = [];
  try {
    // At the pinned NG arena layout, 22 shapes expose resolver-property OOM
    // with a real Promise result; 23 expose an exception-sentinel result.
    for (let i = 1; i <= fillers; i++) {
      const handle = seed.evalCode('Object.create(Function.prototype)');
      handle.defineProp(`filler_${i}`, seed.true);
      handles.push(handle);
    }
    return { snapshot: seed.snapshot(), holderToken };
  } finally {
    for (const handle of handles) handle.dispose();
  }
}

function expectFailure(create: () => unknown): void {
  try {
    const result = create() as { handle?: JSValueHandle };
    result.handle?.dispose();
    expect.unreachable('failed Promise construction must throw');
  } catch (error) {
    try {
      expect(error).toBeInstanceOf(JSException);
      expect((error as JSException).name).toBe('InternalError');
      expect((error as JSException).message).toBe('out of memory');
    } finally {
      if (error instanceof JSException) error.dispose();
    }
  }
}

function setPending(vm: QuickJS, value: JSValueHandle): void {
  using ignored = new JSValueHandle(vm, vm._getExports().qjs_throw(value.ptr));
}

describe('host Promise construction failures', () => {
  it.each([22, 23])('throws and releases partial native ownership with %i filler shapes', async fillers => {
    const { snapshot } = await capture(fillers);
    using vm = await QuickJS.restore(snapshot, { wasm: wasmBytes, memoryLimit: constrainedMemory });
    const before = vm.getMemoryUsage().objCount;
    expectFailure(() => vm.newPromise());
    vm.runGC();
    expect(vm.getMemoryUsage().objCount).toBe(before);
    expect(vm.evalCode('6 * 7').consume(value => value.toNumber())).toBe(42);
  });

  it.each([[22, 'resolve'], [22, 'reject'], [23, 'resolve'], [23, 'reject']] as const)(
    'preserves complete %s-shape controls through %s with sufficient memory', async (fillers, operation) => {
      const { snapshot } = await capture(fillers);
      using vm = await QuickJS.restore(snapshot, { wasm: wasmBytes, memoryLimit: ampleMemory });
      const deferred = vm.newPromise();
      using handle = deferred.handle;
      expect(handle.isPromise).toBe(true);
      expect(handle.promiseState).toBe(0);
      using pending = vm.getException();
      expect(vm._getExports().qjs_typeof(pending.ptr)).toBe(4); // JS_TAG_UNINITIALIZED: no pending exception.
      vm.markPromiseHandled(handle);
      deferred[operation](vm.true);
      expect(handle.promiseState).toBe(operation === 'resolve' ? 1 : 2);
      const result = await vm.resolvePromise(handle);
      expect('value' in result).toBe(operation === 'resolve');
      const value = 'value' in result ? result.value : result.error;
      expect(value.consume(handle => handle.toBoolean())).toBe(true);
    },
  );

  it.each(['object', 'null', 'undefined'] as const)('preserves an earlier %s exception on success', async kind => {
    using vm = await QuickJS.create(wasmBytes);
    using previous = kind === 'object' ? vm.newError('previous') : vm[kind].dup();
    setPending(vm, previous);
    const deferred = vm.newPromise();
    using handle = deferred.handle;
    using pending = vm.getException();
    if (kind === 'object') expect(pending.identity).toBe(previous.identity);
    else expect(kind === 'null' ? pending.isNull : pending.isUndefined).toBe(true);
    deferred.resolve(vm.true);
    expect(handle.promiseState).toBe(1);
  });

  it.each([[22, 'object'], [22, 'null'], [22, 'undefined'], [23, 'object'], [23, 'null'], [23, 'undefined']] as const)(
    'replaces an earlier %s-shape %s exception with fresh OOM', async (fillers, kind) => {
      const { snapshot, holderToken } = await capture(fillers);
      using vm = await QuickJS.restore(snapshot, { wasm: wasmBytes, memoryLimit: constrainedMemory });
      // The exported holder is an existing object: setting the pending error must
      // not allocate a guest object and move the constrained construction boundary.
      using previous = kind === 'object' ? vm.importHandle(holderToken) : vm[kind].dup();
      setPending(vm, previous);
      expectFailure(() => vm.newPromise());
      expect(vm.evalCode('6 * 7').consume(value => value.toNumber())).toBe(42);
    },
  );

  it.each([22, 23])('fails host Promise conversion before reading then with %i filler shapes', async fillers => {
    const { snapshot } = await capture(fillers);
    using vm = await QuickJS.restore(snapshot, { wasm: wasmBytes, memoryLimit: constrainedMemory });
    const hostPromise = Promise.resolve(true);
    let reads = 0;
    Object.defineProperty(hostPromise, 'then', { get() { reads++; return Promise.prototype.then; } });
    expectFailure(() => vm.hostToHandle(hostPromise));
    expect(reads).toBe(0);
  });
});

describe('Promise construction ABI ownership', () => {
  it.each([22, 23])('zeros native resolver outputs on failure with %i filler shapes', async fillers => {
    const { snapshot } = await capture(fillers);
    using vm = await QuickJS.restore(snapshot, { wasm: wasmBytes, memoryLimit: constrainedMemory });
    const e = vm._getExports();
    const out = e.wasm_malloc(8);
    expect(out).not.toBe(0);
    try {
      new DataView(e.memory.buffer).setBigUint64(out, 0xffffffffffffffffn, true);
      using result = new JSValueHandle(vm, e.qjs_new_promise(out, out + 4));
      const view = new DataView(e.memory.buffer);
      // Never dereference stale output pointers in the unfixed negative control.
      expect([e.qjs_is_exception(result.ptr), view.getUint32(out, true), view.getUint32(out + 4, true)]).toEqual([1, 0, 0]);
      using error = vm.getException();
      expect(error.getProp('message').consume(value => value.toString())).toBe('out of memory');
    } finally {
      e.wasm_free(out);
    }
  });

  it('returns callable resolvers with complete metadata on success', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const e = vm._getExports();
    const out = e.wasm_malloc(8);
    try {
      using promise = new JSValueHandle(vm, e.qjs_new_promise(out, out + 4));
      const view = new DataView(e.memory.buffer);
      using resolve = new JSValueHandle(vm, view.getUint32(out, true));
      using reject = new JSValueHandle(vm, view.getUint32(out + 4, true));
      for (const fn of [resolve, reject]) {
        expect(fn.isFunction).toBe(true);
        expect(fn.getProp('name').consume(value => value.toString())).toBe('');
        expect(fn.getProp('length').consume(value => value.toNumber())).toBe(1);
      }
      vm.callFunction(resolve, vm.undefined, vm.true).dispose();
      expect(promise.promiseState).toBe(1);
    } finally {
      e.wasm_free(out);
    }
  });

  it.each(['scratch allocation', 'native call'] as const)('does not publish resolvers after injected %s failure', async stage => {
    using vm = await QuickJS.create(wasmBytes);
    const original = vm._getExports();
    const failure = new Error('native call failed');
    const malloc = vi.fn(stage === 'scratch allocation' ? () => 0 : original.wasm_malloc);
    const free = vi.fn(original.wasm_free);
    const create = vi.fn(() => { throw failure; });
    const owner = vm as unknown as { exports: typeof original; _ownedHandles: Set<JSValueHandle> };
    const before = owner._ownedHandles.size;
    // WebAssembly exports are immutable; replace only this VM's wrapper reference.
    owner.exports = { ...original, wasm_malloc: malloc, wasm_free: free, qjs_new_promise: create };
    try {
      expect(() => vm.newPromise()).toThrow(stage === 'scratch allocation' ? 'Failed to allocate promise output buffer' : failure);
      expect(malloc).toHaveBeenCalledExactlyOnceWith(8);
      expect(create).toHaveBeenCalledTimes(stage === 'scratch allocation' ? 0 : 1);
      expect(free).toHaveBeenCalledTimes(stage === 'scratch allocation' ? 0 : 1);
      if (stage === 'native call') expect(free).toHaveBeenCalledWith(malloc.mock.results[0].value);
      expect(owner._ownedHandles.size).toBe(before);
    } finally {
      owner.exports = original;
    }
  });
});
