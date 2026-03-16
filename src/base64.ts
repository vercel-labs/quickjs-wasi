/**
 * Base64 Extension for quickjs-wasi
 *
 * Provides WHATWG HTML Standard compliant `atob()` and `btoa()` global functions
 * using the "forgiving-base64" decode/encode algorithms from the Infra Standard.
 *
 * @example
 * ```typescript
 * import { QuickJS } from 'quickjs-wasi';
 * import { base64Extension } from 'quickjs-wasi/base64';
 *
 * const vm = await QuickJS.create({
 *   extensions: [base64Extension],
 * });
 *
 * vm.evalCode(`
 *   const encoded = btoa('Hello, world!');
 *   console.log(encoded);          // 'SGVsbG8sIHdvcmxkIQ=='
 *   console.log(atob(encoded));    // 'Hello, world!'
 * `);
 * ```
 */
import { readFileSync } from 'node:fs';
import type { ExtensionDescriptor } from './extensions.ts';

const wasmBytes = readFileSync(
  new URL('../extensions/base64/base64.so', import.meta.url)
);

/**
 * Pre-configured extension descriptor for the Base64 extension.
 *
 * Pass this to `QuickJS.create()` or `QuickJS.restore()` in the
 * `extensions` array to add `atob()` and `btoa()` to the global scope.
 */
export const base64Extension: ExtensionDescriptor = {
  name: 'base64',
  wasm: wasmBytes,
};
