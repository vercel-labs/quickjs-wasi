import { describe, it, expect } from 'vitest';
import { QuickJS, EvalFlags } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('moduleLoader', () => {
  it('should load a simple module via import', async () => {
    const modules = new Map<string, string>([
      ['math.js', 'export const add = (a, b) => a + b;'],
    ]);

    using vm = await QuickJS.create({
      wasm: wasmBytes,
      moduleLoader: {
        load: (name) => {
          const src = modules.get(name);
          if (!src) throw new Error(`Module not found: ${name}`);
          return src;
        },
      },
    });

    vm.evalCode(`
      import { add } from 'math.js';
      globalThis.result = add(3, 4);
    `, '<entry>', EvalFlags.TYPE_MODULE).dispose();
    vm.executePendingJobs();

    expect(vm.evalCode('result').consume(h => h.toNumber())).toBe(7);
  });

  it('should support the normalize callback', async () => {
    const modules = new Map<string, string>([
      ['/app/lib/utils.js', 'export const greet = (n) => "Hello, " + n;'],
    ]);

    using vm = await QuickJS.create({
      wasm: wasmBytes,
      moduleLoader: {
        normalize: (baseName, specifier) => {
          if (specifier.startsWith('./')) {
            const baseDir = baseName.substring(0, baseName.lastIndexOf('/') + 1);
            return baseDir + specifier.substring(2);
          }
          return specifier;
        },
        load: (name) => {
          const src = modules.get(name);
          if (!src) throw new Error(`Module not found: ${name}`);
          return src;
        },
      },
    });

    vm.evalCode(`
      import { greet } from './lib/utils.js';
      globalThis.greeting = greet("World");
    `, '/app/main.js', EvalFlags.TYPE_MODULE).dispose();
    vm.executePendingJobs();

    expect(vm.evalCode('greeting').consume(h => h.toString())).toBe('Hello, World');
  });

  it('should support transitive imports', async () => {
    const modules = new Map<string, string>([
      ['a.js', 'import { b } from "b.js"; export const a = "a+" + b;'],
      ['b.js', 'import { c } from "c.js"; export const b = "b+" + c;'],
      ['c.js', 'export const c = "c";'],
    ]);

    using vm = await QuickJS.create({
      wasm: wasmBytes,
      moduleLoader: {
        load: (name) => {
          const src = modules.get(name);
          if (!src) throw new Error(`Module not found: ${name}`);
          return src;
        },
      },
    });

    vm.evalCode(`
      import { a } from 'a.js';
      globalThis.chain = a;
    `, '<entry>', EvalFlags.TYPE_MODULE).dispose();
    vm.executePendingJobs();

    expect(vm.evalCode('chain').consume(h => h.toString())).toBe('a+b+c');
  });

  it('should expose entry module exports via the returned promise', async () => {
    const modules = new Map<string, string>([
      ['math.js', 'export const add = (a, b) => a + b;'],
    ]);

    using vm = await QuickJS.create({
      wasm: wasmBytes,
      moduleLoader: {
        load: (name) => {
          const src = modules.get(name);
          if (!src) throw new Error(`Module not found: ${name}`);
          return src;
        },
      },
    });

    using promise = vm.evalCode(`
      import { add } from 'math.js';
      export const sum = add(3, 4);
      export default 'entry';
    `, '<entry>', EvalFlags.TYPE_MODULE);
    vm.executePendingJobs();

    const resolved = await vm.resolvePromise(promise);
    if ('error' in resolved) {
      resolved.error.dispose();
      expect.unreachable('module evaluation should not reject');
    }
    using ns = resolved.value;
    expect(ns.getProp('sum').consume(h => h.toNumber())).toBe(7);
    expect(ns.getProp('default').consume(h => h.toString())).toBe('entry');
  });

  it('should support dynamic import() from script mode', async () => {
    const modules = new Map<string, string>([
      ['math.js', 'export const add = (a, b) => a + b;'],
    ]);

    using vm = await QuickJS.create({
      wasm: wasmBytes,
      moduleLoader: {
        load: (name) => {
          const src = modules.get(name);
          if (!src) throw new Error(`Module not found: ${name}`);
          return src;
        },
      },
    });

    using promise = vm.evalCode(`import('math.js').then(m => m.add(1, 2))`);
    vm.executePendingJobs();
    const resolved = await vm.resolvePromise(promise);
    if ('error' in resolved) {
      resolved.error.dispose();
      expect.unreachable('dynamic import should not reject');
    }
    expect(resolved.value.consume(h => h.toNumber())).toBe(3);
  });

  it('should throw on module not found', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      moduleLoader: {
        load: (name) => {
          throw new Error(`Not found: ${name}`);
        },
      },
    });

    expect(() => {
      vm.evalCode(`import { x } from 'missing.js'`, '<entry>', EvalFlags.TYPE_MODULE).dispose();
    }).toThrow();
  });

  it('should support default exports', async () => {
    const modules = new Map<string, string>([
      ['config.js', 'export default { port: 3000, host: "localhost" };'],
    ]);

    using vm = await QuickJS.create({
      wasm: wasmBytes,
      moduleLoader: {
        load: (name) => {
          const src = modules.get(name);
          if (!src) throw new Error(`Module not found: ${name}`);
          return src;
        },
      },
    });

    vm.evalCode(`
      import config from 'config.js';
      globalThis.port = config.port;
      globalThis.host = config.host;
    `, '<entry>', EvalFlags.TYPE_MODULE).dispose();
    vm.executePendingJobs();

    expect(vm.evalCode('port').consume(h => h.toNumber())).toBe(3000);
    expect(vm.evalCode('host').consume(h => h.toString())).toBe('localhost');
  });

  it('should support export * from', async () => {
    const modules = new Map<string, string>([
      ['reexport.js', 'export * from "base.js";'],
      ['base.js', 'export const x = 1; export const y = 2;'],
    ]);

    using vm = await QuickJS.create({
      wasm: wasmBytes,
      moduleLoader: {
        load: (name) => {
          const src = modules.get(name);
          if (!src) throw new Error(`Module not found: ${name}`);
          return src;
        },
      },
    });

    vm.evalCode(`
      import { x, y } from 'reexport.js';
      globalThis.sum = x + y;
    `, '<entry>', EvalFlags.TYPE_MODULE).dispose();
    vm.executePendingJobs();

    expect(vm.evalCode('sum').consume(h => h.toNumber())).toBe(3);
  });

  it('should work without a normalize handler (pass-through)', async () => {
    const modules = new Map<string, string>([
      ['foo', 'export const foo = 42;'],
    ]);

    using vm = await QuickJS.create({
      wasm: wasmBytes,
      moduleLoader: {
        load: (name) => {
          const src = modules.get(name);
          if (!src) throw new Error(`Module not found: ${name}`);
          return src;
        },
      },
    });

    vm.evalCode(`
      import { foo } from 'foo';
      globalThis.val = foo;
    `, '<entry>', EvalFlags.TYPE_MODULE).dispose();
    vm.executePendingJobs();

    expect(vm.evalCode('val').consume(h => h.toNumber())).toBe(42);
  });

  it('should propagate the host error message from load()', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      moduleLoader: {
        load: (name) => {
          throw new Error(`Module not found: ${name}`);
        },
      },
    });

    expect(() => {
      vm.evalCode(`import { x } from 'missing.js'`, '<entry>', EvalFlags.TYPE_MODULE).dispose();
    }).toThrow('Module not found: missing.js');
  });

  it('should throw a clear error when load() is async', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      moduleLoader: {
        // @ts-expect-error — deliberately wrong: load must be synchronous
        load: async () => 'export const x = 42;',
      },
    });

    expect(() => {
      vm.evalCode(`import { x } from 'math.js'`, '<entry>', EvalFlags.TYPE_MODULE).dispose();
    }).toThrow('moduleLoader.load must synchronously return a string (got a Promise)');
  });

  it('should throw a clear error when normalize() is async', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      moduleLoader: {
        // @ts-expect-error — deliberately wrong: normalize must be synchronous
        normalize: async (_base: string, specifier: string) => specifier,
        load: () => 'export const x = 42;',
      },
    });

    expect(() => {
      vm.evalCode(`import { x } from 'math.js'`, '<entry>', EvalFlags.TYPE_MODULE).dispose();
    }).toThrow('moduleLoader.normalize must synchronously return a string (got a Promise)');
  });

  it('should support async module sources via fetch-and-retry', async () => {
    // Simulated remote (e.g. https://) module registry with nested imports
    const remote = new Map<string, string>([
      ['a.js', 'import { b } from "b.js"; export const a = "a+" + b;'],
      ['b.js', 'import { c } from "c.js"; export const b = "b+" + c;'],
      ['c.js', 'export const c = "c";'],
    ]);
    const fetchModule = async (name: string): Promise<string> => {
      await new Promise((r) => setTimeout(r, 1)); // simulate network latency
      const src = remote.get(name);
      if (src === undefined) throw new Error(`404: ${name}`);
      return src;
    };

    const cache = new Map<string, string>();
    let missing: string | null = null;

    using vm = await QuickJS.create({
      wasm: wasmBytes,
      moduleLoader: {
        load: (name) => {
          const src = cache.get(name);
          if (src === undefined) {
            missing = name;
            throw new Error(`module not cached: ${name}`);
          }
          return src;
        },
      },
    });

    // Retry eval until all (transitive) module sources are cached. Each
    // attempt gets one module deeper into the dependency graph; modules
    // already loaded by the runtime are not re-requested.
    const evalModule = async (code: string, filename: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        missing = null;
        try {
          return vm.evalCode(code, filename, EvalFlags.TYPE_MODULE);
        } catch (err) {
          if (missing === null) throw err;
          cache.set(missing, await fetchModule(missing));
        }
      }
      throw new Error('too many retries');
    };

    using promise = await evalModule(
      'import { a } from "a.js"; export const chain = a;',
      '<entry>',
    );
    vm.executePendingJobs();
    const resolved = await vm.resolvePromise(promise);
    if ('error' in resolved) {
      const msg = resolved.error.toString();
      resolved.error.dispose();
      expect.unreachable(`module evaluation should not reject: ${msg}`);
    }
    using ns = resolved.value;
    expect(ns.getProp('chain').consume(h => h.toString())).toBe('a+b+c');
  });

  it('should work after snapshot restore', async () => {
    const modules = new Map<string, string>([
      ['data.js', 'export const data = [1, 2, 3];'],
    ]);

    const makeLoader = () => ({
      load: (name: string) => {
        const src = modules.get(name);
        if (!src) throw new Error(`Module not found: ${name}`);
        return src;
      },
    });

    // Create VM with module, snapshot it
    const vm1 = await QuickJS.create({
      wasm: wasmBytes,
      moduleLoader: makeLoader(),
    });
    vm1.evalCode(`
      import { data } from 'data.js';
      globalThis.imported = data.length;
    `, '<entry>', EvalFlags.TYPE_MODULE).dispose();
    vm1.executePendingJobs();
    const snapshot = vm1.snapshot();
    vm1.dispose();

    // Restore — must provide moduleLoader again for future imports
    using vm2 = await QuickJS.restore(snapshot, {
      wasm: wasmBytes,
      moduleLoader: makeLoader(),
    });

    // Data from the imported module should have survived the snapshot
    expect(vm2.evalCode('imported').consume(h => h.toNumber())).toBe(3);
  });
});
