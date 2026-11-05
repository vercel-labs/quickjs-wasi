import { describe, expect, it, vi } from 'vitest';
import { JSException, JSValueHandle, QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

// Observe the library's detached reaction without a process-wide rejection hook.
function sourcePromise() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((ok, fail) => { resolve = ok; reject = fail; });
  const then = promise.then.bind(promise);
  const reactions: Promise<unknown>[] = [];
  vi.spyOn(promise, 'then').mockImplementation((ok, fail) => {
    const reaction = then(ok, fail);
    reactions.push(reaction);
    void reaction.catch(() => {});
    return reaction;
  });
  return { promise, resolve, reject, reactions };
}

function observe(promise: Promise<unknown>) {
  const outcomes: { status: 'fulfilled' | 'rejected'; value: unknown }[] = [];
  void promise.then(value => outcomes.push({ status: 'fulfilled', value }), value => outcomes.push({ status: 'rejected', value }));
  return outcomes;
}

async function finish(source: ReturnType<typeof sourcePromise>) {
  const outcomes = await Promise.all(source.reactions.map(reaction => reaction.then(() => 'fulfilled', () => 'rejected')));
  await Promise.resolve();
  expect(outcomes).toEqual(['fulfilled']);
}

function release(result: Awaited<ReturnType<QuickJS['resolvePromise']>>) {
  ('value' in result ? result.value : result.error).dispose();
}

describe('host Promise lifecycle', () => {
  it.each(['resolve', 'reject'] as const)('automatically drains a successful host %s', async direction => {
    using vm = await QuickJS.create(wasmBytes);
    const source = sourcePromise();
    using guest = vm.hostToHandle(source.promise);
    const result = vm.resolvePromise(guest);
    source[direction]('delivered');
    await finish(source);
    const outcome = await result;
    expect('value' in outcome).toBe(direction === 'resolve');
    expect(('value' in outcome ? outcome.value : outcome.error).toString()).toBe('delivered');
    release(outcome);
    expect(vm.evalCode('21 * 2').consume(value => value.toNumber())).toBe(42);
  });

  it('keeps a convertible host-value failure as a guest rejection', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const source = sourcePromise();
    using guest = vm.hostToHandle(source.promise);
    const result = vm.resolvePromise(guest);
    source.resolve(Symbol('local'));
    await finish(source);
    const outcome = await result;
    expect('error' in outcome).toBe(true);
    if ('error' in outcome) expect(outcome.error.getProp('message').consume(value => value.toString())).toContain('local symbol');
    release(outcome);
    expect(vm.evalCode('42').consume(value => value.toNumber())).toBe(42);
  });

  it.each([new Error('drain failed'), null, undefined])('rejects every staged observer with the original drain failure %s', async failure => {
    using vm = await QuickJS.create(wasmBytes);
    const source = sourcePromise();
    using guest = vm.hostToHandle(source.promise);
    vm.global.setProp('bridged', guest);
    using derived = vm.evalCode('bridged.then(value => value)');
    const deferred = vm.newPromise();
    using pending = deferred.handle;
    const settled = observe(deferred.settled);
    const direct = observe(vm.resolvePromise(guest));
    const chained = observe(vm.resolvePromise(derived));
    const unrelated = observe(vm.resolvePromise(pending));
    const reentrant: ReturnType<typeof observe>[] = [];
    using insideDrain = vm.newFunction('observeAgain', () => {
      reentrant.push(observe(vm.resolvePromise(guest)));
      return vm.undefined;
    });
    vm.global.setProp('observeAgain', insideDrain);
    vm.evalCode('bridged.then(observeAgain)').dispose();
    const nativeDrain = vm.executePendingJobs.bind(vm);
    const drain = vi.spyOn(vm, 'executePendingJobs').mockImplementation(() => {
      nativeDrain();
      throw failure;
    });
    const staged: JSValueHandle[] = [];
    const dup = JSValueHandle.prototype.dup;
    const duplication = vi.spyOn(JSValueHandle.prototype, 'dup').mockImplementation(function () {
      const handle = dup.call(this);
      staged.push(handle);
      return handle;
    });
    source.resolve(42);
    await finish(source);
    drain.mockRestore();
    duplication.mockRestore();
    expect(reentrant).toHaveLength(1);
    for (const outcomes of [settled, direct, chained, unrelated, ...reentrant]) expect(outcomes).toEqual([{ status: 'rejected', value: failure }]);
    expect(staged.length).toBeGreaterThan(0);
    expect(staged.every(handle => handle.disposed)).toBe(true);
    let late: unknown = Symbol('not thrown');
    try { vm.resolvePromise(guest); } catch (error) { late = error; }
    expect(late).toBe(failure);
    expect(() => deferred.settled).not.toThrow(); // cached rejection remains observable
    let terminated = false;
    try { vm.newPromise(); } catch { terminated = true; }
    expect(terminated).toBe(true);
  });

  it.each(['resolve', 'reject'] as const)('delivers a native %s failure to derived and late host observers', async direction => {
    using vm = await QuickJS.create(wasmBytes);
    const source = sourcePromise();
    using reason = vm.newError('native resolver failed');
    vm.global.setProp('reason', reason);
    using thrower = vm.evalCode('() => { throw reason; }');
    using guest = vm.hostToHandle(source.promise);
    vm.global.setProp('bridged', guest);
    let guestCatch = 0;
    using caught = vm.newFunction('caught', () => { guestCatch++; return vm.undefined; });
    vm.global.setProp('caught', caught);
    using derived = vm.evalCode('bridged.catch(caught)');
    const direct = observe(vm.resolvePromise(guest));
    const chained = observe(vm.resolvePromise(derived));
    const exports = vm._getExports();
    const call = vi.fn((...args: Parameters<typeof exports.qjs_call>) => exports.qjs_call(thrower.ptr, args[1], args[2], args[3]));
    (vm as unknown as { exports: typeof exports }).exports = { ...exports, qjs_call: call };
    source[direction](true);
    await finish(source);
    expect(call).toHaveBeenCalledTimes(1);
    expect(direct).toHaveLength(1);
    expect(direct[0].status).toBe('rejected');
    expect(direct[0].value).toBeInstanceOf(JSException);
    expect((direct[0].value as JSException).message).toBe('native resolver failed');
    expect(chained).toEqual(direct);
    expect(guestCatch).toBe(0);
    let late: unknown;
    try { vm.resolvePromise(guest); } catch (error) { late = error; }
    expect(late).toBe(direct[0].value);
    (late as JSException).dispose();
  });

  it('terminates if guest conversion of a conversion failure also fails', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const source = sourcePromise();
    using guest = vm.hostToHandle(source.promise);
    const outcomes = observe(vm.resolvePromise(guest));
    const failure = new Error('error translation failed');
    const conversion = vi.spyOn(vm, 'newError').mockImplementation(() => { throw failure; });
    source.resolve(Symbol('cannot convert'));
    await finish(source);
    conversion.mockRestore();
    expect(outcomes).toEqual([{ status: 'rejected', value: failure }]);
    expect(() => vm.evalCode('42')).toThrow(failure);
  });

  it.each(['resolve', 'reject'] as const)('ignores late host %s after disposal without reading its value', async direction => {
    const vm = await QuickJS.create(wasmBytes);
    const source = sourcePromise();
    using guest = vm.hostToHandle(source.promise);
    const outcomes = observe(vm.resolvePromise(guest));
    const deferred = vm.newPromise();
    using pending = deferred.handle;
    const settled = observe(deferred.settled);
    vm.dispose();
    let reads = 0;
    source[direction]({ get value() { reads++; return 42; } });
    await finish(source);
    expect(reads).toBe(0);
    for (const result of [outcomes, settled]) {
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('rejected');
      expect((result[0].value as Error).message).toContain('disposed');
    }
  });

  it('handles disposal reentered during host-value conversion', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const source = sourcePromise();
    using guest = vm.hostToHandle(source.promise);
    const outcomes = observe(vm.resolvePromise(guest));
    source.resolve({ get value() { vm.dispose(); return 42; } });
    await finish(source);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('rejected');
    expect((outcomes[0].value as Error).message).toContain('disposed');
  });

  it.each(['deferred', 'host bridge'] as const)('keeps private %s resolvers alive after scope exit', async kind => {
    using vm = await QuickJS.create(wasmBytes);
    const source = sourcePromise();
    let deferred: ReturnType<QuickJS['newPromise']> | undefined;
    using guest = vm.withScope(scope => {
      if (kind === 'host bridge') return scope.escape(vm.hostToHandle(source.promise));
      deferred = vm.newPromise();
      return scope.escape(deferred.handle);
    });
    const owned = (vm as unknown as { _ownedHandles: Set<JSValueHandle> })._ownedHandles;
    // Check ownership before invoking old code with already-freed native values.
    expect(owned.size).toBe(2);
    expect([...owned].every(handle => !handle.disposed)).toBe(true);
    const result = vm.resolvePromise(guest);
    if (deferred) { deferred.resolve(vm.true); vm.executePendingJobs(); }
    else { source.resolve(true); await finish(source); }
    const outcome = await result;
    expect('value' in outcome).toBe(true);
    release(outcome);
    expect(owned.size).toBe(0);
  });

  it.each(['settled', 'pending'] as const)('transfers %s host-result ownership out of a synchronous scope', async kind => {
    using vm = await QuickJS.create(wasmBytes);
    const deferred = vm.newPromise();
    using guest = deferred.handle;
    if (kind === 'settled') deferred.resolve(vm.true);
    const observed = vm.withScope(() => {
      const result = vm.resolvePromise(guest);
      if (kind === 'pending') { deferred.resolve(vm.true); vm.executePendingJobs(); }
      return result;
    });
    const result = await observed;
    const value = 'value' in result ? result.value : result.error;
    expect(value.disposed).toBe(false);
    expect(vm.dump(value)).toBe(true);
    value.dispose();
  });

  it('preserves a job failure through the canonical exception owner and permits synchronous recovery', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using reason = vm.newError('job failed');
    vm.evalCode('Promise.resolve().then(() => {})').dispose();
    const exports = vm._getExports();
    const execute = vi.fn(() => {
      using sentinel = new JSValueHandle(vm, exports.qjs_throw(reason.ptr));
      return -1;
    });
    (vm as unknown as { exports: typeof exports }).exports = { ...exports, qjs_execute_pending_job: execute };
    let failure: unknown;
    try { vm.executePendingJobs(); } catch (error) { failure = error; }
    (vm as unknown as { exports: typeof exports }).exports = exports;
    expect(failure).toBeInstanceOf(JSException);
    expect((failure as JSException).handle.identity).toBe(reason.identity);
    (failure as JSException).dispose();
    vm.executePendingJobs();
    expect(vm.evalCode('42').consume(value => value.toNumber())).toBe(42);
  });
});
