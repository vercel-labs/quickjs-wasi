import { describe, it, expect } from 'vitest';
import { QuickJS, EvalFlags, CompileFlags } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('vm.compile() / vm.evalBytecode()', () => {
  it('should compile a simple expression to bytecode', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const bytecode = vm.compile('1 + 2');
    expect(bytecode).toBeInstanceOf(Uint8Array);
    expect(bytecode.length).toBeGreaterThan(0);
  });

  it('should round-trip a simple expression', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const bytecode = vm.compile('1 + 2');
    const result = vm.evalBytecode(bytecode).consume(h => h.toNumber());
    expect(result).toBe(3);
  });

  it('should round-trip a string expression', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const bytecode = vm.compile('"hello" + " " + "world"');
    const result = vm.evalBytecode(bytecode).consume(h => h.toString());
    expect(result).toBe('hello world');
  });

  it('should compile and execute code with side effects', async () => {
    using vm = await QuickJS.create(wasmBytes);
    // Compilation should NOT execute the code
    const bytecode = vm.compile('globalThis.compiled = true; 42');
    expect(vm.evalCode('typeof globalThis.compiled').consume(h => h.toString())).toBe('undefined');

    // evalBytecode should execute it
    const result = vm.evalBytecode(bytecode).consume(h => h.toNumber());
    expect(result).toBe(42);
    expect(vm.evalCode('globalThis.compiled').consume(h => h.toString())).toBe('true');
  });

  it('should compile a function definition', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const bytecode = vm.compile('globalThis.add = (a, b) => a + b');
    vm.evalBytecode(bytecode).dispose();
    const result = vm.evalCode('add(3, 4)').consume(h => h.toNumber());
    expect(result).toBe(7);
  });

  it('should transfer bytecode between VMs', async () => {
    let bytecode: Uint8Array;
    {
      using vm1 = await QuickJS.create(wasmBytes);
      bytecode = vm1.compile('40 + 2');
    }
    {
      using vm2 = await QuickJS.create(wasmBytes);
      const result = vm2.evalBytecode(bytecode).consume(h => h.toNumber());
      expect(result).toBe(42);
    }
  });

  it('should throw on syntax error during compilation', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(() => vm.compile('function {')).toThrow('Compilation error');
  });

  it('should preserve filename from compilation in stack traces', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const bytecode = vm.compile('throw new Error("test")', 'my-script.js');
    try {
      vm.evalBytecode(bytecode).dispose();
      expect.unreachable('should have thrown');
    } catch (e: any) {
      // The error message or stack should reference the filename
      const full = e.message + (e.stack || '');
      expect(full).toContain('my-script.js');
    }
  });

  it('should compile as a module with EvalFlags.TYPE_MODULE', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const bytecode = vm.compile('export const x = 42', 'mod.js', EvalFlags.TYPE_MODULE);
    expect(bytecode).toBeInstanceOf(Uint8Array);
    expect(bytecode.length).toBeGreaterThan(0);
  });

  it('should produce smaller bytecode with STRIP_SOURCE', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const full = vm.compile('function hello() { return "world"; }');
    const stripped = vm.compile('function hello() { return "world"; }', '<compile>', 0, CompileFlags.STRIP_SOURCE);
    expect(stripped.length).toBeLessThanOrEqual(full.length);
  });

  it('should produce smaller bytecode with STRIP_DEBUG', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const full = vm.compile('function hello() { return "world"; }');
    const stripped = vm.compile('function hello() { return "world"; }', '<compile>', 0, CompileFlags.STRIP_DEBUG);
    expect(stripped.length).toBeLessThanOrEqual(full.length);
  });

  it('should produce the smallest bytecode with both strip flags', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const code = `
      function fibonacci(n) {
        if (n <= 1) return n;
        return fibonacci(n - 1) + fibonacci(n - 2);
      }
      globalThis.fib = fibonacci;
    `;
    const full = vm.compile(code);
    const minimal = vm.compile(code, '<compile>', 0, CompileFlags.STRIP_SOURCE | CompileFlags.STRIP_DEBUG);
    expect(minimal.length).toBeLessThanOrEqual(full.length);

    // Still executes correctly
    vm.evalBytecode(minimal).dispose();
    const result = vm.evalCode('fib(10)').consume(h => h.toNumber());
    expect(result).toBe(55);
  });

  it('should throw if VM is disposed', async () => {
    const vm = await QuickJS.create(wasmBytes);
    vm.dispose();
    expect(() => vm.compile('1')).toThrow();
    expect(() => vm.evalBytecode(new Uint8Array([0]))).toThrow();
  });
});
