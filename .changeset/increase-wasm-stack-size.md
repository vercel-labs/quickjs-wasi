---
"quickjs-wasi": patch
---

Increase WASM stack size to 1MB to prevent stack overflow traps. The default wasi-sdk stack (~173KB) was too small for QuickJS, causing hard WASM traps instead of catchable JS exceptions during recursive operations like JSON.stringify or devalue serialization at moderate depths.
