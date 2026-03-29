/**
 * Base64 Extension for quickjs-wasi
 *
 * Provides WHATWG HTML Standard compliant `atob()` and `btoa()` global functions
 * using the "forgiving-base64" decode/encode algorithms from the Infra Standard,
 * plus the TC39 proposal-arraybuffer-base64 Uint8Array methods:
 *
 * - `Uint8Array.prototype.toBase64([options])`
 * - `Uint8Array.prototype.toHex()`
 * - `Uint8Array.fromBase64(string [, options])`
 * - `Uint8Array.fromHex(string)`
 * - `Uint8Array.prototype.setFromBase64(string [, options])`
 * - `Uint8Array.prototype.setFromHex(string)`
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
 *
 *   const arr = new Uint8Array([72, 101, 108, 108, 111]);
 *   console.log(arr.toBase64());   // 'SGVsbG8='
 *   console.log(arr.toHex());      // '48656c6c6f'
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
 * `extensions` array to add `atob()`, `btoa()`, and the Uint8Array
 * base64/hex methods to the global scope.
 */
export const base64Extension: ExtensionDescriptor = {
  name: 'base64',
  wasm: wasmBytes,
};
