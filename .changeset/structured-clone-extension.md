---
"quickjs-wasi": minor
---

Add `quickjs-wasi/structured-clone` sub-export with WHATWG-compliant structuredClone

- Native WASM extension implementing the Structured Clone algorithm
- Deep clones: primitives, Date, RegExp, ArrayBuffer, TypedArrays, DataView, Map, Set, Array, Error, plain objects
- Circular reference detection and preservation of shared references
- Throws DataCloneError for non-cloneable types (functions, symbols, proxies, promises)
