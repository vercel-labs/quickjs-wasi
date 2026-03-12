---
"quickjs-wasi": minor
---

Add `defineProp()` method on both `QuickJS` and `JSValueHandle` for defining properties with explicit descriptor flags (`writable`, `enumerable`, `configurable`), similar to `Object.defineProperty()`. Accepts string or `JSValueHandle` keys, supporting symbols.
