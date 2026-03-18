import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';
import { readFileSync } from 'node:fs';

const scExtBytes = readFileSync(new URL('../extensions/structured-clone/structured-clone.so', import.meta.url));

async function createVM() {
  return QuickJS.create({
    wasm: wasmBytes,
    extensions: [{ name: 'structured-clone', wasm: scExtBytes }],
  });
}

async function evalStr(code: string) {
  using vm = await createVM();
  const result = vm.evalCode(code);
  const str = result.toString();
  result.dispose();
  return str;
}

async function evalJSON(code: string) {
  using vm = await createVM();
  const result = vm.evalCode(`JSON.stringify(${code})`);
  const parsed = JSON.parse(result.toString());
  result.dispose();
  return parsed;
}

describe('structuredClone basics', () => {
  it('should be available as a global function', async () => {
    expect(await evalStr('typeof structuredClone')).toBe('function');
  });

  it('should clone undefined', async () => {
    expect(await evalStr('String(structuredClone(undefined))')).toBe('undefined');
  });

  it('should clone null', async () => {
    expect(await evalStr('String(structuredClone(null))')).toBe('null');
  });

  it('should clone boolean true', async () => {
    expect(await evalStr('String(structuredClone(true))')).toBe('true');
  });

  it('should clone boolean false', async () => {
    expect(await evalStr('String(structuredClone(false))')).toBe('false');
  });

  it('should clone number', async () => {
    expect(await evalStr('String(structuredClone(42))')).toBe('42');
  });

  it('should clone negative zero', async () => {
    expect(await evalStr('String(1 / structuredClone(-0))')).toBe('-Infinity');
  });

  it('should clone NaN', async () => {
    expect(await evalStr('String(structuredClone(NaN))')).toBe('NaN');
  });

  it('should clone Infinity', async () => {
    expect(await evalStr('String(structuredClone(Infinity))')).toBe('Infinity');
  });

  it('should clone string', async () => {
    expect(await evalStr("structuredClone('hello')")).toBe('hello');
  });

  it('should clone empty string', async () => {
    expect(await evalStr("structuredClone('')")).toBe('');
  });

  it('should clone bigint', async () => {
    expect(await evalStr('String(structuredClone(42n))')).toBe('42');
  });
});

describe('structuredClone objects', () => {
  it('should deep clone a plain object', async () => {
    const r = await evalJSON(`
      (() => {
        var obj = { a: 1, b: 'hello' };
        var clone = structuredClone(obj);
        return { equal: clone.a === 1 && clone.b === 'hello', different: clone !== obj };
      })()
    `);
    expect(r.equal).toBe(true);
    expect(r.different).toBe(true);
  });

  it('should deep clone nested objects', async () => {
    const r = await evalJSON(`
      (() => {
        var obj = { a: { b: { c: 42 } } };
        var clone = structuredClone(obj);
        return {
          value: clone.a.b.c,
          diff1: clone.a !== obj.a,
          diff2: clone.a.b !== obj.a.b,
        };
      })()
    `);
    expect(r.value).toBe(42);
    expect(r.diff1).toBe(true);
    expect(r.diff2).toBe(true);
  });
});

describe('structuredClone arrays', () => {
  it('should deep clone arrays', async () => {
    const r = await evalJSON(`
      (() => {
        var arr = [1, 'two', { three: 3 }];
        var clone = structuredClone(arr);
        return {
          len: clone.length,
          v0: clone[0],
          v1: clone[1],
          v2: clone[2].three,
          different: clone !== arr,
          differentObj: clone[2] !== arr[2],
        };
      })()
    `);
    expect(r.len).toBe(3);
    expect(r.v0).toBe(1);
    expect(r.v1).toBe('two');
    expect(r.v2).toBe(3);
    expect(r.different).toBe(true);
    expect(r.differentObj).toBe(true);
  });

  it('should handle sparse arrays', async () => {
    const r = await evalJSON(`
      (() => {
        var arr = [1, , 3];
        var clone = structuredClone(arr);
        return { len: clone.length, has1: 1 in clone, v0: clone[0], v2: clone[2] };
      })()
    `);
    expect(r.len).toBe(3);
    expect(r.has1).toBe(false);
    expect(r.v0).toBe(1);
    expect(r.v2).toBe(3);
  });
});

describe('structuredClone Date', () => {
  it('should clone Date objects', async () => {
    const r = await evalJSON(`
      (() => {
        var d = new Date(1234567890000);
        var clone = structuredClone(d);
        return {
          time: clone.getTime(),
          isDate: clone instanceof Date,
          different: clone !== d,
        };
      })()
    `);
    expect(r.time).toBe(1234567890000);
    expect(r.isDate).toBe(true);
    expect(r.different).toBe(true);
  });
});

describe('structuredClone RegExp', () => {
  it('should clone RegExp objects', async () => {
    const r = await evalJSON(`
      (() => {
        var re = /hello\\s+world/gi;
        var clone = structuredClone(re);
        return {
          source: clone.source,
          flags: clone.flags,
          isRegExp: clone instanceof RegExp,
          different: clone !== re,
        };
      })()
    `);
    expect(r.source).toBe('hello\\s+world');
    expect(r.flags).toBe('gi');
    expect(r.isRegExp).toBe(true);
    expect(r.different).toBe(true);
  });
});

describe('structuredClone Map', () => {
  it('should clone Map objects', async () => {
    const r = await evalJSON(`
      (() => {
        var m = new Map([['a', 1], ['b', { c: 2 }]]);
        var clone = structuredClone(m);
        return {
          isMap: clone instanceof Map,
          size: clone.size,
          a: clone.get('a'),
          bc: clone.get('b').c,
          different: clone !== m,
          differentValue: clone.get('b') !== m.get('b'),
        };
      })()
    `);
    expect(r.isMap).toBe(true);
    expect(r.size).toBe(2);
    expect(r.a).toBe(1);
    expect(r.bc).toBe(2);
    expect(r.different).toBe(true);
    expect(r.differentValue).toBe(true);
  });
});

describe('structuredClone Set', () => {
  it('should clone Set objects', async () => {
    const r = await evalJSON(`
      (() => {
        var s = new Set([1, 'two', 3]);
        var clone = structuredClone(s);
        return {
          isSet: clone instanceof Set,
          size: clone.size,
          has1: clone.has(1),
          hasTwo: clone.has('two'),
          has3: clone.has(3),
          different: clone !== s,
        };
      })()
    `);
    expect(r.isSet).toBe(true);
    expect(r.size).toBe(3);
    expect(r.has1).toBe(true);
    expect(r.hasTwo).toBe(true);
    expect(r.has3).toBe(true);
    expect(r.different).toBe(true);
  });
});

describe('structuredClone Error', () => {
  it('should clone Error objects', async () => {
    const r = await evalJSON(`
      (() => {
        var e = new TypeError('bad type');
        var clone = structuredClone(e);
        return {
          isError: clone instanceof Error,
          isTypeError: clone instanceof TypeError,
          name: clone.constructor.name,
          message: clone.message,
          different: clone !== e,
        };
      })()
    `);
    expect(r.isError).toBe(true);
    expect(r.isTypeError).toBe(true);
    expect(r.name).toBe('TypeError');
    expect(r.message).toBe('bad type');
    expect(r.different).toBe(true);
  });
});

describe('structuredClone ArrayBuffer', () => {
  it('should clone ArrayBuffer', async () => {
    const r = await evalJSON(`
      (() => {
        var ab = new ArrayBuffer(4);
        new Uint8Array(ab).set([1, 2, 3, 4]);
        var clone = structuredClone(ab);
        var cloneView = new Uint8Array(clone);
        return {
          isAB: clone instanceof ArrayBuffer,
          size: clone.byteLength,
          data: Array.from(cloneView),
          different: clone !== ab,
        };
      })()
    `);
    expect(r.isAB).toBe(true);
    expect(r.size).toBe(4);
    expect(r.data).toEqual([1, 2, 3, 4]);
    expect(r.different).toBe(true);
  });
});

describe('structuredClone TypedArray', () => {
  it('should clone Uint8Array', async () => {
    const r = await evalJSON(`
      (() => {
        var arr = new Uint8Array([10, 20, 30]);
        var clone = structuredClone(arr);
        return {
          isU8: clone instanceof Uint8Array,
          len: clone.length,
          data: Array.from(clone),
          different: clone !== arr,
          differentBuffer: clone.buffer !== arr.buffer,
        };
      })()
    `);
    expect(r.isU8).toBe(true);
    expect(r.len).toBe(3);
    expect(r.data).toEqual([10, 20, 30]);
    expect(r.different).toBe(true);
    expect(r.differentBuffer).toBe(true);
  });

  it('should clone Float64Array', async () => {
    const r = await evalJSON(`
      (() => {
        var arr = new Float64Array([1.5, 2.5, 3.5]);
        var clone = structuredClone(arr);
        return {
          isF64: clone instanceof Float64Array,
          data: Array.from(clone),
          different: clone !== arr,
        };
      })()
    `);
    expect(r.isF64).toBe(true);
    expect(r.data).toEqual([1.5, 2.5, 3.5]);
    expect(r.different).toBe(true);
  });
});

describe('structuredClone circular references', () => {
  it('should handle circular object reference', async () => {
    const r = await evalJSON(`
      (() => {
        var obj = { a: 1 };
        obj.self = obj;
        var clone = structuredClone(obj);
        return {
          a: clone.a,
          circular: clone.self === clone,
          differentFromOriginal: clone !== obj,
        };
      })()
    `);
    expect(r.a).toBe(1);
    expect(r.circular).toBe(true);
    expect(r.differentFromOriginal).toBe(true);
  });

  it('should handle mutual circular references', async () => {
    const r = await evalJSON(`
      (() => {
        var a = { name: 'a' };
        var b = { name: 'b' };
        a.ref = b;
        b.ref = a;
        var cloneA = structuredClone(a);
        return {
          nameA: cloneA.name,
          nameB: cloneA.ref.name,
          circular: cloneA.ref.ref === cloneA,
        };
      })()
    `);
    expect(r.nameA).toBe('a');
    expect(r.nameB).toBe('b');
    expect(r.circular).toBe(true);
  });

  it('should handle circular array', async () => {
    const r = await evalJSON(`
      (() => {
        var arr = [1, 2];
        arr.push(arr);
        var clone = structuredClone(arr);
        return {
          len: clone.length,
          v0: clone[0],
          v1: clone[1],
          circular: clone[2] === clone,
        };
      })()
    `);
    expect(r.len).toBe(3);
    expect(r.v0).toBe(1);
    expect(r.v1).toBe(2);
    expect(r.circular).toBe(true);
  });
});

describe('structuredClone non-cloneable types', () => {
  it('should throw for functions', async () => {
    using vm = await createVM();
    expect(() => {
      vm.evalCode('structuredClone(function() {})');
    }).toThrow();
  });

  it('should throw for symbols', async () => {
    using vm = await createVM();
    expect(() => {
      vm.evalCode('structuredClone(Symbol("test"))');
    }).toThrow();
  });

  it('should throw for objects containing functions', async () => {
    using vm = await createVM();
    expect(() => {
      vm.evalCode('structuredClone({ fn: () => {} })');
    }).toThrow();
  });

  it('should throw for Promise', async () => {
    using vm = await createVM();
    expect(() => {
      vm.evalCode('structuredClone(Promise.resolve(1))');
    }).toThrow();
  });
});

describe('structuredClone shared references', () => {
  it('should preserve shared references within the clone', async () => {
    const r = await evalJSON(`
      (() => {
        var shared = { x: 42 };
        var obj = { a: shared, b: shared };
        var clone = structuredClone(obj);
        return {
          sameRef: clone.a === clone.b,
          x: clone.a.x,
          differentFromOriginal: clone.a !== shared,
        };
      })()
    `);
    expect(r.sameRef).toBe(true);
    expect(r.x).toBe(42);
    expect(r.differentFromOriginal).toBe(true);
  });
});
