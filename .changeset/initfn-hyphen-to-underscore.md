---
"quickjs-wasi": patch
---

Replace `-` with `_` in extension name when deriving the default `initFn`, since hyphens are not valid in C function names
