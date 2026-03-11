---
"quickjs-wasi": minor
---

Add `quickjs-wasi/base64` sub-export with WHATWG-compliant atob and btoa

- Native WASM extension implementing the HTML Standard's Base64 utility methods
- `btoa(data)`: encode binary string to base64, throws for characters > U+00FF
- `atob(data)`: forgiving-base64 decode (strips whitespace, allows missing padding)
- Throws `InvalidCharacterError` DOMException (built into QuickJS-ng)
- ~85x faster than core-js-pure polyfill, +41 bytes snapshot vs +512KB
