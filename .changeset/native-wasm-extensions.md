---
"quickjs-wasi": minor
---

Add native WASM extension support via dynamic linking. Extensions are C-based WASM shared libraries that link directly against the QuickJS C API with zero marshalling overhead. Extensions are fully compatible with snapshot/restore. Includes a proof-of-concept URL and URLSearchParams extension.
