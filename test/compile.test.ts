/**
 * Tests for the degenerator compile() integration, which compiles JS code into
 * async functions with sandbox support and executes them in the QuickJS VM.
 */

import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';
import { compile } from './compile-helper.ts';

describe('compile()', () => {
  it('should compile and invoke a simple sync function', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const fn = compile<string>(vm, 'function foo() { return "bar"; }', 'foo');
    expect(await fn()).toBe('bar');
  });

  it('should compile a function with sandbox', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const fn = compile<number>(vm, 'function foo() { return add(1, 2); }', 'foo', {
      sandbox: {
        add: (a: number, b: number) => a + b,
      },
    });
    expect(await fn()).toBe(3);
  });

  it('should compile a function with async sandbox function', async () => {
    using vm = await QuickJS.create(wasmBytes);
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
    expect(await fn()).toBe('HELLO');
  });

  it('should pass arguments to the compiled function', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const fn = compile<string, [string, string]>(
      vm,
      'function greet(greeting, name) { return greeting + " " + name; }',
      'greet'
    );
    expect(await fn('hello', 'world')).toBe('hello world');
  });

  it('should throw if return name is not a function', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(() => {
      compile(vm, 'var foo = 1;', 'foo');
    }).toThrow('Expected a "function"');
  });

  it('should throw if sandbox property is not a function', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(() => {
      compile(vm, 'function foo() {}', 'foo', {
        sandbox: { bar: 'not a function' } as any,
      });
    }).toThrow('Expected a "function"');
  });

  it('should prevent sandbox escape - process is not defined', async () => {
    using vm = await QuickJS.create(wasmBytes);
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
    expect(await fn()).toBe('undefined');
  });

  it('should support the filename option in stack traces', async () => {
    using vm = await QuickJS.create(wasmBytes);
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
  });

  it('should return undefined from a noop function', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const fn = compile(vm, 'function foo() {}', 'foo');
    expect(await fn()).toBeUndefined();
  });

  it('should handle returning null', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const fn = compile(vm, 'function foo() { return null; }', 'foo');
    expect(await fn()).toBeNull();
  });
});

describe('compile() with sandbox functions', () => {
  it('should work with sync sandbox functions', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const fn = compile<string, [string, string]>(
      vm,
      `function route(url, host) {
        if (isLocal(host)) return "DIRECT";
        return "PROXY proxy:8080";
      }`,
      'route',
      {
        sandbox: {
          isLocal: (host: string) => !host.includes('.'),
        },
      }
    );

    expect(await fn('http://intranet/', 'intranet')).toBe('DIRECT');
    expect(await fn('http://www.example.com/', 'www.example.com')).toBe('PROXY proxy:8080');
  });

  it('should work with async sandbox functions', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const fn = compile<string, [string, string]>(
      vm,
      `function route(url, host) {
        var ip = lookup(host);
        if (ip === "127.0.0.1") return "DIRECT";
        return "PROXY proxy:8080";
      }`,
      'route',
      {
        names: ['lookup'],
        sandbox: {
          lookup: async (host: string) => {
            if (host === 'localhost') return '127.0.0.1';
            return '10.0.0.1';
          },
        },
      }
    );

    expect(await fn('http://localhost/', 'localhost')).toBe('DIRECT');
    expect(await fn('http://example.com/', 'example.com')).toBe('PROXY proxy:8080');
  });

  it('should work with multiple sandbox functions', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const fn = compile<string, [string, string]>(
      vm,
      `function route(url, host) {
        if (matchDomain(host, ".example.com")) return "PROXY proxy:8080";
        if (matchPattern(host, "*.local")) return "DIRECT";
        return "DIRECT";
      }`,
      'route',
      {
        sandbox: {
          matchDomain: (host: string, domain: string) => {
            return host.length >= domain.length && host.substring(host.length - domain.length) === domain;
          },
          matchPattern: (str: string, pattern: string) => {
            const re = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
            return re.test(str);
          },
        },
      }
    );

    expect(await fn('http://foo.example.com/', 'foo.example.com')).toBe('PROXY proxy:8080');
    expect(await fn('http://server.local/', 'server.local')).toBe('DIRECT');
    expect(await fn('http://other.org/', 'other.org')).toBe('DIRECT');
  });
});
