import { describe, expect, it } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

/**
 * Snapshot-portable handles: exportHandle() turns a live handle into a
 * token that importHandle() re-materializes — on the same VM or on any
 * VM restored from a snapshot taken while the handle was alive. The
 * headline use case is boot-time capture of pristine intrinsics before
 * user code runs (see the exportHandle docs).
 */
describe('exportHandle / importHandle', () => {
  it('re-materializes a captured value in a restored VM without running guest code', async () => {
    using baseline = await QuickJS.create(wasmBytes);

    // Capture a pristine intrinsic BEFORE "user code" patches it.
    const pristineToISOString = baseline.evalCode('Date.prototype.toISOString');
    const token = baseline.exportHandle(pristineToISOString);

    // User code replaces the intrinsic (a polyfill, say).
    baseline
      .evalCode('Date.prototype.toISOString = function () { return "patched"; }')
      .dispose();

    const snapshot = baseline.snapshot();
    baseline.dispose(); // do NOT dispose the exported handle first

    using restored = await QuickJS.restore(snapshot, wasmBytes);
    using imported = restored.importHandle(token);

    // The imported handle is the PRISTINE function, not the patch.
    using date = restored.evalCode('new Date(1700000000000)');
    using iso = restored.callFunction(imported, date);
    expect(iso.toString()).toBe('2023-11-14T22:13:20.000Z');

    // The patch is still what guest code observes — the import didn't
    // mutate the heap, it only referenced a value the heap already held.
    using patched = restored.evalCode('new Date(0).toISOString()');
    expect(patched.toString()).toBe('patched');
  });

  it('imports are independently owned — multiple imports, independent dispose', async () => {
    using baseline = await QuickJS.create(wasmBytes);
    const obj = baseline.evalCode('({ tag: "kept" })');
    const token = baseline.exportHandle(obj);
    const snapshot = baseline.snapshot();
    baseline.dispose();

    using restored = await QuickJS.restore(snapshot, wasmBytes);
    const first = restored.importHandle(token);
    const second = restored.importHandle(token);
    expect(first.getProp('tag').consume((h) => h.toString())).toBe('kept');
    first.dispose();
    // Disposing one import must not free the value out from under others.
    expect(second.getProp('tag').consume((h) => h.toString())).toBe('kept');
    second.dispose();
    // The exported box's own reference keeps the value alive regardless.
    using third = restored.importHandle(token);
    expect(third.getProp('tag').consume((h) => h.toString())).toBe('kept');
  });

  it('round-trips on the same VM without a snapshot', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using original = vm.evalCode('({ n: 7 })');
    const token = vm.exportHandle(original);
    using imported = vm.importHandle(token);
    expect(imported.getProp('n').consume((h) => h.toNumber())).toBe(7);
    // Same underlying guest object.
    expect(imported.identity).toBe(original.identity);
  });

  it('rejects handles from a different VM and disposed handles', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using other = await QuickJS.create(wasmBytes);
    using foreign = other.evalCode('({})');
    expect(() => vm.exportHandle(foreign)).toThrow('different VM');

    const gone = vm.evalCode('({})');
    gone.dispose();
    expect(() => vm.exportHandle(gone)).toThrow('disposed');
  });

  it('serialized snapshots preserve token validity', async () => {
    using baseline = await QuickJS.create(wasmBytes);
    const value = baseline.evalCode('"portable\\u0000value"');
    const token = baseline.exportHandle(value);
    const bytes = QuickJS.serializeSnapshot(baseline.snapshot());
    baseline.dispose();

    using restored = await QuickJS.restore(
      QuickJS.deserializeSnapshot(bytes),
      wasmBytes
    );
    using imported = restored.importHandle(token);
    expect(imported.length).toBe('portable\u0000value'.length);
  });
});
