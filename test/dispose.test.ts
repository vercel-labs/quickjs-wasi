import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('handle.consume()', () => {
  it('should use-then-dispose a handle', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.evalCode('1 + 2').consume(h => h.toNumber())).toBe(3);
  });
});

describe('Symbol.dispose', () => {
  it('should auto-dispose JSValueHandle with using', async () => {
    using vm = await QuickJS.create(wasmBytes);
    {
      using result = vm.evalCode('1 + 2');
      expect(result.toNumber()).toBe(3);
    }
    using result2 = vm.evalCode('3 + 4');
    expect(result2.toNumber()).toBe(7);
  });

  it('should auto-dispose QuickJS VM with using', async () => {
    let leaked: QuickJS;
    {
      using vm = await QuickJS.create(wasmBytes);
      leaked = vm;
      using result = vm.evalCode('"alive"');
      expect(result.toString()).toBe('alive');
    }
    expect(() => leaked.evalCode('1')).toThrow('disposed');
  });

  it('should work with multiple handles in sequence', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      using handle = vm.evalCode(`${i} * ${i}`);
      results.push(handle.toNumber());
    }
    expect(results).toEqual([0, 1, 4, 9, 16]);
  });
});
