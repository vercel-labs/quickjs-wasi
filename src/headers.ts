/**
 * Headers Extension for quickjs-wasi
 *
 * Provides a WHATWG Fetch Standard compliant `Headers` class as a global
 * constructor, implemented as a native WASM extension for optimal performance.
 *
 * @example
 * ```typescript
 * import { QuickJS } from 'quickjs-wasi';
 * import { headersExtension } from 'quickjs-wasi/headers';
 *
 * const vm = await QuickJS.create({
 *   extensions: [headersExtension],
 * });
 *
 * vm.evalCode(`
 *   const headers = new Headers({ 'Content-Type': 'application/json' });
 *   headers.append('Accept', 'text/html');
 *   console.log(headers.get('content-type'));  // 'application/json'
 * `);
 * ```
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionDescriptor } from './extensions.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(
  resolve(__dirname, '..', 'extensions', 'headers', 'headers.so')
);

/**
 * Pre-configured extension descriptor for the Headers extension.
 *
 * Pass this to `QuickJS.create()` or `QuickJS.restore()` in the
 * `extensions` array to add the `Headers` class to the global scope.
 */
export const headersExtension: ExtensionDescriptor = {
  name: 'headers',
  wasm: wasmBytes,
};
