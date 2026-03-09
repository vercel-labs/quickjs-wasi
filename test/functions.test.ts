import { describe, it, expect } from 'vitest';
import { QuickJS, JSException } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('host callbacks', () => {
  it('should call a sync host function that adds numbers', async () => {
    using vm = await QuickJS.create(wasmBytes);
    {
      using addFn = vm.newFunction('add', (...args) => {
        return vm.newNumber(args[0].toNumber() + args[1].toNumber());
      });
      vm.setProp(vm.global, 'add', addFn);
    }

    using result = vm.evalCode('add(3, 4)');
    expect(result.toNumber()).toBe(7);
  });

  it('should call a host function that returns a string', async () => {
    using vm = await QuickJS.create(wasmBytes);
    {
      using greetFn = vm.newFunction('greet', (...args) => {
        return vm.newString(`Hello, ${args[0].toString()}!`);
      });
      vm.setProp(vm.global, 'greet', greetFn);
    }

    expect(vm.evalCode('greet("World")').consume(h => h.toString())).toBe('Hello, World!');
  });

  it('should call a host function multiple times', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const calls: string[] = [];
    {
      using logFn = vm.newFunction('log', (...args) => {
        calls.push(args[0].toString());
        return vm.undefined;
      });
      vm.setProp(vm.global, 'log', logFn);
    }

    vm.evalCode('log("first"); log("second"); log("third")').dispose();
    expect(calls).toEqual(['first', 'second', 'third']);
  });
});

describe('host callback this binding', () => {
  it('should receive the correct this value when called as a method', async () => {
    using vm = await QuickJS.create(wasmBytes);
    {
      // Use a regular function (not arrow) to access `this`
      using getName = vm.newFunction('getName', function () {
        return this.getProp('name');
      });
      vm.setProp(vm.global, 'getName', getName);
    }

    vm.evalCode(`
      globalThis.obj = { name: "alice", getName };
    `).dispose();

    using result = vm.evalCode('obj.getName()');
    expect(result.toString()).toBe('alice');
  });

  it('should receive globalThis as this when called as a free function', async () => {
    using vm = await QuickJS.create(wasmBytes);
    {
      using checkThis = vm.newFunction('checkThis', function () {
        // When called as a free function, `this` should be globalThis
        using hasEval = this.getProp('eval');
        return hasEval.isUndefined ? vm.false : vm.true;
      });
      vm.setProp(vm.global, 'checkThis', checkThis);
    }

    // Free function call — `this` is globalThis (which has `eval`)
    expect(vm.dump(vm.evalCode('checkThis()'))).toBe(true);
  });
});

describe('host callback error propagation', () => {
  it('should throw JSException when a host function throws', async () => {
    using vm = await QuickJS.create(wasmBytes);
    {
      using fn = vm.newFunction('throwError', () => {
        throw new Error('host error');
      });
      vm.setProp(vm.global, 'throwError', fn);
    }

    expect(() => vm.evalCode('throwError()')).toThrow('host error');
  });

  it('should be catchable in a try/catch inside the guest VM', async () => {
    using vm = await QuickJS.create(wasmBytes);
    {
      using fn = vm.newFunction('mayFail', (...args) => {
        if (args[0].toNumber() < 0) {
          throw new RangeError('must be non-negative');
        }
        return vm.newNumber(args[0].toNumber() * 2);
      });
      vm.setProp(vm.global, 'mayFail', fn);
    }

    // Successful call — returns a normal value
    expect(vm.evalCode('mayFail(5)').consume(h => h.toNumber())).toBe(10);

    // Failed call — the guest catches it in JS, so evalCode returns a normal value
    using result = vm.evalCode(`
      try { mayFail(-1) } catch(e) { e.message }
    `);
    expect(result.toString()).toBe('must be non-negative');
  });

  it('should allow the VM to continue after a caught host error', async () => {
    using vm = await QuickJS.create(wasmBytes);
    {
      using fn = vm.newFunction('boom', () => {
        throw new Error('boom');
      });
      vm.setProp(vm.global, 'boom', fn);
    }

    // Uncaught on host side — throws JSException
    try {
      vm.evalCode('boom()');
    } catch (err) {
      (err as JSException).dispose();
    }

    // VM is still usable
    expect(vm.evalCode('1 + 2').consume(h => h.toNumber())).toBe(3);
  });
});

describe('JSException', () => {
  it('should be an instance of Error', async () => {
    using vm = await QuickJS.create(wasmBytes);

    try {
      vm.evalCode('throw new TypeError("bad")');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(JSException);
      (err as JSException).dispose();
      return;
    }
    expect.unreachable('should have thrown');
  });

  it('should have the correct name, message, and stack from QuickJS', async () => {
    using vm = await QuickJS.create(wasmBytes);

    try {
      vm.evalCode('throw new RangeError("out of bounds")', 'test.js');
    } catch (err) {
      const exc = err as JSException;
      expect(exc.name).toBe('RangeError');
      expect(exc.message).toBe('out of bounds');
      expect(exc.stack).toContain('test.js');
      exc.dispose();
      return;
    }
    expect.unreachable('should have thrown');
  });

  it('should provide a live handle to the QuickJS error', async () => {
    using vm = await QuickJS.create(wasmBytes);

    try {
      vm.evalCode(`
        const e = new Error("test");
        e.code = 42;
        e.details = { reason: "validation" };
        throw e;
      `);
    } catch (err) {
      const exc = err as JSException;
      // Read custom properties via the handle
      expect(exc.handle.getProp('code').consume(h => h.toNumber())).toBe(42);
      using details = exc.handle.getProp('details');
      expect(details.getProp('reason').consume(h => h.toString())).toBe('validation');
      exc.dispose();
      return;
    }
    expect.unreachable('should have thrown');
  });

  it('should handle non-Error throws (e.g. throw "string")', async () => {
    using vm = await QuickJS.create(wasmBytes);

    try {
      vm.evalCode('throw "oops"');
    } catch (err) {
      const exc = err as JSException;
      expect(exc).toBeInstanceOf(JSException);
      expect(exc.message).toBe('oops');
      exc.dispose();
      return;
    }
    expect.unreachable('should have thrown');
  });

  it('should handle thrown numbers', async () => {
    using vm = await QuickJS.create(wasmBytes);

    try {
      vm.evalCode('throw 404');
    } catch (err) {
      const exc = err as JSException;
      expect(exc).toBeInstanceOf(JSException);
      expect(exc.message).toBe('404');
      exc.dispose();
      return;
    }
    expect.unreachable('should have thrown');
  });

  it('should handle thrown plain objects without name/message/stack', async () => {
    using vm = await QuickJS.create(wasmBytes);

    try {
      vm.evalCode('throw { code: "ENOENT", path: "/tmp/missing" }');
    } catch (err) {
      const exc = err as JSException;
      expect(exc).toBeInstanceOf(JSException);
      expect(exc).toBeInstanceOf(Error);
      // name/message/stack fall back to defaults since the object has none
      expect(exc.name).toBe('Error');
      expect(exc.message).toBe('[object Object]'); // toString() of a plain object
      // The handle gives access to the actual thrown object's properties
      expect(exc.handle.getProp('code').consume(h => h.toString())).toBe('ENOENT');
      expect(exc.handle.getProp('path').consume(h => h.toString())).toBe('/tmp/missing');
      exc.dispose();
      return;
    }
    expect.unreachable('should have thrown');
  });

  it('should allow reading non-standard error properties via the handle', async () => {
    using vm = await QuickJS.create(wasmBytes);

    try {
      vm.evalCode(`
        class HttpError extends Error {
          constructor(status, body) {
            super('HTTP ' + status);
            this.name = 'HttpError';
            this.status = status;
            this.body = body;
          }
        }
        throw new HttpError(422, { errors: ['field is required'] });
      `);
    } catch (err) {
      const exc = err as JSException;
      // Standard Error properties
      expect(exc.name).toBe('HttpError');
      expect(exc.message).toBe('HTTP 422');

      // Non-standard properties via the handle
      expect(exc.handle.getProp('status').consume(h => h.toNumber())).toBe(422);
      using body = exc.handle.getProp('body');
      using errors = body.getProp('errors');
      expect(errors.getProp('0').consume(h => h.toString())).toBe('field is required');

      exc.dispose();
      return;
    }
    expect.unreachable('should have thrown');
  });

  it('should work with host function errors', async () => {
    using vm = await QuickJS.create(wasmBytes);
    {
      using fn = vm.newFunction('fail', () => {
        throw new TypeError('host side error');
      });
      vm.setProp(vm.global, 'fail', fn);
    }

    try {
      vm.evalCode('fail()');
    } catch (err) {
      const exc = err as JSException;
      expect(exc).toBeInstanceOf(JSException);
      expect(exc.message).toBe('host side error');
      exc.dispose();
      return;
    }
    expect.unreachable('should have thrown');
  });

  it('should be disposable with using declaration', async () => {
    using vm = await QuickJS.create(wasmBytes);

    try {
      vm.evalCode('throw new Error("test")');
    } catch (err) {
      // using declaration auto-disposes the exception
      using exc = err as JSException;
      expect(exc.message).toBe('test');
      return;
    }
    expect.unreachable('should have thrown');
  });

  it('should produce a useful String() representation', async () => {
    using vm = await QuickJS.create(wasmBytes);

    try {
      vm.evalCode('throw new TypeError("bad argument")');
    } catch (err) {
      const str = String(err);
      expect(str).toContain('TypeError');
      expect(str).toContain('bad argument');
      (err as JSException).dispose();
      return;
    }
    expect.unreachable('should have thrown');
  });
});

describe('async host callbacks', () => {
  it('should simulate an async host function with promise bridging', async () => {
    using vm = await QuickJS.create(wasmBytes);
    {
      using dnsResolveFn = vm.newFunction('dnsResolve', (...args) => {
        const hostname = args[0].toString();
        const deferred = vm.newPromise();

        const ip = hostname === 'example.com' ? '93.184.216.34' : '127.0.0.1';
        using ipHandle = vm.newString(ip);
        deferred.resolve(ipHandle);
        vm.executePendingJobs();

        return deferred.handle;
      });
      vm.setProp(vm.global, 'dnsResolve', dnsResolveFn);
    }

    vm.evalCode(`
      globalThis.resolvedIP = "pending";
      dnsResolve("example.com").then(ip => {
        globalThis.resolvedIP = ip;
      });
    `).dispose();
    vm.executePendingJobs();

    expect(vm.global.getProp('resolvedIP').consume(h => h.toString())).toBe('93.184.216.34');
  });
});
