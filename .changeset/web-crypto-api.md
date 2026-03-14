---
"quickjs-wasi": minor
---

Add Web Crypto API extension (`quickjs-wasi/crypto`) backed by mbedTLS 4.0 PSA Crypto

- **New extension**: `crypto` global with `getRandomValues()`, `randomUUID()`, and full `SubtleCrypto` support
  - Digest: SHA-1, SHA-256, SHA-384, SHA-512
  - Sign/verify: HMAC, ECDSA (P-256/P-384/P-521), Ed25519, RSASSA-PKCS1-v1_5, RSA-PSS
  - Encrypt/decrypt: AES-GCM, AES-CBC, AES-CTR, RSA-OAEP
  - Key generation: all above algorithms plus AES-KW, ECDH, X25519
  - Key import/export: raw, pkcs8, spki formats
  - Key derivation: HKDF, PBKDF2, ECDH, X25519
  - Key wrapping: wrapKey/unwrapKey via encrypt/decrypt
  - CryptoKey class with type, extractable, algorithm, usages properties

- **WASI override system**: the `wasi` option on `QuickJSOptions` is now a factory function `(memory: WebAssembly.Memory) => Record<string, Function>` that can override any `wasi_snapshot_preview1` host function. Overrides apply to both the main module and all extensions. Extensions can also provide their own WASI implementations via `ExtensionDescriptor.wasi`. Three-layer precedence: built-in defaults < extension-provided < user overrides.

- **Extension loader improvements**:
  - Extensions that import `wasi_snapshot_preview1` functions now receive the shared WASI shim (no more duplicated implementations)
  - `GOT.func` entries are now resolved by adding main-module functions to the indirect function table, enabling extensions that use function pointers to libc functions (e.g. `memset`)

- **Browser playground**: added Crypto toggle to the extension toolbar

- **Breaking change**: `WasiOptions` is now a factory function instead of an object with a `now()` method. Migration: `{ now: () => timeNs }` becomes `(memory) => ({ clock_time_get(_clockId, _precision, resultPtr) { new DataView(memory.buffer).setBigUint64(resultPtr, timeNs, true); return 0; } })`
