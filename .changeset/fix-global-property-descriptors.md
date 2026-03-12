---
"quickjs-wasi": patch
---

Fix native extension global property descriptors to match web browser behavior. `TextEncoder`, `TextDecoder`, `URL`, and `URLSearchParams` are now defined as writable and configurable but not enumerable on `globalThis`, matching how browsers define them. `btoa`, `atob`, and `structuredClone` were already correct.
