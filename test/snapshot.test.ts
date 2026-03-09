import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('snapshot and restore', () => {
  it('should preserve simple state across snapshot/restore', async () => {
    const vm1 = await QuickJS.create(wasmBytes);
    vm1.evalCode('globalThis.counter = 42').dispose();

    const snapshot = vm1.snapshot();
    vm1.dispose();

    const vm2 = await QuickJS.restore(snapshot, wasmBytes);
    expect(vm2.evalCode('counter').consume(h => h.toNumber())).toBe(42);
    vm2.dispose();
  });

  it('should resolve a pending promise in a restored VM', async () => {
    const vm1 = await QuickJS.create(wasmBytes);
    vm1.evalCode(`
      globalThis.stepResult = "not yet";
      let __resolve;
      globalThis.pendingStep = new Promise(r => { __resolve = r; });
      globalThis.__resolveFunc = __resolve;
      globalThis.pendingStep.then(value => {
        globalThis.stepResult = "completed: " + value;
      });
    `).dispose();
    vm1.executePendingJobs();

    expect(vm1.global.getProp('stepResult').consume(h => h.toString())).toBe('not yet');

    const snapshot = vm1.snapshot();
    vm1.dispose();

    const vm2 = await QuickJS.restore(snapshot, wasmBytes);
    using restoredResolve = vm2.global.getProp('__resolveFunc');
    using arg = vm2.newString('step-42-result');
    vm2.callFunction(restoredResolve, vm2.undefined, arg).dispose();
    vm2.executePendingJobs();

    expect(vm2.global.getProp('stepResult').consume(h => h.toString())).toBe('completed: step-42-result');
    vm2.dispose();
  });

  it('should support host callback re-registration after restore', async () => {
    const vm1 = await QuickJS.create(wasmBytes);
    {
      using fn = vm1.newFunction('hostAdd', (...args) => {
        return vm1.newNumber(args[0].toNumber() + args[1].toNumber());
      });
      vm1.setProp(vm1.global, 'hostAdd', fn);
    }

    expect(vm1.evalCode('hostAdd(10, 20)').consume(h => h.toNumber())).toBe(30);

    const snapshot = vm1.snapshot();
    vm1.dispose();

    const vm2 = await QuickJS.restore(snapshot, wasmBytes);
    vm2.registerHostCallback(1, (...args) => {
      return vm2.newNumber(args[0].toNumber() + args[1].toNumber());
    });

    using result = vm2.evalCode('hostAdd(100, 200)');
    expect(result.toNumber()).toBe(300);
    vm2.dispose();
  });
});

describe('serializeSnapshot / deserializeSnapshot', () => {
  it('should round-trip a snapshot through serialize/deserialize', async () => {
    const vm1 = await QuickJS.create(wasmBytes);
    vm1.evalCode('globalThis.x = 42').dispose();
    const snapshot = vm1.snapshot();
    vm1.dispose();

    const bytes = QuickJS.serializeSnapshot(snapshot);
    const restored = QuickJS.deserializeSnapshot(bytes);

    expect(restored.memory.byteLength).toBe(snapshot.memory.byteLength);
    expect(restored.stackPointer).toBe(snapshot.stackPointer);
    expect(restored.runtimePtr).toBe(snapshot.runtimePtr);
    expect(restored.contextPtr).toBe(snapshot.contextPtr);
    expect(restored.memory).toEqual(snapshot.memory);
  });

  it('should produce a working snapshot after round-trip', async () => {
    const vm1 = await QuickJS.create(wasmBytes);
    vm1.evalCode(`
      globalThis.message = "survived serialization";
      globalThis.count = 99;
    `).dispose();
    const snapshot = vm1.snapshot();
    vm1.dispose();

    // Serialize → deserialize → restore
    const bytes = QuickJS.serializeSnapshot(snapshot);
    const deserialized = QuickJS.deserializeSnapshot(bytes);
    using vm2 = await QuickJS.restore(deserialized, wasmBytes);

    expect(vm2.evalCode('message').consume(h => h.toString())).toBe('survived serialization');
    expect(vm2.evalCode('count').consume(h => h.toNumber())).toBe(99);
  });

  it('should start with the correct magic and version', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const snapshot = vm.snapshot();
    const bytes = QuickJS.serializeSnapshot(snapshot);

    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getUint32(0, false)).toBe(0x514A5353); // "QJSS"
    expect(view.getUint8(4)).toBe(2); // version 2
  });

  it('should throw on invalid data', () => {
    expect(() => QuickJS.deserializeSnapshot(new Uint8Array(10))).toThrow('too small');
    expect(() => QuickJS.deserializeSnapshot(new Uint8Array(24))).toThrow('bad magic');

    // Valid magic but wrong version
    const badVersion = new Uint8Array(24);
    const view = new DataView(badVersion.buffer);
    view.setUint32(0, 0x514A5353, false);
    view.setUint8(4, 99);
    expect(() => QuickJS.deserializeSnapshot(badVersion)).toThrow('Unsupported snapshot version');
  });

  it('should round-trip with pending promises', async () => {
    const vm1 = await QuickJS.create(wasmBytes);
    vm1.evalCode(`
      globalThis.result = "pending";
      let __resolve;
      globalThis.p = new Promise(r => { __resolve = r; });
      globalThis.__resolve = __resolve;
      globalThis.p.then(v => { globalThis.result = "done: " + v; });
    `).dispose();
    vm1.executePendingJobs();
    const snapshot = vm1.snapshot();
    vm1.dispose();

    // Serialize → deserialize → restore → resolve
    const bytes = QuickJS.serializeSnapshot(snapshot);
    const deserialized = QuickJS.deserializeSnapshot(bytes);
    const vm2 = await QuickJS.restore(deserialized, wasmBytes);

    using resolve = vm2.global.getProp('__resolve');
    using arg = vm2.newString('serialized');
    vm2.callFunction(resolve, vm2.undefined, arg).dispose();
    vm2.executePendingJobs();

    expect(vm2.global.getProp('result').consume(h => h.toString())).toBe('done: serialized');
    vm2.dispose();
  });
});
