import { describe, expect, it } from 'vitest';
import { JSException, QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

const names = [
  ['Latin-1', '\u00e9'],
  ['wide', '\u96ea'],
  ['surrogate pair', '\ud83e\udd8a'],
] as const;

async function captureCallback(name: string) {
  using seed = await QuickJS.create({ wasm: wasmBytes, memoryLimit: 16 * 1024 * 1024 });
  using fn = seed.newFunction(name, () => seed.true);
  using ascii = seed.newFunction('ascii', () => seed.true);
  const token = seed.exportHandle(fn);
  const asciiToken = seed.exportHandle(ascii);
  // Leave room for the native OOM reserve, but not the large name's encoding.
  // mallocSize is engine accounting, not exact backing-allocator headroom.
  const constrainedLimit = seed.getMemoryUsage().mallocSize + 256 * 1024;
  return { token, asciiToken, constrainedLimit, snapshot: seed.snapshot() };
}

describe('host callback name encoding', () => {
  it.each(names)('does not dispatch after %s name encoding fails', async (_kind, character) => {
    const name = character.repeat(512 * 1024);
    const fixture = await captureCallback(name);
    using vm = await QuickJS.restore(fixture.snapshot, {
      wasm: wasmBytes,
      memoryLimit: fixture.constrainedLimit,
    });
    const calls = { intended: 0, ascii: 0, empty: 0 };
    vm.registerHostCallback(name, () => {
      calls.intended++;
      return vm.true;
    });
    vm.registerHostCallback('ascii', () => {
      calls.ascii++;
      return vm.true;
    });
    vm.registerHostCallback('', () => {
      calls.empty++;
      return vm.false;
    });
    using fn = vm.importHandle(fixture.token);
    using ascii = vm.importHandle(fixture.asciiToken);

    // Both functions predate the limit: no guest compilation or lookup can fail first.
    expect(vm.callFunction(ascii, vm.undefined).consume(value => vm.dump(value))).toBe(true);
    let caught: unknown;
    try {
      vm.callFunction(fn, vm.undefined).dispose();
    } catch (error) {
      caught = error;
      if (error instanceof JSException) error.handle.dispose();
    }
    expect(calls).toEqual({ intended: 0, ascii: 1, empty: 0 });
    expect(caught).toBeInstanceOf(JSException);
    expect(caught).toMatchObject({ name: 'InternalError', message: 'out of memory' });

    expect(vm.callFunction(ascii, vm.undefined).consume(value => vm.dump(value))).toBe(true);
    expect(calls).toEqual({ intended: 0, ascii: 2, empty: 0 });
  });

  it.each(names)('preserves %s callback names with sufficient memory', async (_kind, character) => {
    const name = character.repeat(512 * 1024);
    const fixture = await captureCallback(name);
    using vm = await QuickJS.restore(fixture.snapshot, {
      wasm: wasmBytes,
      memoryLimit: 16 * 1024 * 1024,
    });
    const calls = { intended: 0, empty: 0 };
    vm.registerHostCallback(name, () => {
      calls.intended++;
      return vm.true;
    });
    vm.registerHostCallback('', () => {
      calls.empty++;
      return vm.false;
    });
    using fn = vm.importHandle(fixture.token);

    expect(vm.callFunction(fn, vm.undefined).consume(value => vm.dump(value))).toBe(true);
    expect(calls).toEqual({ intended: 1, empty: 0 });
  });

  it('preserves an ASCII name under the constrained limit', async () => {
    const name = 'a'.repeat(1024);
    const fixture = await captureCallback(name);
    using vm = await QuickJS.restore(fixture.snapshot, {
      wasm: wasmBytes,
      memoryLimit: fixture.constrainedLimit,
    });
    let calls = 0;
    vm.registerHostCallback(name, () => {
      calls++;
      return vm.true;
    });
    using fn = vm.importHandle(fixture.token);

    expect(vm.callFunction(fn, vm.undefined).consume(value => vm.dump(value))).toBe(true);
    expect(calls).toBe(1);
  });

  it('preserves a legitimate empty callback name', async () => {
    using vm = await QuickJS.create({ wasm: wasmBytes, memoryLimit: 256 * 1024 });
    let calls = 0;
    using fn = vm.newFunction('', () => {
      calls++;
      return vm.true;
    });

    expect(vm.callFunction(fn, vm.undefined).consume(value => vm.dump(value))).toBe(true);
    expect(calls).toBe(1);
  });
});
