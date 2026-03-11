---
"quickjs-wasi": minor
---

Add `quickjs-wasi/encoding` sub-export with WHATWG-compliant TextEncoder and TextDecoder

- Native WASM extension implementing the Encoding Standard (pure C, no C++ dependencies)
- TextEncoder: `encode()`, `encodeInto()`, USVString semantics (lone surrogates → U+FFFD)
- TextDecoder: UTF-8, UTF-16LE, UTF-16BE decoding with streaming, BOM handling, fatal mode
- Accepts ArrayBuffer, TypedArray, and DataView inputs
- `quickjs-wasi/encoding` package sub-export for ergonomic opt-in
- 231 tests passing (67 unit + 164 WPT-based compliance tests)
- ~20x faster than fast-text-encoding JS polyfill, +45 bytes snapshot overhead vs +64KB
