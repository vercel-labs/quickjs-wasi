import { describe, expect, it } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('newEphemeralFunction', () => {
  it('can be created repeatedly without name collisions', async () => {
    using vm = await QuickJS.create(wasmBytes);

    for (let i = 0; i < 50; i++) {
      using fn = vm.newEphemeralFunction(() => vm.newNumber(i));
      using result = vm.callFunction(fn, vm.undefined);
      expect(result.toNumber()).toBe(i);
    }
  });

  it('unregisters its callback when the handle is disposed', async () => {
    using vm = await QuickJS.create(wasmBytes);

    const fn = vm.newEphemeralFunction(() => vm.newString('alive'));
    vm.setProp(vm.global, 'ephemeral', fn);

    using before = vm.evalCode('ephemeral()');
    expect(before.toString()).toBe('alive');

    fn.dispose();

    // The guest still holds the function, but the callback is gone: the
    // call throws inside the guest (as the newEphemeralFunction docs
    // promise), and the error is catchable like any other guest error.
    using after = vm.evalCode(
      'try { ephemeral(); "no-throw" } catch (e) { e.message }'
    );
    expect(after.toString()).toContain('is not registered');
  });

  it('a call after unregisterHostCallback throws inside the guest', async () => {
    using vm = await QuickJS.create(wasmBytes);

    using fn = vm.newFunction('goner', () => vm.newString('alive'));
    vm.setProp(vm.global, 'goner', fn);
    expect(vm.evalCode('goner()').consume((h) => h.toString())).toBe('alive');

    expect(vm.unregisterHostCallback('goner')).toBe(true);

    // Uncaught in the guest: surfaces as a host-side exception.
    expect(() => vm.evalCode('goner()')).toThrow(
      '"goner" is not registered'
    );
  });

  it('does not leak callbacks across many calls', async () => {
    using vm = await QuickJS.create(wasmBytes);

    // A name-keyed registry that never shrank would make this throw once a
    // name repeated, or grow without bound.
    for (let i = 0; i < 500; i++) {
      vm.newEphemeralFunction(() => vm.undefined).dispose();
    }

    using fn = vm.newEphemeralFunction(() => vm.newNumber(1));
    using result = vm.callFunction(fn, vm.undefined);
    expect(result.toNumber()).toBe(1);
  });

  it('coexists with named functions', async () => {
    using vm = await QuickJS.create(wasmBytes);

    using named = vm.newFunction('named', () => vm.newString('named'));
    using ephemeral = vm.newEphemeralFunction(() => vm.newString('ephemeral'));

    expect(vm.callFunction(named, vm.undefined).consume((h) => h.toString())).toBe('named');
    expect(vm.callFunction(ephemeral, vm.undefined).consume((h) => h.toString())).toBe(
      'ephemeral'
    );
  });
});

describe('unregisterHostCallback', () => {
  it('removes a named callback and reports whether it existed', async () => {
    using vm = await QuickJS.create(wasmBytes);

    using fn = vm.newFunction('greet', () => vm.newString('hi'));
    vm.setProp(vm.global, 'greet', fn);
    expect(vm.evalCode('greet()').consume((h) => h.toString())).toBe('hi');

    expect(vm.unregisterHostCallback('greet')).toBe(true);
    expect(vm.unregisterHostCallback('greet')).toBe(false);
    // A call through the still-reachable guest function now throws, as
    // the unregisterHostCallback docs promise.
    using after = vm.evalCode(
      'try { greet(); "no-throw" } catch (e) { e.message }'
    );
    expect(after.toString()).toContain('"greet" is not registered');
  });

  it('frees the name for reuse', async () => {
    using vm = await QuickJS.create(wasmBytes);

    vm.newFunction('reused', () => vm.newNumber(1)).dispose();
    // without unregistering, this would throw "already registered"
    expect(() => vm.newFunction('reused', () => vm.newNumber(2))).toThrow(
      /already registered/
    );

    vm.unregisterHostCallback('reused');
    using second = vm.newFunction('reused', () => vm.newNumber(2));
    expect(vm.callFunction(second, vm.undefined).consume((h) => h.toNumber())).toBe(2);
  });
});

describe('withScope + host callbacks (borrowed handles)', () => {
  it('does not free host-callback argument handles at scope exit', async () => {
    using vm = await QuickJS.create(wasmBytes);

    // Regression: the trampoline's `this`/argument handles wrap pointers
    // OWNED BY THE C CALLER. Before the `borrowed` flag they registered
    // with the active scope, and the scope's disposal at exit double-freed
    // the guest values, observed as WASM memory corruption when a host
    // serializer drove Map/Set `forEach` visitors inside `withScope`.
    const seen: number[] = [];
    using visitor = vm.newEphemeralFunction((value) => {
      seen.push(value.toNumber());
      return vm.undefined;
    });
    vm.setProp(vm.global, 'visit', visitor);

    using guestMap = vm.evalCode('new Map([["a", 1], ["b", 2], ["c", 3]])');

    vm.withScope(() => {
      using forEach = vm.evalCode('Map.prototype.forEach');
      vm.callFunction(forEach, guestMap, visitor).dispose();
    });

    expect(seen).toEqual([1, 2, 3]);

    // The guest heap must still be intact: the map's values were the
    // callback's argument pointers, which a buggy scope would have freed.
    // Re-read the original map through the guest to prove they survived
    // the scope exit.
    vm.setProp(vm.global, 'm', guestMap);
    using sum = vm.evalCode(
      '(() => { let s = 0; for (const v of m.values()) s += v; return s; })()'
    );
    expect(sum.toNumber()).toBe(6);
  });

  it('explicit dispose() of a borrowed argument handle is a no-op', async () => {
    using vm = await QuickJS.create(wasmBytes);

    using fn = vm.newEphemeralFunction((value, other) => {
      // A callback must not be able to free the C caller's values.
      value.dispose();
      other.dispose();
      expect(value.disposed).toBe(false);
      expect(other.disposed).toBe(false);
      return vm.undefined;
    });
    vm.setProp(vm.global, 'cb', fn);
    vm.evalCode('cb("shared", { n: 1 })').dispose();

    // Guest strings/objects passed as args must remain readable.
    using still = vm.evalCode('"shared".length');
    expect(still.toNumber()).toBe(6);
  });

  it('dup() of a borrowed argument survives past the callback and the scope', async () => {
    using vm = await QuickJS.create(wasmBytes);

    let retained: ReturnType<typeof vm.newObject> | undefined;
    using fn = vm.newEphemeralFunction((value) => {
      retained = value.dup();
      return vm.undefined;
    });
    vm.setProp(vm.global, 'keep', fn);

    vm.withScope(() => {
      vm.evalCode('keep({ tag: "kept" })').dispose();
      // The dup was created inside the scope and IS scope-tracked.
      expect(retained!.disposed).toBe(false);
    });

    // The dup is an owned reference: the scope disposed it at exit,
    // exactly like any handle the callback created.
    expect(retained!.disposed).toBe(true);
  });
});

describe('withScope', () => {
  it('disposes handles created inside the scope', async () => {
    using vm = await QuickJS.create(wasmBytes);

    let inner: ReturnType<typeof vm.newObject>;
    let numberHandle: ReturnType<typeof vm.newNumber>;
    vm.withScope(() => {
      inner = vm.newObject();
      numberHandle = vm.newNumber(1);
      inner.setProp('a', numberHandle);
      expect(inner.disposed).toBe(false);
    });

    expect(inner!.disposed).toBe(true);
    expect(numberHandle!.disposed).toBe(true);
  });

  it('returns the value of the callback', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const total = vm.withScope(() => {
      using value = vm.evalCode('1 + 2');
      return value.toNumber();
    });
    expect(total).toBe(3);
  });

  it('keeps escaped handles alive', async () => {
    using vm = await QuickJS.create(wasmBytes);

    using kept = vm.withScope((scope) => {
      const root = vm.evalCode('({ user: { profile: { name: "ada" } } })');
      const user = root.getProp('user');
      const profile = user.getProp('profile');
      return scope.escape(profile.getProp('name'));
    });

    expect(kept.toString()).toBe('ada');
  });

  it('transfers escaped handles to the enclosing scope', async () => {
    using vm = await QuickJS.create(wasmBytes);

    let escaped: ReturnType<typeof vm.newObject>;
    vm.withScope(() => {
      escaped = vm.withScope((inner) => inner.escape(vm.newString('nested')));
      // still alive in the outer scope
      expect(escaped.disposed).toBe(false);
      expect(escaped.toString()).toBe('nested');
    });

    // ...and cleaned up when the outer scope ends
    expect(escaped!.disposed).toBe(true);
  });

  it('disposes handles even when the callback throws', async () => {
    using vm = await QuickJS.create(wasmBytes);

    let created: ReturnType<typeof vm.newObject>;
    expect(() =>
      vm.withScope(() => {
        created = vm.newObject();
        throw new Error('boom');
      })
    ).toThrow(/boom/);

    expect(created!.disposed).toBe(true);
  });

  it('does not disturb singletons', async () => {
    using vm = await QuickJS.create(wasmBytes);

    vm.withScope(() => {
      vm.undefined;
      vm.null;
      vm.global;
    });

    // singletons still work after the scope closes
    expect(vm.undefined.isUndefined).toBe(true);
    expect(vm.global.isObject).toBe(true);
    using probe = vm.evalCode('1 + 1');
    expect(probe.toNumber()).toBe(2);
  });

  it('handles nesting and restores the previous scope', async () => {
    using vm = await QuickJS.create(wasmBytes);

    let outerHandle: ReturnType<typeof vm.newObject>;
    let innerHandle: ReturnType<typeof vm.newObject>;

    vm.withScope(() => {
      outerHandle = vm.newObject();
      vm.withScope(() => {
        innerHandle = vm.newObject();
      });
      // inner scope closed, outer handle still alive
      expect(innerHandle!.disposed).toBe(true);
      expect(outerHandle!.disposed).toBe(false);
      outerHandle!.setProp('ok', vm.true);
    });

    expect(outerHandle!.disposed).toBe(true);
  });
});

describe('resolvePromise hardening', () => {
  it('does not read `then` off the value being resolved', async () => {
    using vm = await QuickJS.create(wasmBytes);

    vm.evalCode(`
      globalThis.thenReads = 0;
      globalThis.promise = Promise.resolve('settled');
      // shadow \`then\` with an own accessor on the promise itself
      Object.defineProperty(globalThis.promise, 'then', {
        configurable: true,
        get() { globalThis.thenReads++; return Promise.prototype.then; },
      });
    `).dispose();

    using promise = vm.evalCode('globalThis.promise');
    const settled = await vm.resolvePromise(promise);
    vm.executePendingJobs();

    expect('value' in settled).toBe(true);
    if ('value' in settled) {
      expect(settled.value.toString()).toBe('settled');
      settled.value.dispose();
    }

    using reads = vm.evalCode('globalThis.thenReads');
    expect(reads.toNumber()).toBe(0);
  });

  it('still resolves pending promises', async () => {
    using vm = await QuickJS.create(wasmBytes);

    vm.evalCode(`
      globalThis.resolveIt = null;
      globalThis.pending = new Promise((resolve) => { globalThis.resolveIt = resolve; });
    `).dispose();

    using pending = vm.evalCode('globalThis.pending');
    const settledPromise = vm.resolvePromise(pending);

    vm.evalCode('globalThis.resolveIt("done")').dispose();
    vm.executePendingJobs();

    const settled = await settledPromise;
    expect('value' in settled).toBe(true);
    if ('value' in settled) {
      expect(settled.value.toString()).toBe('done');
      settled.value.dispose();
    }
  });
});
