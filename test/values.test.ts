import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('cached properties', () => {
  it('should provide cached vm.global', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.global).toBe(vm.global);
  });

  it('should provide cached vm.undefined, vm.null, vm.true, vm.false', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.undefined.isUndefined).toBe(true);
    expect(vm.null.isNull).toBe(true);
    expect(vm.dump(vm.true)).toBe(true);
    expect(vm.dump(vm.false)).toBe(false);
    expect(vm.undefined).toBe(vm.undefined);
    expect(vm.null).toBe(vm.null);
    expect(vm.true).toBe(vm.true);
    expect(vm.false).toBe(vm.false);
  });
});

describe('newString / newNumber / newObject / newArray', () => {
  it('should create and read back string values', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using s = vm.newString('hello');
    expect(s.toString()).toBe('hello');
  });

  it('should create and read back number values', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using n = vm.newNumber(3.14);
    expect(n.toNumber()).toBeCloseTo(3.14);
  });
});

describe('newBigInt / toBigInt', () => {
  it('should create and extract bigint values', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using h = vm.newBigInt(42n);
    expect(vm.typeof(h)).toBe('bigint');
    expect(h.toBigInt()).toBe(42n);
  });

  it('should handle negative bigints', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using neg = vm.newBigInt(-1n);
    expect(neg.toBigInt()).toBe(-1n);
  });

  it('should handle large bigints', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using large = vm.newBigInt(0x1_0000_0000n);
    expect(large.toBigInt()).toBe(4294967296n);
  });
});

describe('newError', () => {
  it('should accept a string message', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using err = vm.newError('test message');
    const dumped = vm.dump(err) as Error;
    expect(dumped).toBeInstanceOf(Error);
    expect(dumped.message).toBe('test message');
  });

  it('should accept a native Error object', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using err = vm.newError(new TypeError('bad type'));
    const dumped = vm.dump(err) as Error;
    expect(dumped).toBeInstanceOf(Error);
    expect(dumped.name).toBe('TypeError');
    expect(dumped.message).toBe('bad type');
  });
});

describe('setProp', () => {
  it('should set properties via vm.setProp with string key', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using val = vm.newNumber(99);
    vm.setProp(vm.global, 'x', val);
    expect(vm.evalCode('x').consume(h => h.toNumber())).toBe(99);
  });
});

describe('defineProp', () => {
  it('should define a writable, configurable, non-enumerable property by default', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using val = vm.newNumber(42);
    vm.defineProp(vm.global, 'x', val);
    const desc = vm.evalCode(`JSON.stringify(Object.getOwnPropertyDescriptor(globalThis, 'x'))`).consume(h => JSON.parse(h.toString()));
    expect(desc.value).toBe(42);
    expect(desc.writable).toBe(false);
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(false);
  });

  it('should define a writable + configurable property (non-enumerable)', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using val = vm.newString('hello');
    vm.defineProp(vm.global, 'msg', val, { writable: true, configurable: true });
    const desc = vm.evalCode(`JSON.stringify(Object.getOwnPropertyDescriptor(globalThis, 'msg'))`).consume(h => JSON.parse(h.toString()));
    expect(desc.value).toBe('hello');
    expect(desc.writable).toBe(true);
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(true);
  });

  it('should define a fully enumerable property', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using val = vm.newNumber(99);
    vm.defineProp(vm.global, 'visible', val, { writable: true, enumerable: true, configurable: true });
    const desc = vm.evalCode(`JSON.stringify(Object.getOwnPropertyDescriptor(globalThis, 'visible'))`).consume(h => JSON.parse(h.toString()));
    expect(desc.value).toBe(99);
    expect(desc.writable).toBe(true);
    expect(desc.enumerable).toBe(true);
    expect(desc.configurable).toBe(true);
  });

  it('should define a read-only non-configurable property', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using val = vm.newString('frozen');
    vm.defineProp(vm.global, 'locked', val);
    // Should not be writable
    const result = vm.evalCode(`
      try { globalThis.locked = 'changed'; } catch(e) {}
      globalThis.locked
    `).consume(h => h.toString());
    expect(result).toBe('frozen');
  });

  it('should accept a JSValueHandle key (symbol)', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using sym = vm.evalCode(`Symbol.for('myKey')`);
    using val = vm.newNumber(123);
    vm.defineProp(vm.global, sym, val, { writable: true, configurable: true });
    const result = vm.evalCode(`globalThis[Symbol.for('myKey')]`).consume(h => h.toNumber());
    expect(result).toBe(123);
  });

  it('should accept a JSValueHandle string key', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using key = vm.newString('dynKey');
    using val = vm.newNumber(456);
    vm.defineProp(vm.global, key, val, { writable: true, enumerable: true, configurable: true });
    const desc = vm.evalCode(`JSON.stringify(Object.getOwnPropertyDescriptor(globalThis, 'dynKey'))`).consume(h => JSON.parse(h.toString()));
    expect(desc.value).toBe(456);
    expect(desc.writable).toBe(true);
    expect(desc.enumerable).toBe(true);
    expect(desc.configurable).toBe(true);
  });

  it('should work via JSValueHandle.defineProp with string key', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.newObject();
    using val = vm.newNumber(7);
    obj.defineProp('count', val, { writable: true, configurable: true });
    vm.setProp(vm.global, 'obj', obj);
    const desc = vm.evalCode(`JSON.stringify(Object.getOwnPropertyDescriptor(obj, 'count'))`).consume(h => JSON.parse(h.toString()));
    expect(desc.value).toBe(7);
    expect(desc.writable).toBe(true);
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(true);
  });

  it('should work via JSValueHandle.defineProp with symbol key', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.newObject();
    using sym = vm.evalCode(`Symbol.for('test')`);
    using val = vm.newString('symVal');
    obj.defineProp(sym, val, { writable: true, enumerable: true, configurable: true });
    vm.setProp(vm.global, 'obj', obj);
    const result = vm.evalCode(`obj[Symbol.for('test')]`).consume(h => h.toString());
    expect(result).toBe('symVal');
  });

  it('should not appear in for...in when non-enumerable', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.newObject();
    using v1 = vm.newNumber(1);
    using v2 = vm.newNumber(2);
    obj.setProp('visible', v1);
    obj.defineProp('hidden', v2, { writable: true, configurable: true });
    vm.setProp(vm.global, 'obj', obj);
    const keys = vm.evalCode(`
      const keys = [];
      for (const k in obj) keys.push(k);
      JSON.stringify(keys);
    `).consume(h => JSON.parse(h.toString()));
    expect(keys).toEqual(['visible']);
    // But the property should still exist
    const val = vm.evalCode('obj.hidden').consume(h => h.toNumber());
    expect(val).toBe(2);
  });
});

describe('dump', () => {
  it('should dump primitives', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.evalCode('42').consume(h => vm.dump(h))).toBe(42);
    expect(vm.evalCode('"hello"').consume(h => vm.dump(h))).toBe('hello');
    expect(vm.evalCode('true').consume(h => vm.dump(h))).toBe(true);
    expect(vm.evalCode('null').consume(h => vm.dump(h))).toBe(null);
    expect(vm.evalCode('undefined').consume(h => vm.dump(h))).toBe(undefined);
  });

  it('should dump arrays', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.evalCode('[1, 2, 3]').consume(h => vm.dump(h))).toEqual([1, 2, 3]);
  });

  it('should dump Error objects with name, message, and stack', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using err = vm.evalCode('new TypeError("test error")');
    const dumped = vm.dump(err) as Error;
    expect(dumped).toBeInstanceOf(Error);
    expect(dumped.name).toBe('TypeError');
    expect(dumped.message).toBe('test error');
    expect(dumped.stack).toBeDefined();
  });

  it('should dump bigint', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.evalCode('BigInt(42)').consume(h => vm.dump(h))).toBe(42n);
  });

  it('should dump plain objects via native key enumeration', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.evalCode('({ a: 1, b: "two", c: true })').consume(h => vm.dump(h))).toEqual({ a: 1, b: 'two', c: true });
  });

  it('should dump nested objects', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.evalCode('({ x: { y: { z: 42 } } })').consume(h => vm.dump(h))).toEqual({ x: { y: { z: 42 } } });
  });

  it('should dump objects with array values', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.evalCode('({ items: [1, 2, 3], name: "test" })').consume(h => vm.dump(h))).toEqual({ items: [1, 2, 3], name: 'test' });
  });

  it('should dump objects with null and undefined values', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.evalCode('({ a: null, b: undefined })').consume(h => vm.dump(h))).toEqual({ a: null, b: undefined });
  });

  it('should dump objects with function values as undefined', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const dumped = vm.evalCode('({ fn: () => {} })').consume(h => vm.dump(h)) as any;
    expect(dumped).toHaveProperty('fn');
    expect(dumped.fn).toBeUndefined();
  });

  it('should preserve circular references', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const dumped = vm.evalCode(`
      var obj = { a: 1 };
      obj.self = obj;
      obj;
    `).consume(h => vm.dump(h)) as any;
    expect(dumped.a).toBe(1);
    expect(dumped.self).toBe(dumped); // same object reference
  });

  it('should preserve shared references', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const dumped = vm.evalCode(`
      var shared = { x: 42 };
      ({ a: shared, b: shared });
    `).consume(h => vm.dump(h)) as any;
    expect(dumped.a.x).toBe(42);
    expect(dumped.a).toBe(dumped.b); // same object reference
  });

  it('should preserve circular references in arrays', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const dumped = vm.evalCode(`
      var arr = [1, 2];
      arr.push(arr);
      arr;
    `).consume(h => vm.dump(h)) as any;
    expect(dumped[0]).toBe(1);
    expect(dumped[1]).toBe(2);
    expect(dumped[2]).toBe(dumped); // same array reference
  });

  it('should dump empty objects', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.evalCode('({})').consume(h => vm.dump(h))).toEqual({});
  });

  it('should only dump own enumerable properties', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const dumped = vm.evalCode(`
      var obj = { visible: true };
      Object.defineProperty(obj, 'hidden', { value: 'secret', enumerable: false });
      obj;
    `).consume(h => vm.dump(h)) as any;
    expect(dumped).toEqual({ visible: true });
    expect(dumped).not.toHaveProperty('hidden');
  });
});

describe('hostToHandle', () => {
  it('should convert host values to QuickJS handles', async () => {
    using vm = await QuickJS.create(wasmBytes);
    vm.hostToHandle('hello').consume(h => vm.setProp(vm.global, 's', h));
    vm.hostToHandle(42).consume(h => vm.setProp(vm.global, 'n', h));
    vm.hostToHandle(true).consume(h => vm.setProp(vm.global, 'b', h));
    vm.hostToHandle(null).consume(h => vm.setProp(vm.global, 'nil', h));
    vm.hostToHandle([1, 2, 3]).consume(h => vm.setProp(vm.global, 'arr', h));
    vm.hostToHandle({ x: 10 }).consume(h => vm.setProp(vm.global, 'obj', h));

    expect(vm.evalCode('s').consume(h => h.toString())).toBe('hello');
    expect(vm.evalCode('n').consume(h => h.toNumber())).toBe(42);
    expect(vm.evalCode('b').consume(h => vm.dump(h))).toBe(true);
    expect(vm.evalCode('nil').consume(h => vm.dump(h))).toBe(null);
    expect(vm.evalCode('arr.length').consume(h => h.toNumber())).toBe(3);
    expect(vm.evalCode('obj.x').consume(h => h.toNumber())).toBe(10);
  });

  it('should convert bigint', async () => {
    using vm = await QuickJS.create(wasmBytes);
    vm.hostToHandle(42n).consume(h => vm.setProp(vm.global, 'bi', h));
    expect(vm.evalCode('bi').consume(h => vm.dump(h))).toBe(42n);
  });

  it('should convert Error', async () => {
    using vm = await QuickJS.create(wasmBytes);
    vm.hostToHandle(new TypeError('boom')).consume(h => vm.setProp(vm.global, 'e', h));
    expect(vm.evalCode('e.name').consume(h => h.toString())).toBe('TypeError');
    expect(vm.evalCode('e.message').consume(h => h.toString())).toBe('boom');
  });
});
