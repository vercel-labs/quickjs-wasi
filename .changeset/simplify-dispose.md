---
"quickjs-wasi": patch
---

Simplify `dispose()` to just mark the VM as unusable. The WASM instance and its linear memory are garbage collected by the host JS engine — no need to explicitly call `JS_FreeRuntime`. Removes `leakCheck` parameter from `dispose()`.
