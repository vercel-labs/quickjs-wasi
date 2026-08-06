---
'quickjs-wasi': minor
---

Strings now cross the WASM boundary losslessly in both directions — embedded NULs and lone surrogates survive `toString()`, `newString()`, `evalCode()` sources, property keys, and enumeration.
