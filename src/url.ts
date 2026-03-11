/**
 * URL Extension for quickjs-wasi
 *
 * Provides a WHATWG URL Standard compliant implementation of URL and
 * URLSearchParams, backed by the ada-url library (https://github.com/ada-url/ada).
 *
 * @example
 * ```typescript
 * import { QuickJS } from 'quickjs-wasi';
 * import { urlExtension } from 'quickjs-wasi/url';
 *
 * const vm = await QuickJS.create({
 *   extensions: [urlExtension],
 * });
 *
 * vm.evalCode(`
 *   const url = new URL('https://example.com:8080/api?key=value');
 *   console.log(url.hostname); // 'example.com'
 *   console.log(url.port);     // '8080'
 *
 *   const params = new URLSearchParams('a=1&b=2');
 *   console.log(params.get('a')); // '1'
 * `);
 * ```
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionDescriptor } from './extensions.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(
  resolve(__dirname, '..', 'extensions', 'url', 'url.so')
);

/**
 * Pre-configured extension descriptor for the URL extension.
 *
 * Pass this to `QuickJS.create()` or `QuickJS.restore()` in the
 * `extensions` array to add `URL` and `URLSearchParams` to the
 * global scope of the QuickJS VM.
 */
export const urlExtension: ExtensionDescriptor = {
  name: 'url',
  wasm: wasmBytes,
};
