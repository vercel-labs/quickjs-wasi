---
'quickjs-wasi': minor
---

Lossless string transport across the WASM boundary: `toString()` reads length-aware WTF-8 (embedded U+0000 no longer truncates; lone surrogates survive instead of becoming U+FFFD), host→guest strings (`newString`, `evalCode` sources, property keys) encode WTF-8, and the string-key property APIs (`getProp`/`setProp`/`defineProp`/`hasOwnProperty`/`propertyIsEnumerable`) transparently route keys that C strings cannot express through length-aware guest values. Every JS string — any sequence of UTF-16 code units — now round-trips exactly.
