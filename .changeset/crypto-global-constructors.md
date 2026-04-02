---
"quickjs-wasi": minor
---

Expose `Crypto` and `SubtleCrypto` as global constructors in the crypto extension, matching the Web Crypto API spec. All three crypto constructors (`Crypto`, `SubtleCrypto`, `CryptoKey`) now throw `TypeError: Illegal constructor` when called with `new`, and support `instanceof` checks (e.g. `crypto instanceof Crypto`).
