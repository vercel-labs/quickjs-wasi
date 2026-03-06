/**
 * Targeted tests to identify what causes GC assertion failures.
 */

import { describe, it } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

// Capture stderr to detect assertions
const originalStderr = process.stderr.write.bind(process.stderr);
let stderrOutput = '';
function captureStderr() {
  stderrOutput = '';
  process.stderr.write = (chunk: any, ...args: any[]) => {
    stderrOutput += String(chunk);
    return originalStderr(chunk, ...args);
  };
}
function restoreStderr() {
  process.stderr.write = originalStderr;
}
function hasLeakAssertion() {
  return stderrOutput.includes('list_empty(&rt->gc_obj_list)');
}

describe('GC leak assertions', () => {
  it('minimal: create and dispose VM', async () => {
    captureStderr();
    const vm = await QuickJS.create(wasmBytes);
    vm.dispose(true);
    restoreStderr();
    if (hasLeakAssertion()) throw new Error('GC assertion fired on minimal VM dispose');
  });

  it('eval only: create, eval, dispose', async () => {
    captureStderr();
    const vm = await QuickJS.create(wasmBytes);
    vm.evalCode('1 + 2').dispose();
    vm.dispose(true);
    restoreStderr();
    if (hasLeakAssertion()) throw new Error('GC assertion fired after eval');
  });

  it('host function: register, call, dispose', async () => {
    captureStderr();
    const vm = await QuickJS.create(wasmBytes);
    const fn = vm.newFunction('add', (_this, ...args) => {
      return vm.newNumber(args[0].toNumber() + args[1].toNumber());
    });
    vm.setProp(vm.global, 'add', fn);
    fn.dispose();
    vm.evalCode('add(1, 2)').dispose();
    vm.dispose(true);
    restoreStderr();
    if (hasLeakAssertion()) throw new Error('GC assertion fired after host function');
  });

  it('promise: create deferred, dispose without resolving', async () => {
    captureStderr();
    const vm = await QuickJS.create(wasmBytes);
    const deferred = vm.newPromise();
    deferred.handle.dispose();
    vm.dispose(true);
    restoreStderr();
    if (hasLeakAssertion()) throw new Error('GC assertion fired after unresolved promise');
  });
});
