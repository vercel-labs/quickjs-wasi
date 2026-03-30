import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('Symbol.for() (global symbols)', () => {
  it('should create a global symbol via newSymbolFor', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using sym = vm.newSymbolFor('test');
    expect(vm.typeof(sym)).toBe('symbol');
    // dump() reconstructs as a real host Symbol
    const dumped = vm.dump(sym);
    expect(dumped).toBe(Symbol.for('test'));
  });

  it('should match Symbol.for() created inside QuickJS', async () => {
    using vm = await QuickJS.create(wasmBytes);
    // Create the same global symbol from both sides
    using hostSym = vm.newSymbolFor('MY_KEY');
    vm.setProp(vm.global, hostSym, vm.newString('hello from host'));

    // QuickJS code uses Symbol.for('MY_KEY') — should find the same property
    using result = vm.evalCode('globalThis[Symbol.for("MY_KEY")]');
    expect(result.toString()).toBe('hello from host');
  });

  it('should set and get properties using symbol keys', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.newObject();
    using sym = vm.newSymbolFor('myProp');
    using val = vm.newNumber(42);

    vm.setProp(obj, sym, val);
    using retrieved = vm.getProp(obj, sym);
    expect(retrieved.toNumber()).toBe(42);
  });

  it('should not collide with string properties of the same name', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.newObject();
    using sym = vm.newSymbolFor('key');
    using strVal = vm.newString('string value');
    using symVal = vm.newString('symbol value');

    obj.setProp('key', strVal);
    vm.setProp(obj, sym, symVal);

    // String key and symbol key should be independent
    using byString = obj.getProp('key');
    using bySymbol = vm.getProp(obj, sym);
    expect(byString.toString()).toBe('string value');
    expect(bySymbol.toString()).toBe('symbol value');
  });

  it('should work with the Workflow SDK WORKFLOW_USE_STEP pattern', async () => {
    using vm = await QuickJS.create(wasmBytes);
    // This is the pattern used by WDK: globalThis[Symbol.for("WORKFLOW_USE_STEP")]
    using sym = vm.newSymbolFor('WORKFLOW_USE_STEP');
    using fn = vm.newFunction('useStep', (...args) => {
      const stepId = args[0].toString();
      return vm.newString(`step:${stepId}`);
    });
    vm.setProp(vm.global, sym, fn);

    // QuickJS code accesses it via Symbol.for
    using result = vm.evalCode(`
      const useStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")];
      useStep("my-step-id");
    `);
    expect(result.toString()).toBe('step:my-step-id');
  });

  it('should survive snapshot/restore', async () => {
    const vm1 = await QuickJS.create(wasmBytes);
    {
      using sym = vm1.newSymbolFor('PERSIST_ME');
      using val = vm1.newString('persisted');
      vm1.setProp(vm1.global, sym, val);
    }

    const snapshot = vm1.snapshot();
    vm1.dispose();

    using vm2 = await QuickJS.restore(snapshot, wasmBytes);
    // After restore, Symbol.for('PERSIST_ME') should still have the value
    using result = vm2.evalCode('globalThis[Symbol.for("PERSIST_ME")]');
    expect(result.toString()).toBe('persisted');
  });
});

describe('dump() with symbol values', () => {
  it('should dump a global symbol as Symbol.for()', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using sym = vm.evalCode('Symbol.for("test")');
    const dumped = vm.dump(sym);
    expect(typeof dumped).toBe('symbol');
    expect(dumped).toBe(Symbol.for('test'));
  });

  it('should dump a host-created global symbol as Symbol.for()', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using sym = vm.newSymbolFor('hello');
    const dumped = vm.dump(sym);
    expect(typeof dumped).toBe('symbol');
    expect(dumped).toBe(Symbol.for('hello'));
  });

  it('should dump a local (anonymous) symbol as undefined', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using sym = vm.evalCode('Symbol("local")');
    const dumped = vm.dump(sym);
    // Local symbols can't be reconstructed on the host
    expect(dumped).toBeUndefined();
  });
});
