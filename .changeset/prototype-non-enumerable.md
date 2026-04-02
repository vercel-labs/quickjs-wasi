---
"quickjs-wasi": patch
---

Make `Constructor.prototype` non-writable, non-enumerable, and non-configurable on all extension constructors (`URL`, `URLSearchParams`, `Headers`, `TextEncoder`, `TextDecoder`, `CryptoKey`), matching the Web IDL spec for built-in interface objects.
