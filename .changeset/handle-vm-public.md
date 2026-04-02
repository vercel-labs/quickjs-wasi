---
"quickjs-wasi": patch
---

Make `JSValueHandle.vm` a public readonly property, allowing external code to access the QuickJS VM instance from any handle.
