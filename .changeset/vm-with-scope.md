---
'quickjs-wasi': minor
---

Add `vm.withScope(fn)`: batch handle disposal for every handle created during the call, with `scope.escape(handle)` to keep specific handles alive.
