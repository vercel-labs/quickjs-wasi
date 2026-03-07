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
