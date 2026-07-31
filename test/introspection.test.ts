import { describe, it, expect } from 'vitest';
import { QuickJS, type JSValueHandle } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

/**
 * Tests for the engine-level introspection primitives: brand checks
 * (isProxy/isMap/isSet/isDate/isRegExp/...), class IDs, trap-free proxy
 * target/handler access, symbol-aware own-key enumeration, and
 * getter-safe own-property descriptor reads.
 *
 * The unifying contract under test: NONE of these primitives may execute
 * guest code (no proxy traps, no getters, no Symbol.hasInstance, no
 * prototype-chain method lookups), and none may be spoofed or broken by
 * guest-side prototype/constructor mutation.
 */

describe('brand check getters', () => {
  it('isMap/isSet/isDate/isRegExp identify genuine instances', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using map = vm.evalCode('new Map([[1, 2]])');
    using set = vm.evalCode('new Set([1, 2])');
    using date = vm.evalCode('new Date(0)');
    using regexp = vm.evalCode('/abc/g');

    expect(map.isMap).toBe(true);
    expect(set.isSet).toBe(true);
    expect(date.isDate).toBe(true);
    expect(regexp.isRegExp).toBe(true);

    // Cross-checks
    expect(map.isSet).toBe(false);
    expect(set.isMap).toBe(false);
    expect(date.isRegExp).toBe(false);
    expect(regexp.isDate).toBe(false);
  });

  it('isWeakRef/isWeakMap/isWeakSet/isDataView identify genuine instances', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using weakRef = vm.evalCode('new WeakRef({})');
    using weakMap = vm.evalCode('new WeakMap()');
    using weakSet = vm.evalCode('new WeakSet()');
    using dataView = vm.evalCode('new DataView(new ArrayBuffer(8))');

    expect(weakRef.isWeakRef).toBe(true);
    expect(weakMap.isWeakMap).toBe(true);
    expect(weakSet.isWeakSet).toBe(true);
    expect(dataView.isDataView).toBe(true);

    expect(weakMap.isMap).toBe(false);
    expect(weakSet.isSet).toBe(false);
    expect(dataView.isArrayBuffer).toBe(false);
  });

  it('returns false for primitives and plain objects', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({})');
    using num = vm.evalCode('42');
    using str = vm.evalCode('"hello"');

    for (const h of [obj, num, str]) {
      expect(h.isProxy).toBe(false);
      expect(h.isMap).toBe(false);
      expect(h.isSet).toBe(false);
      expect(h.isDate).toBe(false);
      expect(h.isRegExp).toBe(false);
      expect(h.isWeakRef).toBe(false);
      expect(h.isWeakMap).toBe(false);
      expect(h.isWeakSet).toBe(false);
      expect(h.isDataView).toBe(false);
    }
  });

  it('cannot be spoofed by constructor/prototype/Symbol.hasInstance tricks', async () => {
    using vm = await QuickJS.create(wasmBytes);
    // All the classic spoofs that fool constructor-name and instanceof checks
    using fakeDate = vm.evalCode('({ constructor: Date })');
    using protoDate = vm.evalCode('Object.create(Date.prototype)');
    using hasInstanceSpoof = vm.evalCode(`
      class Weird { static [Symbol.hasInstance]() { return true; } }
      new Weird()
    `);
    using toStringTagSpoof = vm.evalCode('({ [Symbol.toStringTag]: "Map" })');

    expect(fakeDate.isDate).toBe(false);
    expect(protoDate.isDate).toBe(false);
    expect(hasInstanceSpoof.isMap).toBe(false);
    expect(hasInstanceSpoof.isDate).toBe(false);
    expect(toStringTagSpoof.isMap).toBe(false);
  });

  it('is unaffected by guest prototype/global mutation', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using date = vm.evalCode(`
      // Sabotage everything a lookup-based check might rely on
      Date.prototype.toISOString = function () { throw new Error('side effect!'); };
      const d = new Date(0);
      Object.setPrototypeOf(d, null);
      globalThis.Date = function FakeDate() {};
      d
    `);
    expect(date.isDate).toBe(true);
  });
});

describe('construct', () => {
  it('invokes a constructor with new', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using DateCtor = vm.evalCode('Date');
    using iso = vm.newString('2023-11-14T22:13:20.000Z');
    using date = vm.construct(DateCtor, iso);

    expect(date.isDate).toBe(true);
    using time = vm.evalCode('(d) => d.getTime()');
    expect(
      vm.callFunction(time, vm.undefined, date).consume((h) => h.toNumber())
    ).toBe(1700000000000);
  });

  it('supports zero-argument and multi-argument construction', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using MapCtor = vm.evalCode('Map');
    using map = vm.construct(MapCtor);
    expect(map.isMap).toBe(true);

    using RegExpCtor = vm.evalCode('RegExp');
    using source = vm.newString('ab+c');
    using flags = vm.newString('gi');
    using regexp = vm.construct(RegExpCtor, source, flags);
    expect(regexp.isRegExp).toBe(true);
    expect(regexp.getProp('flags').consume((h) => h.toString())).toBe('gi');
  });

  it('constructs user classes', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using Point = vm.evalCode('globalThis.Point = class Point { constructor(x, y) { this.x = x; this.y = y; } }');
    using x = vm.newNumber(3);
    using y = vm.newNumber(4);
    using point = vm.construct(Point, x, y);

    vm.setProp(vm.global, 'point', point);
    using check = vm.evalCode('point instanceof Point && point.x === 3 && point.y === 4');
    expect(check.toBoolean()).toBe(true);
  });

  it('throws JSException when the constructor throws', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using Throwing = vm.evalCode('(class T { constructor() { throw new Error("boom"); } })');
    expect(() => vm.construct(Throwing)).toThrow(/boom/);
  });

  it('throws when the value is not a constructor', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using notCtor = vm.evalCode('({})');
    expect(() => vm.construct(notCtor)).toThrow();
  });
});

describe('identity', () => {
  it('is stable per underlying value and distinct across values', async () => {
    using vm = await QuickJS.create(wasmBytes);
    vm.evalCode('globalThis.shared = { a: 1 }; globalThis.other = { a: 1 };').dispose();

    using first = vm.evalCode('globalThis.shared');
    using second = vm.evalCode('globalThis.shared');
    using other = vm.evalCode('globalThis.other');

    // two independent handles to one object agree...
    expect(first.identity).toBe(second.identity);
    // ...and differ from a structurally identical but distinct object
    expect(first.identity).not.toBe(other.identity);
    expect(first.identity).toBeGreaterThan(0);
  });

  it('is 0 for values that are not heap-allocated', async () => {
    using vm = await QuickJS.create(wasmBytes);
    for (const expression of ['42', 'true', 'null', 'undefined']) {
      using handle = vm.evalCode(expression);
      expect(handle.identity).toBe(0);
    }
  });

  it('survives being read through a proxy without unwrapping', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using proxy = vm.evalCode('new Proxy({}, {})');
    using target = proxy.getProxyTarget();

    // the proxy and its target are distinct values
    expect(proxy.identity).not.toBe(target.identity);
  });
});

describe('toBoolean', () => {
  it('applies JavaScript truthiness', async () => {
    using vm = await QuickJS.create(wasmBytes);
    for (const [expression, expected] of [
      ['true', true],
      ['false', false],
      ['1', true],
      ['0', false],
      ['""', false],
      ['"x"', true],
      ['null', false],
      ['undefined', false],
      ['({})', true],
      ['[]', true],
    ] as const) {
      using handle = vm.evalCode(expression);
      expect(handle.toBoolean(), expression).toBe(expected);
    }
  });
});

describe('classId', () => {
  it('returns 0 for non-objects and stable distinct IDs for object brands', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using num = vm.evalCode('42');
    using map1 = vm.evalCode('new Map()');
    using map2 = vm.evalCode('new Map()');
    using set = vm.evalCode('new Set()');

    expect(num.classId).toBe(0);
    expect(map1.classId).toBeGreaterThan(0);
    expect(map1.classId).toBe(map2.classId);
    expect(set.classId).toBeGreaterThan(0);
    expect(set.classId).not.toBe(map1.classId);
  });
});

describe('proxy introspection', () => {
  it('detects proxies that are indistinguishable from within JS', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using proxy = vm.evalCode('new Proxy({ a: 1 }, {})');
    using target = vm.evalCode('({ a: 1 })');

    expect(proxy.isProxy).toBe(true);
    expect(target.isProxy).toBe(false);
  });

  it('a Proxy wrapping a branded object is not that brand', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using mapProxy = vm.evalCode('new Proxy(new Map(), {})');
    using arrayProxy = vm.evalCode('new Proxy([], {})');

    expect(mapProxy.isProxy).toBe(true);
    expect(mapProxy.isMap).toBe(false);
    expect(arrayProxy.isProxy).toBe(true);
    // quickjs-ng's JS_IsArray no longer punches through proxies
    expect(arrayProxy.isArray).toBe(false);

    // ...but the unwrapped target is the brand
    using target = mapProxy.getProxyTarget();
    expect(target.isMap).toBe(true);
  });

  it('isProxy and getProxyTarget/getProxyHandler fire zero traps', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using proxy = vm.evalCode(`
      globalThis.trapCount = 0;
      const countingHandler = new Proxy({}, {
        // Trap ALL trap lookups: any proxy operation first reads the
        // trap function off the handler, so this counts every
        // engine-initiated operation on the proxy.
        get(t, prop) { globalThis.trapCount++; return undefined; }
      });
      new Proxy({ a: 1 }, countingHandler)
    `);

    expect(proxy.isProxy).toBe(true);
    expect(proxy.isMap).toBe(false);
    expect(proxy.classId).toBeGreaterThan(0);
    using target = proxy.getProxyTarget();
    using handler = proxy.getProxyHandler();
    expect(target.isObject).toBe(true);
    expect(handler.isProxy).toBe(true);

    using count = vm.evalCode('globalThis.trapCount');
    expect(count.toNumber()).toBe(0);
  });

  it('getProxyTarget/getProxyHandler recover the exact objects', async () => {
    using vm = await QuickJS.create(wasmBytes);
    vm.evalCode(`
      globalThis.t = { marker: 123 };
      globalThis.h = { get() { return 'trapped'; } };
      globalThis.p = new Proxy(globalThis.t, globalThis.h);
    `).dispose();
    using proxy = vm.evalCode('globalThis.p');
    using target = proxy.getProxyTarget();
    using handler = proxy.getProxyHandler();

    using isSame = vm.evalCode('(a, b) => a === b');
    using globalTarget = vm.evalCode('globalThis.t');
    using globalHandler = vm.evalCode('globalThis.h');

    using sameTarget = vm.callFunction(isSame, vm.undefined, target, globalTarget);
    expect(vm.dump(sameTarget)).toBe(true);
    using sameHandler = vm.callFunction(isSame, vm.undefined, handler, globalHandler);
    expect(vm.dump(sameHandler)).toBe(true);
  });

  it('getProxyTarget throws JSException for non-proxies', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({})');
    expect(() => obj.getProxyTarget()).toThrow();
    expect(() => obj.getProxyHandler()).toThrow();
  });

  it('supports nested proxies (target is itself a proxy)', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using outer = vm.evalCode('new Proxy(new Proxy(new Map(), {}), {})');
    expect(outer.isProxy).toBe(true);
    using inner = outer.getProxyTarget();
    expect(inner.isProxy).toBe(true);
    using innermost = inner.getProxyTarget();
    expect(innermost.isProxy).toBe(false);
    expect(innermost.isMap).toBe(true);
  });
});

describe('getOwnPropertyKeys', () => {
  it('returns string and symbol keys, including non-enumerable', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode(`
      const o = { plain: 1 };
      Object.defineProperty(o, 'hidden', { value: 2, enumerable: false });
      o[Symbol.for('tag')] = 3;
      o
    `);
    const keys = obj.getOwnPropertyKeys();
    try {
      const strings = keys.filter((k): k is string => typeof k === 'string');
      const symbols = keys.filter((k): k is JSValueHandle => typeof k !== 'string');
      expect(strings).toEqual(['plain', 'hidden']);
      expect(symbols).toHaveLength(1);
      expect(symbols[0]!.isSymbol).toBe(true);
    } finally {
      for (const k of keys) {
        if (typeof k !== 'string') k.dispose();
      }
    }
  });

  it('symbol key handles are usable to read the descriptor', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({ [Symbol.for("s")]: "symbol value" })');
    const keys = obj.getOwnPropertyKeys();
    const symKey = keys.find((k): k is JSValueHandle => typeof k !== 'string')!;
    try {
      const desc = obj.getOwnPropertyDescriptor(symKey);
      expect(desc).toBeDefined();
      expect(desc!.value!.toString()).toBe('symbol value');
      desc!.value!.dispose();
    } finally {
      for (const k of keys) {
        if (typeof k !== 'string') k.dispose();
      }
    }
  });
});

describe('getOwnPropertyDescriptor', () => {
  it('returns data descriptors with value/writable/enumerable/configurable', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode(`
      const o = { normal: 42 };
      Object.defineProperty(o, 'locked', {
        value: 'ro', writable: false, enumerable: false, configurable: false,
      });
      o
    `);

    const normal = obj.getOwnPropertyDescriptor('normal')!;
    expect(normal.value!.toNumber()).toBe(42);
    expect(normal.writable).toBe(true);
    expect(normal.enumerable).toBe(true);
    expect(normal.configurable).toBe(true);
    expect(normal.get).toBeUndefined();
    normal.value!.dispose();

    const locked = obj.getOwnPropertyDescriptor('locked')!;
    expect(locked.value!.toString()).toBe('ro');
    expect(locked.writable).toBe(false);
    expect(locked.enumerable).toBe(false);
    expect(locked.configurable).toBe(false);
    locked.value!.dispose();
  });

  it('returns accessor descriptors WITHOUT invoking the getter', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode(`
      globalThis.getterCalls = 0;
      ({
        get sideEffecty() { globalThis.getterCalls++; return 'evil'; },
      })
    `);

    const desc = obj.getOwnPropertyDescriptor('sideEffecty')!;
    expect(desc.value).toBeUndefined();
    expect(desc.writable).toBeUndefined();
    expect(desc.get!.isFunction).toBe(true);
    expect(desc.set!.isUndefined).toBe(true);
    expect(desc.enumerable).toBe(true);
    expect(desc.configurable).toBe(true);

    // The whole point: the getter was never executed
    using calls = vm.evalCode('globalThis.getterCalls');
    expect(calls.toNumber()).toBe(0);

    desc.get!.dispose();
    desc.set!.dispose();
  });

  it('returns undefined for missing and inherited properties', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('Object.create({ inherited: 1 })');
    expect(obj.getOwnPropertyDescriptor('missing')).toBeUndefined();
    expect(obj.getOwnPropertyDescriptor('inherited')).toBeUndefined();
  });

  it('the returned getter handle is callable on demand', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({ get lazy() { return "computed " + this.suffix; }, suffix: "later" })');
    const desc = obj.getOwnPropertyDescriptor('lazy')!;
    using result = vm.callFunction(desc.get!, obj);
    expect(result.toString()).toBe('computed later');
    desc.get!.dispose();
    desc.set!.dispose();
  });
});

describe('introspection across snapshot/restore', () => {
  it('brand checks and descriptors survive snapshot restore', async () => {
    const vm1 = await QuickJS.create(wasmBytes);
    vm1.evalCode(`
      globalThis.m = new Map([['k', 'v']]);
      globalThis.p = new Proxy({}, {});
      globalThis.o = { get g() { return 1; } };
    `).dispose();
    const snapshot = vm1.snapshot();
    vm1.dispose();

    using vm2 = await QuickJS.restore(snapshot, wasmBytes);
    using map = vm2.evalCode('globalThis.m');
    using proxy = vm2.evalCode('globalThis.p');
    using obj = vm2.evalCode('globalThis.o');

    expect(map.isMap).toBe(true);
    expect(proxy.isProxy).toBe(true);
    const desc = obj.getOwnPropertyDescriptor('g')!;
    expect(desc.get!.isFunction).toBe(true);
    desc.get!.dispose();
    desc.set!.dispose();
  });
});
