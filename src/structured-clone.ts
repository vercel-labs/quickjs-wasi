/**
 * structuredClone Extension for quickjs-wasi
 *
 * Provides the WHATWG HTML Standard `structuredClone()` global function.
 * Performs deep cloning following the Structured Clone algorithm with
 * circular reference detection.
 *
 * Supported types: primitives, Date, RegExp, ArrayBuffer, TypedArrays,
 * DataView, Map, Set, Array, Error, and plain objects.
 *
 * @example
 * ```typescript
 * import { QuickJS } from 'quickjs-wasi';
 * import { structuredCloneExtension } from 'quickjs-wasi/structured-clone';
 *
 * const vm = await QuickJS.create({
 *   extensions: [structuredCloneExtension],
 * });
 *
 * vm.evalCode(`
 *   const obj = { a: 1, b: [2, 3], c: new Date() };
 *   const clone = structuredClone(obj);
 *   console.log(clone.a === obj.a);     // true (same value)
 *   console.log(clone.b === obj.b);     // false (different array)
 *   console.log(clone.c.getTime() === obj.c.getTime()); // true
 * `);
 * ```
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionDescriptor } from './extensions.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(
  resolve(__dirname, '..', 'extensions', 'structured-clone', 'structured-clone.so')
);

/**
 * Pre-configured extension descriptor for the structuredClone extension.
 *
 * Pass this to `QuickJS.create()` or `QuickJS.restore()` in the
 * `extensions` array to add `structuredClone()` to the global scope.
 */
export const structuredCloneExtension: ExtensionDescriptor = {
  name: 'structured-clone',
  wasm: wasmBytes,
  initFn: 'qjs_ext_structured_clone_init',
};
