/**
 * DOMException Extension for quickjs-wasi
 *
 * Provides a WebIDL spec compliant DOMException class with all legacy error
 * code constants. The prototype chain is DOMException -> Error -> Object.
 *
 * @example
 * ```typescript
 * import { QuickJS } from 'quickjs-wasi';
 * import { domExceptionExtension } from 'quickjs-wasi/dom-exception';
 *
 * const vm = await QuickJS.create({
 *   extensions: [domExceptionExtension],
 * });
 *
 * vm.evalCode(`
 *   const err = new DOMException('Something went wrong', 'NotFoundError');
 *   console.log(err.name);    // 'NotFoundError'
 *   console.log(err.code);    // 8
 *   console.log(err.message); // 'Something went wrong'
 * `);
 * ```
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionDescriptor } from './extensions.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(
  resolve(__dirname, '..', 'extensions', 'dom-exception', 'dom-exception.so')
);

/**
 * Pre-configured extension descriptor for the DOMException extension.
 *
 * Pass this to `QuickJS.create()` or `QuickJS.restore()` in the
 * `extensions` array to add `DOMException` to the global scope.
 */
export const domExceptionExtension: ExtensionDescriptor = {
  name: 'dom-exception',
  wasm: wasmBytes,
  initFn: 'qjs_ext_dom_exception_init',
};
