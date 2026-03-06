/**
 * Proof-of-concept test: QuickJS WASM snapshot and restore with pending promises.
 *
 * This test demonstrates:
 * 1. Creating a QuickJS VM, evaluating code that creates a pending promise
 * 2. Snapshotting the entire VM state
 * 3. Restoring the VM in a fresh WASM instance
 * 4. Resolving the pending promise in the restored VM
 * 5. Verifying the promise callback executed correctly
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QuickJS, type Snapshot } from '../ts/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(__dirname, '..', 'quickjs.wasm');
const wasmBytes = readFileSync(wasmPath);

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
  } else {
    console.log(`  PASS: ${message}`);
    passed++;
  }
}

async function testBasicEval() {
  console.log('\n--- Test: Basic Eval ---');
  const vm = await QuickJS.create(wasmBytes);

  const result = vm.evalCode('1 + 2');
  assert(!result.isException, 'eval should not throw');
  assert(result.toNumber() === 3, '1 + 2 should equal 3');
  result.dispose();

  const strResult = vm.evalCode('"hello" + " " + "world"');
  assert(strResult.toString() === 'hello world', 'string concatenation works');
  strResult.dispose();

  vm.dispose();
}

async function testPromiseCreation() {
  console.log('\n--- Test: Promise Creation ---');
  const vm = await QuickJS.create(wasmBytes);

  // Create a promise from the host side
  const { promise, resolve: resolveFunc, reject: rejectFunc } = vm.newPromise();
  assert(promise.promiseState === 0, 'new promise should be pending (state 0)');

  // Set up the promise on the global object
  const global = vm.getGlobal();
  global.setProp('testPromise', promise);

  // Evaluate code that attaches a .then handler
  const evalResult = vm.evalCode(`
    globalThis.promiseResult = undefined;
    testPromise.then(value => {
      globalThis.promiseResult = "resolved: " + value;
    });
  `);
  evalResult.dispose();
  vm.executePendingJobs();

  // Check that promiseResult is still undefined (promise not yet resolved)
  const beforeResolve = global.getProp('promiseResult');
  assert(beforeResolve.isUndefined, 'promiseResult should be undefined before resolve');
  beforeResolve.dispose();

  // Now resolve the promise
  const resolveValue = vm.newString('hello from host');
  const undefinedVal = vm.getUndefined();
  vm.callFunction(resolveFunc, undefinedVal, resolveValue);
  vm.executePendingJobs();

  // Check the result
  const afterResolve = global.getProp('promiseResult');
  assert(afterResolve.toString() === 'resolved: hello from host', 'promise should be resolved with correct value');
  afterResolve.dispose();

  resolveValue.dispose();
  undefinedVal.dispose();
  resolveFunc.dispose();
  rejectFunc.dispose();
  promise.dispose();
  global.dispose();
  vm.dispose();
}

async function testSnapshotAndRestore() {
  console.log('\n--- Test: Snapshot and Restore (Simple State) ---');

  // Phase 1: Create a VM with some state and snapshot it
  const vm1 = await QuickJS.create(wasmBytes);

  vm1.evalCode(`
    globalThis.counter = 42;
    globalThis.message = "hello from snapshot";
  `);

  const snapshot = vm1.snapshot();
  console.log(`  Snapshot size: ${(snapshot.memory.length / 1024).toFixed(0)} KB`);
  console.log(`  Memory pages: ${snapshot.memoryPages}`);
  console.log(`  Runtime ptr: 0x${snapshot.runtimePtr.toString(16)}`);
  console.log(`  Context ptr: 0x${snapshot.contextPtr.toString(16)}`);
  console.log(`  Stack pointer: 0x${snapshot.stackPointer.toString(16)}`);

  vm1.dispose(false); // Skip leak check - we just want to drop the instance

  // Phase 2: Restore the VM from the snapshot
  const vm2 = await QuickJS.restore(snapshot, wasmBytes);

  // Verify the state was preserved
  const counterResult = vm2.evalCode('globalThis.counter');
  assert(counterResult.toNumber() === 42, 'counter should be 42 after restore');
  counterResult.dispose();

  const messageResult = vm2.evalCode('globalThis.message');
  assert(messageResult.toString() === 'hello from snapshot', 'message should be preserved after restore');
  messageResult.dispose();

  // Verify we can still do work in the restored VM
  const newResult = vm2.evalCode('globalThis.counter + 1');
  assert(newResult.toNumber() === 43, 'can evaluate new code in restored VM');
  newResult.dispose();

  vm2.dispose(false);
}

async function testSnapshotWithPendingPromise() {
  console.log('\n--- Test: Snapshot with Pending Promise (THE KEY TEST) ---');

  // Phase 1: Create a VM, set up a pending promise, and snapshot
  const vm1 = await QuickJS.create(wasmBytes);

  // Create a deferred promise from the host
  const { promise, resolve: resolveFunc, reject: rejectFunc } = vm1.newPromise();

  // Store the promise on the global so it's reachable from JS code
  const global1 = vm1.getGlobal();
  global1.setProp('pendingStep', promise);

  // Evaluate code that awaits the promise
  vm1.evalCode(`
    globalThis.stepResult = "not yet";
    globalThis.pendingStep.then(value => {
      globalThis.stepResult = "completed: " + value;
    });
  `);
  vm1.executePendingJobs();

  // Verify promise is pending
  const beforeSnap = global1.getProp('stepResult');
  assert(beforeSnap.toString() === 'not yet', 'stepResult should be "not yet" before snapshot');
  beforeSnap.dispose();

  // Store the resolve function pointer so we can find it after restore.
  // We'll save the resolve function on the global object too.
  global1.setProp('__resolveFunc', resolveFunc);

  // SNAPSHOT the VM
  const snapshot = vm1.snapshot();
  console.log(`  Snapshot taken with pending promise`);
  console.log(`  Snapshot size: ${(snapshot.memory.length / 1024).toFixed(0)} KB`);

  // Clean up vm1 (simulate: this process is going away)
  // We skip leak check because we intentionally have live objects in the VM
  // that are preserved in the snapshot.
  vm1.dispose(false);

  console.log(`  Original VM disposed. Simulating resumption in a new process...`);

  // Phase 2: RESTORE the VM from the snapshot in a "fresh" context
  const vm2 = await QuickJS.restore(snapshot, wasmBytes);

  // Verify the state is still there
  const afterRestore = vm2.evalCode('globalThis.stepResult');
  assert(afterRestore.toString() === 'not yet', 'stepResult should still be "not yet" after restore');
  afterRestore.dispose();

  // Retrieve the resolve function from the restored VM
  const global2 = vm2.getGlobal();
  const restoredResolve = global2.getProp('__resolveFunc');
  assert(!restoredResolve.isUndefined, 'resolve function should be available after restore');

  // NOW: Resolve the pending promise in the restored VM!
  // This simulates: new events arrived that tell us the step completed.
  const resolveArg = vm2.newString('step-42-result');
  const undefinedVal = vm2.getUndefined();
  const callResult = vm2.callFunction(restoredResolve, undefinedVal, resolveArg);

  if (callResult.isException) {
    const exc = vm2.getException();
    console.error(`  Exception calling resolve: ${exc.toString()}`);
    exc.dispose();
  }
  callResult.dispose();

  // Execute the promise reaction jobs
  const jobsRun = vm2.executePendingJobs();
  console.log(`  Executed ${jobsRun} pending jobs after resolving promise`);

  // CHECK: Did the .then handler run?
  const finalResult = global2.getProp('stepResult');
  const finalValue = finalResult.toString();
  console.log(`  Final stepResult: "${finalValue}"`);
  assert(
    finalValue === 'completed: step-42-result',
    'Promise .then handler should have executed in the restored VM!'
  );
  finalResult.dispose();

  resolveArg.dispose();
  undefinedVal.dispose();
  restoredResolve.dispose();
  global2.dispose();
  vm2.dispose(false);
}

// Run all tests
async function main() {
  console.log('=== QuickJS WASM Snapshot/Restore PoC ===');

  try {
    await testBasicEval();
    await testPromiseCreation();
    await testSnapshotAndRestore();
    await testSnapshotWithPendingPromise();
  } catch (err) {
    console.error('\nUNEXPECTED ERROR:', err);
    failed++;
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
