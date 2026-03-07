/**
 * Adapted compile.ts from degenerator, using quickjs-wasi instead of quickjs-emscripten.
 */

import { degenerator } from 'degenerator';
import type { DegeneratorNames } from 'degenerator';
import type { Context } from 'node:vm';
import { QuickJS, type JSValueHandle } from '../src/index.ts';

export interface CompileOptions {
  names?: DegeneratorNames;
  filename?: string;
  sandbox?: Context;
}

export function compile<R = unknown, A extends unknown[] = []>(
  vm: QuickJS,
  code: string,
  returnName: string,
  options: CompileOptions = {}
): (...args: A) => Promise<R> {
  const compiled = degenerator(code, options.names ?? []);

  // Add functions to global
  if (options.sandbox) {
    for (const [name, value] of Object.entries(options.sandbox)) {
      if (typeof value !== 'function') {
        throw new Error(
          `Expected a "function" for sandbox property \`${name}\`, but got "${typeof value}"`
        );
      }
      const fnHandle = vm.newFunction(name, (_this, ...args) => {
        const result = value(
          ...args.map((arg) => vm.dump(arg))
        );
        vm.executePendingJobs();
        return vm.hostToHandle(result);
      });
      fnHandle.consume((handle) => vm.setProp(vm.global, name, handle));
    }
  }

  const fnResult = vm.evalCode(`${compiled};${returnName}`, options.filename);
  const fn = vm.unwrapResult(fnResult);

  const t = vm.typeof(fn);
  if (t !== 'function') {
    throw new Error(
      `Expected a "function" named \`${returnName}\` to be defined, but got "${t}"`
    );
  }

  const r = async function (...args: A): Promise<R> {
    let promiseHandle: JSValueHandle | undefined;
    let resolvedHandle: JSValueHandle | undefined;
    try {
      const result = vm.callFunction(
        fn,
        vm.undefined,
        ...args.map((arg) => vm.hostToHandle(arg))
      );
      promiseHandle = vm.unwrapResult(result);
      const resolvedResultP = vm.resolvePromise(promiseHandle);
      vm.executePendingJobs();
      const resolvedResult = await resolvedResultP;
      if ('error' in resolvedResult) {
        const dumped = vm.dump(resolvedResult.error);
        resolvedResult.error.dispose();
        if (dumped instanceof Error) {
          if (dumped.stack && !dumped.stack.startsWith(dumped.name)) {
            dumped.stack = `${dumped.name}: ${dumped.message}\n${dumped.stack}`;
          }
          throw dumped;
        }
        throw new Error(String(dumped));
      }
      resolvedHandle = resolvedResult.value;
      return vm.dump(resolvedHandle) as R;
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'cause' in err && err.cause) {
        if (
          typeof err.cause === 'object' &&
          'stack' in err.cause &&
          'name' in err.cause &&
          'message' in err.cause &&
          typeof err.cause.stack === 'string' &&
          typeof err.cause.name === 'string' &&
          typeof err.cause.message === 'string'
        ) {
          err.cause.stack = `${err.cause.name}: ${err.cause.message}\n${err.cause.stack}`;
        }
        throw err.cause;
      }
      throw err;
    } finally {
      promiseHandle?.dispose();
      resolvedHandle?.dispose();
    }
  };
  Object.defineProperty(r, 'toString', {
    value: () => compiled,
    enumerable: false,
  });
  return r;
}
