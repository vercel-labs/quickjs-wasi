import { describe, it, expect } from 'vitest';
import { QuickJS, JSException, EvalFlags } from '../src/index.ts';
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

describe('EvalFlags', () => {
  it('should export correct flag values', () => {
    expect(EvalFlags.TYPE_GLOBAL).toBe(0);
    expect(EvalFlags.TYPE_MODULE).toBe(1);
    expect(EvalFlags.STRICT).toBe(8);
    expect(EvalFlags.COMPILE_ONLY).toBe(32);
    expect(EvalFlags.BACKTRACE_BARRIER).toBe(64);
    expect(EvalFlags.ASYNC).toBe(128);
  });

  it('should allow bitwise OR of flags', () => {
    const combined = EvalFlags.STRICT | EvalFlags.BACKTRACE_BARRIER;
    expect(combined).toBe(72);
  });
});

describe('EvalFlags.TYPE_GLOBAL', () => {
  it('should be the default eval mode', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using result = vm.evalCode('1 + 2', '<eval>', EvalFlags.TYPE_GLOBAL);
    expect(result.toNumber()).toBe(3);
  });

  it('should place var declarations on globalThis', async () => {
    using vm = await QuickJS.create(wasmBytes);
    vm.evalCode('var x = 42').dispose();
    using result = vm.evalCode('x');
    expect(result.toNumber()).toBe(42);
  });

  it('should allow sloppy mode by default', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using result = vm.evalCode('with ({a: 1}) { a }');
    expect(result.toNumber()).toBe(1);
  });
});

describe('EvalFlags.TYPE_MODULE', () => {
  it('should evaluate code in module mode', async () => {
    using vm = await QuickJS.create(wasmBytes);
    // Module eval returns an empty object (the module namespace)
    using result = vm.evalCode('export const x = 42;', '<eval>', EvalFlags.TYPE_MODULE);
    expect(vm.typeof(result)).toBe('object');
  });

  it('should scope variables to the module (not globalThis)', async () => {
    using vm = await QuickJS.create(wasmBytes);
    vm.evalCode('var moduleScoped = 99', '<eval>', EvalFlags.TYPE_MODULE);
    using result = vm.evalCode('typeof moduleScoped');
    expect(result.toString()).toBe('undefined');
  });

  it('should enforce strict mode (disallow with statement)', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(() => {
      vm.evalCode('with ({}) {}', '<eval>', EvalFlags.TYPE_MODULE);
    }).toThrow();
  });

  it('should make import.meta available', async () => {
    const vm = await QuickJS.create(wasmBytes);
    // Module eval doesn't return the last expression value — use globalThis
    const result = vm.evalCode(
      'globalThis.__metaType = typeof import.meta',
      '<eval>',
      EvalFlags.TYPE_MODULE,
    );
    vm.executePendingJobs();
    const resolved = await vm.resolvePromise(result);
    result.dispose();
    if ('value' in resolved) resolved.value.dispose();
    if ('error' in resolved) resolved.error.dispose();

    using check = vm.evalCode('globalThis.__metaType');
    expect(check.toString()).toBe('object');
    vm.dispose();
  });
});

describe('EvalFlags.STRICT', () => {
  it('should reject assignment to undeclared variables', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(() => {
      vm.evalCode('undeclared = 42', '<eval>', EvalFlags.STRICT);
    }).toThrow('is not defined');
  });

  it('should reject the with statement', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(() => {
      vm.evalCode('with ({}) {}', '<eval>', EvalFlags.STRICT);
    }).toThrow();
  });

  it('should still allow valid strict-mode code', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using result = vm.evalCode('"use strict"; const x = 10; x * 2', '<eval>', EvalFlags.STRICT);
    expect(result.toNumber()).toBe(20);
  });

  it('should be combinable with TYPE_GLOBAL', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(() => {
      vm.evalCode('x = 1', '<eval>', EvalFlags.TYPE_GLOBAL | EvalFlags.STRICT);
    }).toThrow('is not defined');
  });
});

describe('EvalFlags.COMPILE_ONLY', () => {
  it('should return bytecode without executing', async () => {
    using vm = await QuickJS.create(wasmBytes);
    // With COMPILE_ONLY, the code is compiled but not executed
    using result = vm.evalCode('1 + 2', '<eval>', EvalFlags.COMPILE_ONLY);
    // The result should not be the number 3 — it's a bytecode object
    expect(vm.typeof(result)).not.toBe('number');
  });

  it('should not execute side effects', async () => {
    using vm = await QuickJS.create(wasmBytes);
    vm.evalCode('globalThis.sideEffect = false').dispose();
    vm.evalCode('globalThis.sideEffect = true', '<eval>', EvalFlags.COMPILE_ONLY).dispose();
    using check = vm.evalCode('globalThis.sideEffect');
    expect(vm.dump(check)).toBe(false);
  });

  it('should reject syntactically invalid code', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(() => {
      vm.evalCode('function {{{', '<eval>', EvalFlags.COMPILE_ONLY);
    }).toThrow();
  });
});

describe('EvalFlags.BACKTRACE_BARRIER', () => {
  it('should omit outer stack frames from error backtraces', async () => {
    const vm = await QuickJS.create(wasmBytes);

    // Create a host function that evals with the barrier flag
    const fn = vm.newFunction('innerEvalBarrier', function (codeHandle) {
      const code = vm.dump(codeHandle) as string;
      return vm.evalCode(code, 'inner.js', EvalFlags.BACKTRACE_BARRIER);
    });
    vm.setProp(vm.global, 'innerEvalBarrier', fn);
    fn.dispose();

    try {
      vm.evalCode(`
        function foo() { innerEvalBarrier('throw new Error("test")'); }
        foo();
      `, 'outer.js');
      expect.unreachable();
    } catch (e: any) {
      const dumped = vm.dump(e.handle) as Error;
      // With barrier: stack should only show inner.js, not outer.js
      expect(dumped.stack).toContain('inner.js');
      expect(dumped.stack).not.toContain('outer.js');
      e.handle.dispose();
    }
    vm.dispose();
  });

  it('should include outer frames without the barrier', async () => {
    const vm = await QuickJS.create(wasmBytes);

    const fn = vm.newFunction('innerEval', function (codeHandle) {
      const code = vm.dump(codeHandle) as string;
      return vm.evalCode(code, 'inner.js');
    });
    vm.setProp(vm.global, 'innerEval', fn);
    fn.dispose();

    try {
      vm.evalCode(`
        function foo() { innerEval('throw new Error("test")'); }
        foo();
      `, 'outer.js');
      expect.unreachable();
    } catch (e: any) {
      const dumped = vm.dump(e.handle) as Error;
      // Without barrier: stack should show both inner.js and outer.js
      expect(dumped.stack).toContain('inner.js');
      expect(dumped.stack).toContain('outer.js');
      e.handle.dispose();
    }
    vm.dispose();
  });
});

describe('EvalFlags.ASYNC', () => {
  /**
   * Helper: evaluate code with ASYNC flag, resolve the promise, and
   * unwrap the completion record `{ value: <actual> }` that QuickJS
   * returns for async eval results.
   */
  async function evalAsync(vm: QuickJS, code: string) {
    const result = vm.evalCode(code, '<eval>', EvalFlags.ASYNC);
    vm.executePendingJobs();
    const resolved = await vm.resolvePromise(result);
    result.dispose();
    vm.executePendingJobs();
    return resolved;
  }

  it('should return a promise handle', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const result = vm.evalCode('1 + 2', '<eval>', EvalFlags.ASYNC);
    expect(result.promiseState).toBeDefined();
    result.dispose();
    vm.dispose();
  });

  it('should resolve top-level awaited value', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const resolved = await evalAsync(vm, 'await Promise.resolve(42)');
    expect('value' in resolved).toBe(true);
    if ('value' in resolved) {
      // ASYNC wraps the completion value in { value: <actual> }
      using inner = resolved.value.getProp('value');
      expect(inner.toNumber()).toBe(42);
      resolved.value.dispose();
    }
    vm.dispose();
  });

  it('should preserve last expression value with top-level await', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const code = `
      const x = await Promise.resolve(10);
      const y = await Promise.resolve(20);
      x + y;
    `;
    const resolved = await evalAsync(vm, code);
    expect('value' in resolved).toBe(true);
    if ('value' in resolved) {
      using inner = resolved.value.getProp('value');
      expect(inner.toNumber()).toBe(30);
      resolved.value.dispose();
    }
    vm.dispose();
  });

  it('should work with non-async code', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const resolved = await evalAsync(vm, '1 + 2');
    expect('value' in resolved).toBe(true);
    if ('value' in resolved) {
      using inner = resolved.value.getProp('value');
      expect(inner.toNumber()).toBe(3);
      resolved.value.dispose();
    }
    vm.dispose();
  });

  it('should propagate rejection from awaited promise', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const resolved = await evalAsync(vm, "await Promise.reject(new Error('async fail'))");
    expect('error' in resolved).toBe(true);
    if ('error' in resolved) {
      const dumped = vm.dump(resolved.error);
      expect(dumped).toBeInstanceOf(Error);
      expect((dumped as Error).message).toBe('async fail');
      resolved.error.dispose();
    }
    vm.dispose();
  });

  it('should resolve chained async operations', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const code = `
      async function fetchData() {
        const a = await Promise.resolve('hello');
        const b = await Promise.resolve(' world');
        return a + b;
      }
      await fetchData();
    `;
    const resolved = await evalAsync(vm, code);
    expect('value' in resolved).toBe(true);
    if ('value' in resolved) {
      using inner = resolved.value.getProp('value');
      expect(vm.dump(inner)).toBe('hello world');
      resolved.value.dispose();
    }
    vm.dispose();
  });

  it('should execute side effects during await', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const logs: string[] = [];
    const logFn = vm.newFunction('log', function (...args) {
      logs.push(args.map(a => vm.dump(a)).join(' '));
      return vm.undefined;
    });
    const consoleObj = vm.newObject();
    consoleObj.setProp('log', logFn);
    vm.setProp(vm.global, 'console', consoleObj);
    logFn.dispose();
    consoleObj.dispose();

    const code = `
      const val = await Promise.resolve('async value');
      console.log('got:', val);
      val;
    `;
    const resolved = await evalAsync(vm, code);

    expect(logs).toEqual(['got: async value']);
    expect('value' in resolved).toBe(true);
    if ('value' in resolved) {
      using inner = resolved.value.getProp('value');
      expect(vm.dump(inner)).toBe('async value');
      resolved.value.dispose();
    }
    vm.dispose();
  });

  it('should handle async/await with try/catch', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const code = `
      let result;
      try {
        await Promise.reject(new Error('caught'));
      } catch (e) {
        result = 'caught: ' + e.message;
      }
      result;
    `;
    const resolved = await evalAsync(vm, code);
    expect('value' in resolved).toBe(true);
    if ('value' in resolved) {
      using inner = resolved.value.getProp('value');
      expect(vm.dump(inner)).toBe('caught: caught');
      resolved.value.dispose();
    }
    vm.dispose();
  });

  it('should be combinable with STRICT flag', async () => {
    const vm = await QuickJS.create(wasmBytes);
    // With ASYNC, the strict mode error surfaces as a rejected promise
    const result = vm.evalCode('undeclared = 1', '<eval>', EvalFlags.ASYNC | EvalFlags.STRICT);
    vm.executePendingJobs();
    const resolved = await vm.resolvePromise(result);
    result.dispose();
    expect('error' in resolved).toBe(true);
    if ('error' in resolved) {
      const dumped = vm.dump(resolved.error);
      expect(dumped).toBeInstanceOf(Error);
      expect((dumped as Error).message).toContain('is not defined');
      resolved.error.dispose();
    }
    vm.dispose();
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
