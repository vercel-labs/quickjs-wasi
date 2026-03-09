import { describe, it, expect } from 'vitest';
import { QuickJS, JSException } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('evalCode', () => {
  it('should evaluate arithmetic', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using result = vm.evalCode('1 + 2');
    expect(result.toNumber()).toBe(3);
  });

  it('should evaluate string concatenation', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using result = vm.evalCode('"hello" + " " + "world"');
    expect(result.toString()).toBe('hello world');
  });

  it('should throw JSException on error', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(() => {
      vm.evalCode('throw new Error("boom")');
    }).toThrow('boom');
  });

  it('should throw JSException with error name and message preserved', async () => {
    using vm = await QuickJS.create(wasmBytes);
    try {
      vm.evalCode('throw new TypeError("bad type")');
      expect.unreachable();
    } catch (err: any) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(JSException);
      expect(err.name).toBe('TypeError');
      expect(err.message).toBe('bad type');
      err.dispose();
    }
  });
});

describe('typeof', () => {
  it('should return correct typeof strings', async () => {
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
      expect(vm.evalCode(code).consume(h => vm.typeof(h))).toBe(expected);
    }
  });
});
