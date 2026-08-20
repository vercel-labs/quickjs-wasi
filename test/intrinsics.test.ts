import { describe, it, expect } from 'vitest';
import { QuickJS, Intrinsics } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('Intrinsics', () => {
  it('should work with all intrinsics (default behavior)', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.evalCode('typeof Date').consume(h => h.toString())).toBe('function');
    expect(vm.evalCode('typeof eval').consume(h => h.toString())).toBe('function');
    expect(vm.evalCode('typeof RegExp').consume(h => h.toString())).toBe('function');
    expect(vm.evalCode('typeof JSON').consume(h => h.toString())).toBe('object');
    expect(vm.evalCode('typeof Proxy').consume(h => h.toString())).toBe('function');
    expect(vm.evalCode('typeof Map').consume(h => h.toString())).toBe('function');
    expect(vm.evalCode('typeof Uint8Array').consume(h => h.toString())).toBe('function');
    expect(vm.evalCode('typeof Promise').consume(h => h.toString())).toBe('function');
    expect(vm.evalCode('typeof BigInt').consume(h => h.toString())).toBe('function');
    expect(vm.evalCode('typeof WeakRef').consume(h => h.toString())).toBe('function');
  });

  it('should work with Intrinsics.ALL (same as default)', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      intrinsics: Intrinsics.ALL,
    });
    expect(vm.evalCode('typeof Date').consume(h => h.toString())).toBe('function');
    expect(vm.evalCode('typeof Promise').consume(h => h.toString())).toBe('function');
  });

  it('should disable eval when EVAL is omitted (requires bytecode)', async () => {
    // Without the EVAL intrinsic, JS_Eval (and vm.evalCode) cannot parse JS.
    // The only way to execute code is via pre-compiled bytecode.
    // First, compile bytecode in a full VM:
    const fullVm = await QuickJS.create(wasmBytes);
    const bytecode = fullVm.compile('1 + 2');
    fullVm.dispose();

    // Now create a VM without EVAL and run the bytecode
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      intrinsics: Intrinsics.ALL & ~Intrinsics.EVAL,
    });
    // evalCode should throw because the parser is not available
    expect(() => vm.evalCode('1')).toThrow('eval is not supported');
    // But pre-compiled bytecode should still work
    const result = vm.evalBytecode(bytecode).consume(h => h.toNumber());
    expect(result).toBe(3);
  });

  it('should disable Date when DATE is omitted', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      intrinsics: Intrinsics.ALL & ~Intrinsics.DATE,
    });
    expect(vm.evalCode('typeof Date').consume(h => h.toString())).toBe('undefined');
  });

  it('should disable RegExp when REGEXP is omitted', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      intrinsics: Intrinsics.ALL & ~Intrinsics.REGEXP,
    });
    expect(vm.evalCode('typeof RegExp').consume(h => h.toString())).toBe('undefined');
  });

  it('should disable JSON when JSON is omitted', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      intrinsics: Intrinsics.ALL & ~Intrinsics.JSON,
    });
    expect(vm.evalCode('typeof JSON').consume(h => h.toString())).toBe('undefined');
  });

  it('should disable Proxy when PROXY is omitted', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      intrinsics: Intrinsics.ALL & ~Intrinsics.PROXY,
    });
    expect(vm.evalCode('typeof Proxy').consume(h => h.toString())).toBe('undefined');
    // Note: Reflect is part of BaseObjects, not the Proxy intrinsic
    expect(vm.evalCode('typeof Reflect').consume(h => h.toString())).toBe('object');
  });

  it('should disable Map/Set when MAP_SET is omitted', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      intrinsics: Intrinsics.ALL & ~Intrinsics.MAP_SET,
    });
    expect(vm.evalCode('typeof Map').consume(h => h.toString())).toBe('undefined');
    expect(vm.evalCode('typeof Set').consume(h => h.toString())).toBe('undefined');
  });

  it('should disable TypedArrays when TYPED_ARRAYS is omitted', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      intrinsics: Intrinsics.ALL & ~Intrinsics.TYPED_ARRAYS,
    });
    expect(vm.evalCode('typeof Uint8Array').consume(h => h.toString())).toBe('undefined');
    expect(vm.evalCode('typeof ArrayBuffer').consume(h => h.toString())).toBe('undefined');
  });

  it('should disable Promise when PROMISE is omitted', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      intrinsics: Intrinsics.ALL & ~Intrinsics.PROMISE,
    });
    expect(vm.evalCode('typeof Promise').consume(h => h.toString())).toBe('undefined');
  });

  it('should note that BigInt is part of BaseObjects and cannot be removed', async () => {
    // In quickjs-ng, BigInt is included as part of BaseObjects.
    // The BIG_INT intrinsic flag is accepted but has no effect since
    // BigInt is always available.
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      intrinsics: Intrinsics.ALL & ~Intrinsics.BIG_INT,
    });
    // BigInt is still available; it's part of the base engine
    expect(vm.evalCode('typeof BigInt').consume(h => h.toString())).toBe('function');
    expect(vm.evalCode('(123n).toString()').consume(h => h.toString())).toBe('123');
  });

  it('should disable WeakRef when WEAK_REF is omitted', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      intrinsics: Intrinsics.ALL & ~Intrinsics.WEAK_REF,
    });
    expect(vm.evalCode('typeof WeakRef').consume(h => h.toString())).toBe('undefined');
    expect(vm.evalCode('typeof FinalizationRegistry').consume(h => h.toString())).toBe('undefined');
  });

  it('should create a minimal context with only base objects + eval', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      intrinsics: Intrinsics.EVAL, // Only BaseObjects + Eval
    });
    // Base objects should exist
    expect(vm.evalCode('typeof Object').consume(h => h.toString())).toBe('function');
    expect(vm.evalCode('typeof Array').consume(h => h.toString())).toBe('function');
    expect(vm.evalCode('typeof String').consume(h => h.toString())).toBe('function');
    expect(vm.evalCode('typeof Number').consume(h => h.toString())).toBe('function');
    expect(vm.evalCode('typeof Error').consume(h => h.toString())).toBe('function');

    // Non-base intrinsics should NOT exist
    expect(vm.evalCode('typeof Date').consume(h => h.toString())).toBe('undefined');
    expect(vm.evalCode('typeof RegExp').consume(h => h.toString())).toBe('undefined');
    expect(vm.evalCode('typeof Promise').consume(h => h.toString())).toBe('undefined');
    expect(vm.evalCode('typeof Map').consume(h => h.toString())).toBe('undefined');
  });

  it('should work with a custom combination of intrinsics', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      intrinsics: Intrinsics.EVAL | Intrinsics.JSON | Intrinsics.MAP_SET | Intrinsics.TYPED_ARRAYS,
    });
    // Enabled
    expect(vm.evalCode('typeof JSON').consume(h => h.toString())).toBe('object');
    expect(vm.evalCode('typeof Map').consume(h => h.toString())).toBe('function');
    expect(vm.evalCode('typeof Uint8Array').consume(h => h.toString())).toBe('function');

    // Not enabled
    expect(vm.evalCode('typeof Date').consume(h => h.toString())).toBe('undefined');
    expect(vm.evalCode('typeof Promise').consume(h => h.toString())).toBe('undefined');
    expect(vm.evalCode('typeof RegExp').consume(h => h.toString())).toBe('undefined');
  });

  it('should enable performance.now() with PERFORMANCE flag', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      intrinsics: Intrinsics.ALL | Intrinsics.PERFORMANCE,
    });
    expect(vm.evalCode('typeof performance').consume(h => h.toString())).toBe('object');
    expect(vm.evalCode('typeof performance.now').consume(h => h.toString())).toBe('function');
  });

  it('should enable atob/btoa with ATOB_BTOA flag (default)', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.evalCode('typeof atob').consume(h => h.toString())).toBe('function');
    expect(vm.evalCode('typeof btoa').consume(h => h.toString())).toBe('function');
    expect(vm.evalCode("btoa('hi')").consume(h => h.toString())).toBe('aGk=');
    expect(vm.evalCode("atob('aGk=')").consume(h => h.toString())).toBe('hi');
  });

  it('should disable atob/btoa when ATOB_BTOA is omitted', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      intrinsics: Intrinsics.ALL & ~Intrinsics.ATOB_BTOA,
    });
    expect(vm.evalCode('typeof atob').consume(h => h.toString())).toBe('undefined');
    expect(vm.evalCode('typeof btoa').consume(h => h.toString())).toBe('undefined');
  });

  it('should pull in DOMException as a dependency when ATOB_BTOA is enabled', async () => {
    // JS_AddIntrinsicAToB also adds DOMException if not already present.
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      intrinsics: Intrinsics.EVAL | Intrinsics.ATOB_BTOA,
    });
    expect(vm.evalCode('typeof DOMException').consume(h => h.toString())).toBe('function');
  });
});
