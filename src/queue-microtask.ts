/**
 * queueMicrotask Extension for quickjs-wasi
 *
 * Provides the WHATWG HTML Standard `queueMicrotask()` global function.
 * Uses QuickJS's JS_EnqueueJob to schedule callbacks on the microtask queue.
 *
 * @example
 * ```typescript
 * import { QuickJS } from 'quickjs-wasi';
 * import { queueMicrotaskExtension } from 'quickjs-wasi/queue-microtask';
 *
 * const vm = await QuickJS.create({
 *   extensions: [queueMicrotaskExtension],
 * });
 *
 * vm.evalCode(`
 *   queueMicrotask(() => console.log('microtask executed'));
 * `);
 * ```
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionDescriptor } from './extensions.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(
  resolve(__dirname, '..', 'extensions', 'queue-microtask', 'queue-microtask.so')
);

/**
 * Pre-configured extension descriptor for the queueMicrotask extension.
 *
 * Pass this to `QuickJS.create()` or `QuickJS.restore()` in the
 * `extensions` array to add `queueMicrotask()` to the global scope.
 */
export const queueMicrotaskExtension: ExtensionDescriptor = {
  name: 'queue-microtask',
  wasm: wasmBytes,
  initFn: 'qjs_ext_queue_microtask_init',
};
