---
'quickjs-wasi': minor
---

Update QuickJS-ng from v0.13.0 to v0.14.0. Includes new C API additions (`JS_GetPendingJobContext`, `JS_IsAsyncFunction`, byte imports), `JSON.parse` source text access, bug fixes for fast arrays, `Iterator.concat` reentrancy, `ArrayBuffer` NULL data pointers, big-endian builds, and various small performance and correctness improvements. The runtime now also bumps to wasi-sdk 32 (clang 22.1.0) for the WASM toolchain.
