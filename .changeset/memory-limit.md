---
"quickjs-wasi": minor
---

Add `memoryLimit` option to `QuickJSOptions`. Restricts how much memory the QuickJS runtime can allocate — when exceeded, allocations fail and surface as JS exceptions. The limit is re-applied after `QuickJS.restore()`.
