---
"quickjs-wasi": minor
---

Add ArrayBuffer and typed array marshalling: `vm.newArrayBuffer()`, `vm.newUint8Array()`, `handle.toArrayBuffer()`, `handle.toUint8Array()`. `dump()` returns proper `ArrayBuffer` / `Uint8Array` / typed array types. `hostToHandle()` converts `ArrayBuffer`, `Uint8Array`, and other typed arrays.
