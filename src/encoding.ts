/**
 * Encoding Extension for quickjs-wasi
 *
 * Provides a WHATWG Encoding Standard compliant implementation of TextEncoder
 * and TextDecoder. Supports UTF-8 (encoding and decoding), UTF-16LE (decoding),
 * and UTF-16BE (decoding).
 *
 * @example
 * ```typescript
 * import { QuickJS } from 'quickjs-wasi';
 * import { encodingExtension } from 'quickjs-wasi/encoding';
 *
 * const vm = await QuickJS.create({
 *   extensions: [encodingExtension],
 * });
 *
 * vm.evalCode(`
 *   const encoder = new TextEncoder();
 *   const encoded = encoder.encode('Hello, world!');
 *   console.log(encoded.length); // 13
 *
 *   const decoder = new TextDecoder();
 *   console.log(decoder.decode(encoded)); // 'Hello, world!'
 * `);
 * ```
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionDescriptor } from './extensions.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(
  resolve(__dirname, '..', 'extensions', 'encoding', 'encoding.so')
);

/**
 * Pre-configured extension descriptor for the Encoding extension.
 *
 * Pass this to `QuickJS.create()` or `QuickJS.restore()` in the
 * `extensions` array to add `TextEncoder` and `TextDecoder` to the
 * global scope of the QuickJS VM.
 */
export const encodingExtension: ExtensionDescriptor = {
  name: 'encoding',
  wasm: wasmBytes,
};
