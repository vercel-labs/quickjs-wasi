import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('snapshot and restore', () => {
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

    const vm2 = await QuickJS.restore(snapshot, wasmBytes);
    using restoredResolve = vm2.global.getProp('__resolveFunc');
    using arg = vm2.newString('step-42-result');
    vm2.callFunction(restoredResolve, vm2.undefined, arg).dispose();
    vm2.executePendingJobs();

    expect(vm2.global.getProp('stepResult').consume(h => h.toString())).toBe('completed: step-42-result');
    vm2.dispose(false);
  });

  it('should support host callback re-registration after restore', async () => {
    const vm1 = await QuickJS.create(wasmBytes);
    {
      using fn = vm1.newFunction('hostAdd', (_this, ...args) => {
        return vm1.newNumber(args[0].toNumber() + args[1].toNumber());
      });
      vm1.setProp(vm1.global, 'hostAdd', fn);
    }

    expect(vm1.evalCode('hostAdd(10, 20)').consume(h => h.toNumber())).toBe(30);

    const snapshot = vm1.snapshot();
    vm1.dispose(false);

    const vm2 = await QuickJS.restore(snapshot, wasmBytes);
    vm2.registerHostCallback(1, (_this, ...args) => {
      return vm2.newNumber(args[0].toNumber() + args[1].toNumber());
    });

    using result = vm2.unwrapResult(vm2.evalCode('hostAdd(100, 200)'));
    expect(result.toNumber()).toBe(300);
    vm2.dispose(false);
  });
});
