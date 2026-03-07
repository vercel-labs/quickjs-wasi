---
"quickjs-wasi": patch
---

Preserve circular and shared references in `dump()`. Instead of returning `undefined` for circular references, `dump()` now returns the same host object — preserving the reference structure on the host side.
