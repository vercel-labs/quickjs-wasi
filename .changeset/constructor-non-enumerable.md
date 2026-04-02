---
"quickjs-wasi": patch
---

Make `prototype.constructor` non-enumerable on all extension classes (`URL`, `URLSearchParams`, `Headers`, `TextEncoder`, `TextDecoder`), matching the Web IDL spec. The property remains writable and configurable.
