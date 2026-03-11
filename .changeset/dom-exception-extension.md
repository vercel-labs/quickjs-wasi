---
"quickjs-wasi": minor
---

Add `quickjs-wasi/dom-exception` sub-export with WebIDL-compliant DOMException

- Native WASM extension implementing the DOMException class from the WebIDL spec
- Constructor: `new DOMException(message?, name?)` with defaults `""` and `"Error"`
- Properties: `name`, `message`, `code` (legacy code lookup)
- All 25 legacy error code constants (INDEX_SIZE_ERR through DATA_CLONE_ERR)
- Prototype inherits from Error.prototype (`instanceof Error` is true)
- When loaded alongside the base64 extension, btoa/atob throw proper DOMException
