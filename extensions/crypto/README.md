# Crypto Extension

A W3C Web Cryptography API implementation backed by [mbedTLS 4.0](https://github.com/Mbed-TLS/mbedtls) (PSA Crypto). Provides the `crypto` global with `SubtleCrypto` for cryptographic operations.

```typescript
import { readFile } from 'node:fs/promises';

const wasm = await readFile(new URL(import.meta.resolve('quickjs-wasi/quickjs.wasm')));
const cryptoSo = await readFile(new URL(import.meta.resolve('quickjs-wasi/crypto.so')));

const vm = await QuickJS.create({
  wasm,
  extensions: [{ name: 'crypto', wasm: cryptoSo }],
});
```

## API

### `crypto` global

- `crypto.getRandomValues(typedArray)`: fill with cryptographically strong random values (max 65536 bytes)
- `crypto.randomUUID()`: generate a v4 UUID string
- `crypto.subtle`: `SubtleCrypto` instance

### `crypto.subtle` (SubtleCrypto)

- `digest(algorithm, data)`: SHA-1, SHA-256, SHA-384, SHA-512
- `generateKey(algorithm, extractable, keyUsages)`: HMAC, AES-CBC/CTR/GCM/KW, ECDSA (P-256/P-384/P-521), ECDH, Ed25519, X25519, RSA-OAEP/PKCS1v1.5/PSS
- `importKey(format, keyData, algorithm, extractable, keyUsages)`: raw, pkcs8, spki formats
- `exportKey(format, key)`: raw, pkcs8, spki formats
- `sign(algorithm, key, data)` / `verify(algorithm, key, signature, data)`: HMAC, ECDSA, Ed25519, RSA
- `encrypt(algorithm, key, data)` / `decrypt(algorithm, key, data)`: AES-GCM, AES-CBC, AES-CTR, RSA-OAEP
- `deriveBits(algorithm, baseKey, length)` / `deriveKey(...)`: HKDF, PBKDF2, ECDH, X25519
- `wrapKey(format, key, wrappingKey, algorithm)` / `unwrapKey(...)`: key wrapping via encrypt/decrypt

All SubtleCrypto methods return Promises.

### `CryptoKey`

- Properties: `type` (`"secret"`, `"public"`, `"private"`), `extractable`, `algorithm` (frozen), `usages` (frozen)
- `Symbol.toStringTag` = `"CryptoKey"`

### Global Constructors

`Crypto`, `SubtleCrypto`, and `CryptoKey` are exposed as global constructors per the Web Crypto spec. Calling them with `new` throws `TypeError("Illegal constructor")`; instances are only created internally by the crypto API.

### Deterministic RNG

The extension uses WASI `random_get` as its entropy source, which means user-provided `wasi` overrides of `random_get` flow through to all crypto operations. This enables deterministic crypto output for testing:

```typescript
const vm = await QuickJS.create({
  wasm: wasmBytes,
  wasi: (memory) => ({
    random_get(bufPtr: number, bufLen: number) {
      new Uint8Array(memory.buffer, bufPtr, bufLen).fill(0x42);
      return 0;
    },
  }),
  extensions: [cryptoExtension],
});
```

## Building

```bash
make  # builds quickjs.wasm and extensions/crypto/crypto.so
```
