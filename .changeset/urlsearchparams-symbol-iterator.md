---
"quickjs-wasi": patch
---

Add `Symbol.iterator` to `URLSearchParams.prototype`, aliased to `entries()` per the WHATWG URL spec. This makes `URLSearchParams` instances iterable with `for...of` and spread syntax.
