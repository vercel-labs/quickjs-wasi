/**
 * Web Crypto API Extension for quickjs-wasi
 *
 * Provides a W3C Web Cryptography API compliant implementation of the
 * `crypto` global object, including `crypto.getRandomValues()`,
 * `crypto.randomUUID()`, and `crypto.subtle` (SubtleCrypto) with support
 * for digest, sign/verify, encrypt/decrypt, key generation, key import/export,
 * key derivation, and key wrapping/unwrapping.
 *
 * Backed by mbedTLS 4.0 PSA Crypto for all cryptographic operations.
 *
 * Supported algorithms:
 *   - Digest: SHA-1, SHA-256, SHA-384, SHA-512
 *   - HMAC: sign/verify with any supported hash
 *   - AES-CBC, AES-CTR, AES-GCM: encrypt/decrypt (128/192/256-bit keys)
 *   - AES-KW: key wrapping/unwrapping
 *   - RSA-OAEP: encrypt/decrypt
 *   - RSASSA-PKCS1-v1_5, RSA-PSS: sign/verify
 *   - ECDSA: sign/verify (P-256, P-384, P-521)
 *   - ECDH: key derivation (P-256, P-384, P-521)
 *   - Ed25519: sign/verify
 *   - X25519: key derivation
 *   - HKDF, PBKDF2: key derivation
 *
 * @example
 * ```typescript
 * import { QuickJS } from 'quickjs-wasi';
 * import { cryptoExtension } from 'quickjs-wasi/crypto';
 *
 * const vm = await QuickJS.create({
 *   extensions: [cryptoExtension],
 * });
 *
 * vm.evalCode(`
 *   // Generate random values
 *   const arr = new Uint8Array(32);
 *   crypto.getRandomValues(arr);
 *
 *   // Generate a UUID
 *   const id = crypto.randomUUID();
 *
 *   // Hash some data
 *   const hash = await crypto.subtle.digest('SHA-256',
 *     new TextEncoder().encode('hello'));
 * `);
 * ```
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionDescriptor } from './extensions.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(
  resolve(__dirname, '..', 'extensions', 'crypto', 'crypto.so')
);

/**
 * Pre-configured extension descriptor for the Web Crypto API extension.
 *
 * Pass this to `QuickJS.create()` or `QuickJS.restore()` in the
 * `extensions` array to add `crypto` (with `crypto.subtle`) to the
 * global scope.
 */
export const cryptoExtension: ExtensionDescriptor = {
  name: 'crypto',
  wasm: wasmBytes,
};
