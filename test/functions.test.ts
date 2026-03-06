import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('host callbacks', () => {
  it('should call a sync host function that adds numbers', async () => {
    using vm = await QuickJS.create(wasmBytes);
    {
      using addFn = vm.newFunction('add', (_this, ...args) => {
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
      using greetFn = vm.newFunction('greet', (_this, ...args) => {
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
      using logFn = vm.newFunction('log', (_this, ...args) => {
        calls.push(args[0].toString());
        return vm.undefined;
      });
      vm.setProp(vm.global, 'log', logFn);
    }

    vm.unwrapResult(vm.evalCode('log("first"); log("second"); log("third")')).dispose();
    expect(calls).toEqual(['first', 'second', 'third']);
  });
});

describe('async host callbacks', () => {
  it('should simulate an async host function with promise bridging', async () => {
    using vm = await QuickJS.create(wasmBytes);
    {
      using dnsResolveFn = vm.newFunction('dnsResolve', (_this, ...args) => {
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
