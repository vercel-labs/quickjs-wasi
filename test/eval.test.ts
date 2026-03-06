import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('evalCode', () => {
  it('should evaluate arithmetic', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using result = vm.evalCode('1 + 2');
    expect(result.isException).toBe(false);
    expect(result.toNumber()).toBe(3);
  });

  it('should evaluate string concatenation', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using result = vm.evalCode('"hello" + " " + "world"');
    expect(result.toString()).toBe('hello world');
  });
});

describe('unwrapResult', () => {
  it('should return the handle on success', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using result = vm.unwrapResult(vm.evalCode('42'));
    expect(result.toNumber()).toBe(42);
  });

  it('should throw on exception', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(() => {
      vm.unwrapResult(vm.evalCode('throw new Error("boom")'));
    }).toThrow('boom');
  });

  it('should throw with error name and message preserved', async () => {
    using vm = await QuickJS.create(wasmBytes);
    try {
      vm.unwrapResult(vm.evalCode('throw new TypeError("bad type")'));
      expect.unreachable();
    } catch (err: any) {
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('TypeError');
      expect(err.message).toBe('bad type');
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
