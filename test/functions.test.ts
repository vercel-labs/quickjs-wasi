import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
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

    using result = vm.unwrapResult(vm.evalCode('add(3, 4)'));
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

    expect(vm.unwrapResult(vm.evalCode('greet("World")')).consume(h => h.toString())).toBe('Hello, World!');
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

    vm.unwrapResult(vm.evalCode('log("first"); log("second"); log("third")')).dispose();
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

    vm.unwrapResult(vm.evalCode(`
      globalThis.obj = { name: "alice", getName };
    `)).dispose();

    using result = vm.unwrapResult(vm.evalCode('obj.getName()'));
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
    expect(vm.dump(vm.unwrapResult(vm.evalCode('checkThis()')))).toBe(true);
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

    vm.unwrapResult(vm.evalCode(`
      globalThis.resolvedIP = "pending";
      dnsResolve("example.com").then(ip => {
        globalThis.resolvedIP = ip;
      });
    `)).dispose();
    vm.executePendingJobs();

    expect(vm.global.getProp('resolvedIP').consume(h => h.toString())).toBe('93.184.216.34');
  });
});
