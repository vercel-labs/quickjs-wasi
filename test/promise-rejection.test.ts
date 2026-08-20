import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('onUnhandledRejection', () => {
  it('should fire for an unhandled promise rejection', async () => {
    const rejections: { reason: string; isHandled: boolean }[] = [];

    using vm = await QuickJS.create({
      wasm: wasmBytes,
      onUnhandledRejection: (_promise, reason, isHandled) => {
        rejections.push({ reason: reason.toString(), isHandled });
      },
    });

    vm.evalCode('Promise.reject("oops")').dispose();
    vm.executePendingJobs();

    expect(rejections.length).toBeGreaterThanOrEqual(1);
    expect(rejections[0].reason).toBe('oops');
    expect(rejections[0].isHandled).toBe(false);
  });

  it('should fire for a rejection via throw in async function', async () => {
    const rejections: { reason: string; isHandled: boolean }[] = [];

    using vm = await QuickJS.create({
      wasm: wasmBytes,
      onUnhandledRejection: (_promise, reason, isHandled) => {
        rejections.push({ reason: reason.toString(), isHandled });
      },
    });

    vm.evalCode('(async () => { throw new Error("async fail"); })()').dispose();
    vm.executePendingJobs();

    expect(rejections.length).toBeGreaterThanOrEqual(1);
    const errorRejection = rejections.find(r => r.reason.includes('async fail'));
    expect(errorRejection).toBeDefined();
    expect(errorRejection!.isHandled).toBe(false);
  });

  it('should fire with isHandled=true when a handler is later attached', async () => {
    const rejections: { reason: string; isHandled: boolean }[] = [];

    using vm = await QuickJS.create({
      wasm: wasmBytes,
      onUnhandledRejection: (_promise, reason, isHandled) => {
        rejections.push({ reason: reason.toString(), isHandled });
      },
    });

    // Reject first, then attach a handler in a later microtask
    vm.evalCode(`
      const p = Promise.reject("later-caught");
      // Attach handler asynchronously
      Promise.resolve().then(() => p.catch(() => {}));
    `).dispose();
    vm.executePendingJobs();

    // Should see at least one unhandled (is_handled=false) followed by
    // a handled notification (is_handled=true) when .catch() attaches
    const unhandled = rejections.filter(r => !r.isHandled);
    const handled = rejections.filter(r => r.isHandled);
    expect(unhandled.length).toBeGreaterThanOrEqual(1);
    expect(handled.length).toBeGreaterThanOrEqual(1);
  });

  it('should not fire when no handler is registered', async () => {
    // Should not crash — just silently ignores unhandled rejections
    using vm = await QuickJS.create(wasmBytes);
    vm.evalCode('Promise.reject("ignored")').dispose();
    vm.executePendingJobs();
    // If we get here without crashing, the test passes
    expect(vm.evalCode('1 + 1').consume(h => h.toNumber())).toBe(2);
  });

  it('should receive Error objects as the reason', async () => {
    const reasons: string[] = [];

    using vm = await QuickJS.create({
      wasm: wasmBytes,
      onUnhandledRejection: (_promise, reason, isHandled) => {
        if (!isHandled) {
          reasons.push(reason.toString());
        }
      },
    });

    vm.evalCode('Promise.reject(new TypeError("bad type"))').dispose();
    vm.executePendingJobs();

    expect(reasons.length).toBe(1);
    expect(reasons[0]).toContain('TypeError');
    expect(reasons[0]).toContain('bad type');
  });

  it('should work after snapshot restore', async () => {
    const vm1 = await QuickJS.create(wasmBytes);
    vm1.evalCode('globalThis.x = 42').dispose();
    const snapshot = vm1.snapshot();
    vm1.dispose();

    const rejections: string[] = [];
    using vm2 = await QuickJS.restore(snapshot, {
      wasm: wasmBytes,
      onUnhandledRejection: (_promise, reason, isHandled) => {
        if (!isHandled) rejections.push(reason.toString());
      },
    });

    expect(vm2.evalCode('x').consume(h => h.toNumber())).toBe(42);

    vm2.evalCode('Promise.reject("post-restore")').dispose();
    vm2.executePendingJobs();

    expect(rejections).toContain('post-restore');
  });
});

describe('markPromiseHandled', () => {
  it('suppresses the unhandled-rejection callback for a marked promise', async () => {
    const rejections: string[] = [];

    using vm = await QuickJS.create({
      wasm: wasmBytes,
      onUnhandledRejection: (_promise, reason, isHandled) => {
        if (!isHandled) rejections.push(reason.toString());
      },
    });

    // A pending promise that will reject in a later microtask
    using promise = vm.evalCode(`
      globalThis.trigger = null;
      new Promise((_, reject) => { globalThis.trigger = reject; })
    `);
    vm.markPromiseHandled(promise);

    vm.evalCode('trigger("suppressed")').dispose();
    vm.executePendingJobs();
    expect(rejections).not.toContain('suppressed');

    // An unmarked rejection still fires, proving the tracker is active
    vm.evalCode('Promise.reject("reported")').dispose();
    vm.executePendingJobs();
    expect(rejections).toContain('reported');
  });

  it('is a no-op for non-promise handles', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using notAPromise = vm.evalCode('({})');
    expect(() => vm.markPromiseHandled(notAPromise)).not.toThrow();
  });
});
