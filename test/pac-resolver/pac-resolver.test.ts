/**
 * Tests that exercise the pac-resolver / degenerator flow using quickjs-wasm.
 *
 * These mirror the key tests from the pac-resolver test suite.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { QuickJS } from '../../src/index.ts';
import { compile } from './compile.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(__dirname, '..', '..', 'quickjs.wasm');
let wasmBytes: Buffer;

beforeAll(() => {
  wasmBytes = readFileSync(wasmPath);
});

describe('compile()', () => {
  it('should compile and invoke a simple sync function', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const fn = compile<string>(vm, 'function foo() { return "bar"; }', 'foo');
    const result = await fn();
    expect(result).toBe('bar');
    vm.dispose(false);
  });

  it('should compile a function with sandbox', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const fn = compile<number>(vm, 'function foo() { return add(1, 2); }', 'foo', {
      sandbox: {
        add: (a: number, b: number) => a + b,
      },
    });
    const result = await fn();
    expect(result).toBe(3);
    vm.dispose(false);
  });

  it('should compile a function with async sandbox function', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const fn = compile<string>(
      vm,
      'function foo() { return resolve("hello"); }',
      'foo',
      {
        names: ['resolve'],
        sandbox: {
          resolve: async (val: string) => val.toUpperCase(),
        },
      }
    );
    const result = await fn();
    expect(result).toBe('HELLO');
    vm.dispose(false);
  });

  it('should pass arguments to the compiled function', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const fn = compile<string, [string, string]>(
      vm,
      'function greet(greeting, name) { return greeting + " " + name; }',
      'greet'
    );
    const result = await fn('hello', 'world');
    expect(result).toBe('hello world');
    vm.dispose(false);
  });

  it('should throw if return name is not a function', async () => {
    const vm = await QuickJS.create(wasmBytes);
    expect(() => {
      compile(vm, 'var foo = 1;', 'foo');
    }).toThrow('Expected a "function"');
    vm.dispose(false);
  });

  it('should throw if sandbox property is not a function', async () => {
    const vm = await QuickJS.create(wasmBytes);
    expect(() => {
      compile(vm, 'function foo() {}', 'foo', {
        sandbox: { bar: 'not a function' } as any,
      });
    }).toThrow('Expected a "function"');
    vm.dispose(false);
  });

  it('should prevent sandbox escape - process is not defined', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const fn = compile<string>(
      vm,
      `function foo() {
        try {
          return typeof process;
        } catch(e) {
          return e.message;
        }
      }`,
      'foo'
    );
    const result = await fn();
    // In a properly sandboxed environment, process should be undefined
    expect(result).toBe('undefined');
    vm.dispose(false);
  });

  it('should support the filename option in stack traces', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const fn = compile<string>(
      vm,
      `function foo() { return bar(); }`,
      'foo',
      { filename: 'test.pac' }
    );
    try {
      await fn();
      expect.unreachable();
    } catch (err: any) {
      expect(err.stack || err.message).toContain('test.pac');
    }
    vm.dispose(false);
  });

  it('should return undefined from a noop function', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const fn = compile(vm, 'function foo() {}', 'foo');
    const result = await fn();
    expect(result).toBeUndefined();
    vm.dispose(false);
  });

  it('should handle returning null', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const fn = compile(vm, 'function foo() { return null; }', 'foo');
    const result = await fn();
    expect(result).toBeNull();
    vm.dispose(false);
  });
});

describe('PAC-style functions', () => {
  it('should evaluate a simple PAC function', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const FindProxyForURL = compile<string, [string, string]>(
      vm,
      `function FindProxyForURL(url, host) {
        if (host === "example.com") return "PROXY proxy.example.com:8080";
        return "DIRECT";
      }`,
      'FindProxyForURL'
    );

    expect(await FindProxyForURL('http://example.com/', 'example.com')).toBe(
      'PROXY proxy.example.com:8080'
    );
    expect(await FindProxyForURL('http://other.com/', 'other.com')).toBe(
      'DIRECT'
    );
    vm.dispose(false);
  });

  it('should work with isPlainHostName (sync sandbox fn)', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const FindProxyForURL = compile<string, [string, string]>(
      vm,
      `function FindProxyForURL(url, host) {
        if (isPlainHostName(host)) return "DIRECT";
        return "PROXY proxy:8080";
      }`,
      'FindProxyForURL',
      {
        sandbox: {
          isPlainHostName: (host: string) => !host.includes('.'),
        },
      }
    );

    expect(await FindProxyForURL('http://intranet/', 'intranet')).toBe('DIRECT');
    expect(await FindProxyForURL('http://www.example.com/', 'www.example.com')).toBe(
      'PROXY proxy:8080'
    );
    vm.dispose(false);
  });

  it('should work with async dnsResolve sandbox fn', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const FindProxyForURL = compile<string, [string, string]>(
      vm,
      `function FindProxyForURL(url, host) {
        var ip = dnsResolve(host);
        if (ip === "127.0.0.1") return "DIRECT";
        return "PROXY proxy:8080";
      }`,
      'FindProxyForURL',
      {
        names: ['dnsResolve'],
        sandbox: {
          dnsResolve: async (host: string) => {
            if (host === 'localhost') return '127.0.0.1';
            return '10.0.0.1';
          },
        },
      }
    );

    expect(await FindProxyForURL('http://localhost/', 'localhost')).toBe('DIRECT');
    expect(await FindProxyForURL('http://example.com/', 'example.com')).toBe(
      'PROXY proxy:8080'
    );
    vm.dispose(false);
  });

  it('should handle PAC with string matching functions', async () => {
    const vm = await QuickJS.create(wasmBytes);
    const FindProxyForURL = compile<string, [string, string]>(
      vm,
      `function FindProxyForURL(url, host) {
        if (dnsDomainIs(host, ".example.com")) return "PROXY proxy:8080";
        if (shExpMatch(host, "*.local")) return "DIRECT";
        return "DIRECT";
      }`,
      'FindProxyForURL',
      {
        sandbox: {
          dnsDomainIs: (host: string, domain: string) => {
            return host.length >= domain.length && host.substring(host.length - domain.length) === domain;
          },
          shExpMatch: (str: string, pattern: string) => {
            const re = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
            return re.test(str);
          },
        },
      }
    );

    expect(await FindProxyForURL('http://foo.example.com/', 'foo.example.com')).toBe(
      'PROXY proxy:8080'
    );
    expect(await FindProxyForURL('http://server.local/', 'server.local')).toBe('DIRECT');
    expect(await FindProxyForURL('http://other.org/', 'other.org')).toBe('DIRECT');
    vm.dispose(false);
  });
});
