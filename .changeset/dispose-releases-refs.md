---
"quickjs-wasi": patch
---

`dispose()` now releases all references to the WASM module, instance, and internal state so the WASM linear memory can be garbage collected. `JSValueHandle.dispose()` is safe to call after the VM has been disposed (becomes a no-op).
