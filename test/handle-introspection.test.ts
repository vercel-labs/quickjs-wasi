import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

// ─── Type-checking getters ───────────────────────────────────────────────────

describe('JSValueHandle type-checking getters', () => {
  it('isBool should return true for booleans', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using t = vm.evalCode('true');
    using f = vm.evalCode('false');
    expect(t.isBool).toBe(true);
    expect(f.isBool).toBe(true);
  });

  it('isBool should return false for non-booleans', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using n = vm.evalCode('42');
    using s = vm.evalCode('"hello"');
    expect(n.isBool).toBe(false);
    expect(s.isBool).toBe(false);
  });

  it('isNumber should return true for numbers', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using n = vm.evalCode('42');
    using f = vm.evalCode('3.14');
    using z = vm.evalCode('0');
    using nan = vm.evalCode('NaN');
    using inf = vm.evalCode('Infinity');
    expect(n.isNumber).toBe(true);
    expect(f.isNumber).toBe(true);
    expect(z.isNumber).toBe(true);
    expect(nan.isNumber).toBe(true);
    expect(inf.isNumber).toBe(true);
  });

  it('isNumber should return false for non-numbers', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using s = vm.evalCode('"42"');
    using b = vm.evalCode('true');
    expect(s.isNumber).toBe(false);
    expect(b.isNumber).toBe(false);
  });

  it('isString should return true for strings', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using s = vm.evalCode('"hello"');
    using empty = vm.evalCode('""');
    expect(s.isString).toBe(true);
    expect(empty.isString).toBe(true);
  });

  it('isString should return false for non-strings', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using n = vm.evalCode('42');
    expect(n.isString).toBe(false);
  });

  it('isSymbol should return true for symbols', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using sym = vm.evalCode('Symbol("test")');
    using symFor = vm.evalCode('Symbol.for("global")');
    expect(sym.isSymbol).toBe(true);
    expect(symFor.isSymbol).toBe(true);
  });

  it('isSymbol should return false for non-symbols', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using s = vm.evalCode('"Symbol"');
    expect(s.isSymbol).toBe(false);
  });

  it('isBigInt should return true for bigints', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using bi = vm.evalCode('BigInt(42)');
    using bi2 = vm.evalCode('0n');
    expect(bi.isBigInt).toBe(true);
    expect(bi2.isBigInt).toBe(true);
  });

  it('isBigInt should return false for regular numbers', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using n = vm.evalCode('42');
    expect(n.isBigInt).toBe(false);
  });

  it('isObject should return true for objects', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({})');
    using arr = vm.evalCode('[]');
    using date = vm.evalCode('new Date()');
    expect(obj.isObject).toBe(true);
    expect(arr.isObject).toBe(true);
    expect(date.isObject).toBe(true);
  });

  it('isObject should return false for primitives and null', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using n = vm.evalCode('42');
    using s = vm.evalCode('"hello"');
    using nul = vm.evalCode('null');
    using undef = vm.evalCode('undefined');
    expect(n.isObject).toBe(false);
    expect(s.isObject).toBe(false);
    expect(nul.isObject).toBe(false);
    expect(undef.isObject).toBe(false);
  });

  it('isArray should return true for arrays', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using arr = vm.evalCode('[1, 2, 3]');
    using empty = vm.evalCode('[]');
    expect(arr.isArray).toBe(true);
    expect(empty.isArray).toBe(true);
  });

  it('isArray should return false for non-arrays', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({})');
    using s = vm.evalCode('"array"');
    expect(obj.isArray).toBe(false);
    expect(s.isArray).toBe(false);
  });

  it('isFunction should return true for functions', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using fn = vm.evalCode('() => {}');
    using fn2 = vm.evalCode('function foo() {}; foo');
    using cls = vm.evalCode('class C {}; C');
    expect(fn.isFunction).toBe(true);
    expect(fn2.isFunction).toBe(true);
    expect(cls.isFunction).toBe(true);
  });

  it('isFunction should return false for non-functions', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({})');
    using n = vm.evalCode('42');
    expect(obj.isFunction).toBe(false);
    expect(n.isFunction).toBe(false);
  });

  it('isError should return true for errors', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using err = vm.evalCode('new Error("test")');
    using te = vm.evalCode('new TypeError("type")');
    using re = vm.evalCode('new RangeError("range")');
    expect(err.isError).toBe(true);
    expect(te.isError).toBe(true);
    expect(re.isError).toBe(true);
  });

  it('isError should return false for non-errors', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({})');
    using s = vm.evalCode('"Error"');
    expect(obj.isError).toBe(false);
    expect(s.isError).toBe(false);
  });

  it('isPromise should return true for promises', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using p = vm.evalCode('new Promise(() => {})');
    using p2 = vm.evalCode('Promise.resolve(42)');
    expect(p.isPromise).toBe(true);
    expect(p2.isPromise).toBe(true);
  });

  it('isPromise should return false for non-promises', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({})');
    expect(obj.isPromise).toBe(false);
  });

  it('isArrayBuffer should return true for ArrayBuffers', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using ab = vm.evalCode('new ArrayBuffer(8)');
    expect(ab.isArrayBuffer).toBe(true);
  });

  it('isArrayBuffer should return false for non-ArrayBuffers', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using arr = vm.evalCode('[1, 2, 3]');
    using obj = vm.evalCode('({})');
    expect(arr.isArrayBuffer).toBe(false);
    expect(obj.isArrayBuffer).toBe(false);
  });
});

// ─── typeof getter ──────────────────────────────────────────────────────────

describe('JSValueHandle.typeof getter', () => {
  it('should return correct typeof strings for all types', async () => {
    using vm = await QuickJS.create(wasmBytes);

    const cases: [string, string][] = [
      ['42', 'number'],
      ['"hello"', 'string'],
      ['true', 'boolean'],
      ['undefined', 'undefined'],
      ['null', 'object'],
      ['({})', 'object'],
      ['(() => {})', 'function'],
      ['Symbol("test")', 'symbol'],
      ['BigInt(42)', 'bigint'],
    ];

    for (const [code, expected] of cases) {
      using h = vm.evalCode(code);
      expect(h.typeof).toBe(expected);
    }
  });

  it('should match vm.typeof()', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using h = vm.evalCode('({ a: 1 })');
    expect(h.typeof).toBe(vm.typeof(h));
  });
});

// ─── length getter ──────────────────────────────────────────────────────────

describe('JSValueHandle.length getter', () => {
  it('should return array length', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using arr = vm.evalCode('[1, 2, 3, 4, 5]');
    expect(arr.length).toBe(5);
  });

  it('should return 0 for empty arrays', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using arr = vm.evalCode('[]');
    expect(arr.length).toBe(0);
  });

  it('should return string length', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using s = vm.evalCode('"hello"');
    expect(s.length).toBe(5);
  });

  it('should return function arity', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using fn = vm.evalCode('(function(a, b, c) {})');
    expect(fn.length).toBe(3);
  });
});

// ─── constructorName getter ─────────────────────────────────────────────────

describe('JSValueHandle.constructorName getter', () => {
  it('should return "Object" for plain objects', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({})');
    expect(obj.constructorName).toBe('Object');
  });

  it('should return "Array" for arrays', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using arr = vm.evalCode('[]');
    expect(arr.constructorName).toBe('Array');
  });

  it('should return "Date" for dates', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using d = vm.evalCode('new Date()');
    expect(d.constructorName).toBe('Date');
  });

  it('should return "RegExp" for regexps', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using r = vm.evalCode('/test/g');
    expect(r.constructorName).toBe('RegExp');
  });

  it('should return "Error" for errors', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using e = vm.evalCode('new Error("test")');
    expect(e.constructorName).toBe('Error');
  });

  it('should return "TypeError" for TypeErrors', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using e = vm.evalCode('new TypeError("test")');
    expect(e.constructorName).toBe('TypeError');
  });

  it('should return custom class name', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('class MyClass {}; new MyClass()');
    expect(obj.constructorName).toBe('MyClass');
  });

  it('should return undefined for null-prototype objects', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('Object.create(null)');
    expect(obj.constructorName).toBeUndefined();
  });

  it('should return wrapper constructor name for primitives', async () => {
    using vm = await QuickJS.create(wasmBytes);
    // In QuickJS, property access on primitives auto-boxes,
    // so getProp('constructor') returns the wrapper constructor
    using n = vm.evalCode('42');
    expect(n.constructorName).toBe('Number');
    using s = vm.evalCode('"hello"');
    expect(s.constructorName).toBe('String');
    using b = vm.evalCode('true');
    expect(b.constructorName).toBe('Boolean');
  });
});

// ─── keys() ─────────────────────────────────────────────────────────────────

describe('JSValueHandle.keys()', () => {
  it('should return enumerable own property names', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({ a: 1, b: 2, c: 3 })');
    expect(obj.keys()).toEqual(['a', 'b', 'c']);
  });

  it('should return empty array for empty object', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({})');
    expect(obj.keys()).toEqual([]);
  });

  it('should not include non-enumerable properties', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode(`
      var o = { visible: 1 };
      Object.defineProperty(o, 'hidden', { value: 2, enumerable: false });
      o;
    `);
    expect(obj.keys()).toEqual(['visible']);
  });

  it('should return numeric indices for arrays', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using arr = vm.evalCode('[10, 20, 30]');
    expect(arr.keys()).toEqual(['0', '1', '2']);
  });
});

// ─── getOwnPropertyNames() ─────────────────────────────────────────────────

describe('JSValueHandle.getOwnPropertyNames()', () => {
  it('should return all own property names including non-enumerable', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode(`
      var o = { visible: 1 };
      Object.defineProperty(o, 'hidden', { value: 2, enumerable: false });
      o;
    `);
    const names = obj.getOwnPropertyNames();
    expect(names).toContain('visible');
    expect(names).toContain('hidden');
  });

  it('should return empty array for empty object', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({})');
    expect(obj.getOwnPropertyNames()).toEqual([]);
  });

  it('should include length for arrays', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using arr = vm.evalCode('[1, 2, 3]');
    const names = arr.getOwnPropertyNames();
    expect(names).toContain('0');
    expect(names).toContain('1');
    expect(names).toContain('2');
    expect(names).toContain('length');
  });

  it('should include non-enumerable built-in properties', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using fn = vm.evalCode('(function myFunc(a, b) {})');
    const names = fn.getOwnPropertyNames();
    expect(names).toContain('length');
    expect(names).toContain('name');
  });
});

// ─── hasOwnProperty() ──────────────────────────────────────────────────────

describe('JSValueHandle.hasOwnProperty()', () => {
  it('should return true for own properties', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({ a: 1, b: 2 })');
    expect(obj.hasOwnProperty('a')).toBe(true);
    expect(obj.hasOwnProperty('b')).toBe(true);
  });

  it('should return false for non-existent properties', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({ a: 1 })');
    expect(obj.hasOwnProperty('z')).toBe(false);
  });

  it('should return false for inherited properties', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({ a: 1 })');
    // toString is inherited from Object.prototype
    expect(obj.hasOwnProperty('toString')).toBe(false);
  });

  it('should return true for non-enumerable own properties', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode(`
      var o = {};
      Object.defineProperty(o, 'hidden', { value: 42, enumerable: false });
      o;
    `);
    expect(obj.hasOwnProperty('hidden')).toBe(true);
  });

  it('should return true for own properties with undefined value', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({ x: undefined })');
    expect(obj.hasOwnProperty('x')).toBe(true);
  });
});

// ─── propertyIsEnumerable() ─────────────────────────────────────────────────

describe('JSValueHandle.propertyIsEnumerable()', () => {
  it('should return true for enumerable properties', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({ a: 1 })');
    expect(obj.propertyIsEnumerable('a')).toBe(true);
  });

  it('should return false for non-enumerable properties', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode(`
      var o = {};
      Object.defineProperty(o, 'hidden', { value: 42, enumerable: false });
      o;
    `);
    expect(obj.propertyIsEnumerable('hidden')).toBe(false);
  });

  it('should return false for non-existent properties', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({ a: 1 })');
    expect(obj.propertyIsEnumerable('z')).toBe(false);
  });

  it('should return false for inherited properties', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({})');
    // toString is inherited, not own
    expect(obj.propertyIsEnumerable('toString')).toBe(false);
  });

  it('should correctly identify array index enumerability', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using arr = vm.evalCode('[10, 20, 30]');
    expect(arr.propertyIsEnumerable('0')).toBe(true);
    expect(arr.propertyIsEnumerable('1')).toBe(true);
    // length is not enumerable
    expect(arr.propertyIsEnumerable('length')).toBe(false);
  });
});

// ─── getPrototypeOf() ──────────────────────────────────────────────────────

describe('JSValueHandle.getPrototypeOf()', () => {
  it('should return the prototype of a plain object', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('({})');
    using proto = obj.getPrototypeOf();
    // The prototype of a plain object is Object.prototype
    expect(proto.isObject).toBe(true);
    expect(proto.isNull).toBe(false);
  });

  it('should return null for null-prototype objects', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode('Object.create(null)');
    using proto = obj.getPrototypeOf();
    expect(proto.isNull).toBe(true);
  });

  it('should return the correct prototype for custom classes', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode(`
      class Animal { speak() { return "..."; } }
      new Animal();
    `);
    using proto = obj.getPrototypeOf();
    // The prototype should have the "speak" method
    using speak = proto.getProp('speak');
    expect(speak.isFunction).toBe(true);
  });

  it('should return Array.prototype for arrays', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using arr = vm.evalCode('[]');
    using proto = arr.getPrototypeOf();
    // Array.prototype should have "push"
    using push = proto.getProp('push');
    expect(push.isFunction).toBe(true);
  });

  it('should support prototype chain traversal', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode(`
      class Base { baseMethod() {} }
      class Child extends Base { childMethod() {} }
      new Child();
    `);
    // Child instance -> Child.prototype -> Base.prototype -> Object.prototype -> null
    using childProto = obj.getPrototypeOf();
    using childMethod = childProto.getProp('childMethod');
    expect(childMethod.isFunction).toBe(true);

    using baseProto = childProto.getPrototypeOf();
    using baseMethod = baseProto.getProp('baseMethod');
    expect(baseMethod.isFunction).toBe(true);

    using objectProto = baseProto.getPrototypeOf();
    expect(objectProto.isObject).toBe(true);

    using nullProto = objectProto.getPrototypeOf();
    expect(nullProto.isNull).toBe(true);
  });
});

// ─── Integration: combined usage ────────────────────────────────────────────

describe('JSValueHandle introspection integration', () => {
  it('should support a full inspection workflow on an object', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode(`({
      name: "QuickJS",
      version: 42,
      features: ["ES2023", "BigInt"],
      nested: { a: 1 },
    })`);

    // Type check
    expect(obj.typeof).toBe('object');
    expect(obj.isObject).toBe(true);
    expect(obj.isArray).toBe(false);
    expect(obj.isNull).toBe(false);

    // Enumerate keys
    const keys = obj.keys();
    expect(keys).toEqual(['name', 'version', 'features', 'nested']);

    // Access properties
    using name = obj.getProp('name');
    expect(name.isString).toBe(true);
    expect(name.toString()).toBe('QuickJS');

    using version = obj.getProp('version');
    expect(version.isNumber).toBe(true);
    expect(version.toNumber()).toBe(42);

    using features = obj.getProp('features');
    expect(features.isArray).toBe(true);
    expect(features.length).toBe(2);

    using first = features.getProp('0');
    expect(first.toString()).toBe('ES2023');

    using nested = obj.getProp('nested');
    expect(nested.isObject).toBe(true);
    expect(nested.keys()).toEqual(['a']);

    // Constructor name
    expect(obj.constructorName).toBe('Object');
    expect(features.constructorName).toBe('Array');
  });

  it('should support inspecting a function', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using fn = vm.evalCode('(function myFunc(a, b) { return a + b; })');

    expect(fn.typeof).toBe('function');
    expect(fn.isFunction).toBe(true);
    expect(fn.length).toBe(2);

    using name = fn.getProp('name');
    expect(name.toString()).toBe('myFunc');
  });

  it('should support inspecting with non-enumerable properties', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode(`
      var o = { visible: true };
      Object.defineProperty(o, 'hidden', {
        value: 'secret',
        enumerable: false,
        writable: true,
        configurable: true,
      });
      o;
    `);

    // keys() only returns enumerable
    expect(obj.keys()).toEqual(['visible']);

    // getOwnPropertyNames() returns all
    const allNames = obj.getOwnPropertyNames();
    expect(allNames).toContain('visible');
    expect(allNames).toContain('hidden');

    // Can still access the non-enumerable property
    using hidden = obj.getProp('hidden');
    expect(hidden.toString()).toBe('secret');

    // propertyIsEnumerable distinguishes them
    expect(obj.propertyIsEnumerable('visible')).toBe(true);
    expect(obj.propertyIsEnumerable('hidden')).toBe(false);

    // hasOwnProperty returns true for both
    expect(obj.hasOwnProperty('visible')).toBe(true);
    expect(obj.hasOwnProperty('hidden')).toBe(true);
  });
});
