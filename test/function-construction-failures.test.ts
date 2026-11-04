import { describe, expect, it, vi } from 'vitest';
import { JSException, JSValueHandle, QuickJS, type HostFunction } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

const ampleMemory = 16 * 1024 * 1024;
const internedName = 'a'.repeat(1024 * 1024);

function expectFailure(create: () => unknown, message = 'out of memory'): void {
  try {
    const result = create();
    if (result instanceof JSValueHandle) result.dispose();
    expect.unreachable('failed construction must throw');
  } catch (error) {
    try {
      expect(error).toBeInstanceOf(JSException);
      expect((error as JSException).message).toBe(message);
      expect((error as JSException).name).toBe(message === 'out of memory' ? 'InternalError' : 'Error');
    } finally {
      if (error instanceof JSException) error.dispose();
    }
  }
}

function expectMetadata(fn: JSValueHandle, name: string): void {
  for (const [key, value] of [['name', name], ['length', 0]] as const) {
    const descriptor = fn.getOwnPropertyDescriptor(key);
    try {
      expect(descriptor).toMatchObject({ writable: false, enumerable: false, configurable: true });
      expect(descriptor?.value && fn.vm.dump(descriptor.value)).toBe(value);
    } finally {
      descriptor?.value?.dispose();
      descriptor?.get?.dispose();
      descriptor?.set?.dispose();
    }
  }
}

async function capture(kind: 'name' | 'properties') {
  using seed = await QuickJS.create({ wasm: wasmBytes, memoryLimit: ampleMemory });
  using holder = seed.evalCode('Object.create(Function.prototype)');
  seed.exportHandle(holder);
  void seed.true; void seed.undefined;
  seed.getMemoryUsage();
  const fillers: JSValueHandle[] = [];
  try {
    if (kind === 'name') {
      // Atom lookup can succeed even when allocating the callback's data string fails.
      seed.global.setProp(internedName, seed.true);
    } else {
      // At the pinned NG arena layout, 23 distinct shapes fill this size class.
      // An empty callback name then isolates property initialization from string/atom allocation.
      for (let i = 1; i <= 23; i++) {
        const filler = seed.evalCode('Object.create(Function.prototype)');
        filler.defineProp(`filler_${i}`, seed.true);
        fillers.push(filler);
      }
    }
    return {
      name: kind === 'name' ? internedName : '',
      // Property cap was qualified against a 1 KiB large allocation (227184 fails,
      // 227185 succeeds), leaving less than one 4 KiB arena but a working OOM reserve.
      memoryLimit: kind === 'name' ? seed.getMemoryUsage().mallocSize + 256 * 1024 : 227185,
      snapshot: seed.snapshot(),
    };
  } finally {
    for (const filler of fillers) filler.dispose();
  }
}

function setPending(vm: QuickJS, value: JSValueHandle): void {
  using ignored = new JSValueHandle(vm, vm._getExports().qjs_throw(value.ptr));
}

describe('host function construction failures', () => {
  it.each(['name', 'properties'] as const)('rejects failed %s initialization without reserving the name', async kind => {
    const fixture = await capture(kind);
    using vm = await QuickJS.restore(fixture.snapshot, { wasm: wasmBytes, memoryLimit: fixture.memoryLimit });
    let calls = 0;
    expectFailure(() => vm.newFunction(fixture.name, () => { calls++; return vm.true; }));
    expect(vm.unregisterHostCallback(fixture.name)).toBe(false);
    expect(calls).toBe(0);
    expect(vm.evalCode('6 * 7').consume(handle => handle.toNumber())).toBe(42);
  });

  it.each(['name', 'properties'] as const)('preserves complete %s controls with sufficient memory', async kind => {
    const fixture = await capture(kind);
    using vm = await QuickJS.restore(fixture.snapshot, { wasm: wasmBytes, memoryLimit: ampleMemory });
    let calls = 0;
    using fn = vm.newFunction(fixture.name, () => { calls++; return vm.true; });
    expectMetadata(fn, fixture.name);
    expect(vm.callFunction(fn, vm.undefined).consume(handle => handle.toBoolean())).toBe(true);
    expect(calls).toBe(1);
  });

  it.each(['named', 'ephemeral'] as const)('preserves an earlier object exception after successful %s construction', async kind => {
    using vm = await QuickJS.create(wasmBytes);
    using previous = vm.newError('previous');
    setPending(vm, previous);
    using fn = kind === 'named' ? vm.newFunction('probe', () => vm.true) : vm.newEphemeralFunction(() => vm.true);
    using pending = vm.getException();
    expect(pending.identity).toBe(previous.identity);
    expect(vm.callFunction(fn, vm.undefined).consume(handle => handle.toBoolean())).toBe(true);
    fn.dispose();
    expect(vm.unregisterHostCallback(kind === 'named' ? 'probe' : '__ephemeral:1')).toBe(kind === 'named');
  });

  it.each([['named', 'null'], ['ephemeral', 'null'], ['named', 'undefined'], ['ephemeral', 'undefined']] as const)('preserves successful %s construction with an earlier %s exception', async (kind, value) => {
    using vm = await QuickJS.create(wasmBytes);
    setPending(vm, vm[value]);
    using fn = kind === 'named' ? vm.newFunction('probe', () => vm.true) : vm.newEphemeralFunction(() => vm.true);
    using pending = vm.getException();
    expect(value === 'null' ? pending.isNull : pending.isUndefined).toBe(true);
    expect(vm.callFunction(fn, vm.undefined).consume(handle => handle.toBoolean())).toBe(true);
  });

  it.each(['name', 'properties'] as const)('replaces an earlier exception with fresh %s construction failure', async kind => {
    const fixture = await capture(kind);
    using vm = await QuickJS.restore(fixture.snapshot, { wasm: wasmBytes, memoryLimit: fixture.memoryLimit });
    setPending(vm, vm.true);
    expectFailure(() => vm.newFunction(fixture.name, () => vm.true));
    expect(vm.unregisterHostCallback(fixture.name)).toBe(false);
    expect(vm.evalCode('6 * 7').consume(handle => handle.toNumber())).toBe(42);
  });
});

describe('subscription setup rollback', () => {
  it('preserves an earlier exception while completing internal subscription setup', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const deferred = vm.newPromise();
    using handle = deferred.handle;
    using previous = vm.newError('previous');
    setPending(vm, previous);
    const settled = deferred.settled;
    using pending = vm.getException();
    expect(pending.identity).toBe(previous.identity);
    deferred.resolve(vm.true);
    vm.executePendingJobs();
    await settled;
    expect(vm.unregisterHostCallback('__settle:1')).toBe(false);
  });

  it('retries settled after callback construction fails, then caches successful setup', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const deferred = vm.newPromise();
    using handle = deferred.handle;
    const failure = new Error('callback construction failed');
    const factory = vm as unknown as { newInternalFunction(name: string, fn: HostFunction): JSValueHandle };
    const spy = vi.spyOn(factory, 'newInternalFunction').mockImplementationOnce(() => { throw failure; });
    try { expect(() => deferred.settled).toThrow(failure); }
    finally { spy.mockRestore(); }
    expect(vm.unregisterHostCallback('__settle:1')).toBe(false);
    const settled = deferred.settled;
    expect(deferred.settled).toBe(settled);
    deferred.resolve(vm.true);
    vm.executePendingJobs();
    await settled;
    expect(vm.unregisterHostCallback('__settle:2')).toBe(false);
  });

  it.each(['second callback', 'subscription'] as const)('releases partial resolvePromise setup after failed %s', async stage => {
    using vm = await QuickJS.create(wasmBytes);
    const deferred = vm.newPromise();
    using handle = deferred.handle;
    const failure = new Error('setup boundary failed');
    // Inject only the fallible setup boundary; the first callback and cleanup use real WASM.
    const factory = vm as unknown as { newInternalFunction(name: string, fn: HostFunction): JSValueHandle };
    const original = factory.newInternalFunction.bind(vm);
    let calls = 0;
    const spy = stage === 'second callback'
      ? vi.spyOn(factory, 'newInternalFunction').mockImplementation((name, callback) => {
        if (++calls === 2) throw failure;
        return original(name, callback);
      })
      : vi.spyOn(vm, 'promiseThenRaw').mockImplementation(() => { throw failure; });
    vm.runGC();
    const before = vm.getMemoryUsage().objCount;
    try { await expect(vm.resolvePromise(handle)).rejects.toBe(failure); }
    finally { spy.mockRestore(); }
    expect(vm.unregisterHostCallback('__onFulfilled:1')).toBe(false);
    expect(vm.unregisterHostCallback('__onRejected:1')).toBe(false);
    vm.runGC();
    expect(vm.getMemoryUsage().objCount).toBe(before);
    const resolved = vm.resolvePromise(handle);
    deferred.resolve(vm.true);
    vm.executePendingJobs();
    const result = await resolved;
    expect('value' in result).toBe(true);
    if ('value' in result) expect(result.value.consume(value => value.toBoolean())).toBe(true);
    else result.error.dispose();
  });

  it('does not cache settled when subscription fails', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const deferred = vm.newPromise();
    using handle = deferred.handle;
    const failure = new Error('subscription failed');
    const spy = vi.spyOn(vm, 'promiseThenRaw').mockImplementationOnce(() => { throw failure; });
    try { expect(() => deferred.settled).toThrow(failure); }
    finally { spy.mockRestore(); }
    expect(vm.unregisterHostCallback('__settle:1')).toBe(false);
    const settled = deferred.settled;
    deferred.reject(vm.false);
    vm.executePendingJobs();
    await settled;
    expect(vm.unregisterHostCallback('__settle:2')).toBe(false);
  });

  it('propagates a native subscription exception instead of returning its sentinel', async () => {
    using vm = await QuickJS.create(wasmBytes);
    try {
      const result = vm.promiseThenRaw(vm.undefined, vm.undefined, vm.undefined);
      result.dispose();
      expect.unreachable('non-promise subscription must throw');
    } catch (error) {
      try { expect(error).toBeInstanceOf(JSException); expect((error as JSException).name).toBe('TypeError'); }
      finally { if (error instanceof JSException) error.dispose(); }
    }
  });
});

describe('existing fallback results remain compatible with construction', () => {
  it.each([
    ['object', '({ a: 1 })', { a: 1 }],
    ['array', '[1, 2]', [1, 2]],
    ['error', 'new Error("guest")', { name: 'Error', message: 'guest' }],
    ['typed array', 'new Uint8Array([1, 2])', new Uint8Array([1, 2])],
    ['enumeration failure', 'new Proxy({}, { ownKeys() { throw new Error("keys failed"); } })', {}],
  ] as const)('preserves dump results and subsequent function creation for %s', async (kind, source, expected) => {
    using vm = await QuickJS.create(wasmBytes);
    using value = vm.evalCode(source);
    const dumped = vm.dump(value);
    if (kind === 'error') expect(dumped).toMatchObject(expected);
    else expect(dumped).toEqual(expected);
    using fn = vm.newFunction('after', () => vm.true);
    using previous = vm.getException();
    expect(vm.callFunction(fn, vm.undefined).consume(handle => handle.toBoolean())).toBe(true);
  });

  it.each([
    ['ordinary object', '({})', 'Value is not an ArrayBuffer or typed array'],
    ['detached buffer', '(() => { const b = new ArrayBuffer(8); b.transfer(); return b; })()', 'Failed to get ArrayBuffer data'],
    ['detached view', '(() => { const b = new ArrayBuffer(8), v = new Uint8Array(b); b.transfer(); return v; })()', 'Value is not an ArrayBuffer or typed array'],
  ] as const)('preserves the %s conversion error and permits the next function', async (_kind, source, message) => {
    using vm = await QuickJS.create(wasmBytes);
    using value = vm.evalCode(source);
    expect(() => value.toArrayBuffer()).toThrow(message);
    using fn = vm.newFunction('after', () => vm.true);
    using previous = vm.getException();
    expect(vm.callFunction(fn, vm.undefined).consume(handle => handle.toBoolean())).toBe(true);
  });

  it.each(['keys', 'getOwnPropertyNames', 'getOwnPropertyKeys', 'toString', 'hasOwnProperty', 'propertyIsEnumerable'] as const)('preserves the existing %s fallback and its pending error', async method => {
    using vm = await QuickJS.create(wasmBytes);
    using value = vm.evalCode('new Proxy({}, { ownKeys() { throw new Error("keys failed"); }, getOwnPropertyDescriptor() { throw new Error("descriptor failed"); }, get() { return () => { throw new Error("coercion failed"); }; } })');
    const result = method === 'hasOwnProperty' || method === 'propertyIsEnumerable' ? value[method]('x') : value[method]();
    expect(result).toEqual(method === 'toString' ? '<null>' : method === 'hasOwnProperty' || method === 'propertyIsEnumerable' ? false : []);
    using fn = vm.newFunction('after', () => vm.true);
    using previous = vm.getException();
    expect(previous.getProp('message').consume(handle => handle.toString())).toBe(method === 'toString' ? 'coercion failed' : method === 'hasOwnProperty' || method === 'propertyIsEnumerable' ? 'descriptor failed' : 'keys failed');
    expect(vm.callFunction(fn, vm.undefined).consume(handle => handle.toBoolean())).toBe(true);
  });
});
