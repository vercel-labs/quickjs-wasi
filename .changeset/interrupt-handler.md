---
"quickjs-wasi": minor
---

Add `interruptHandler` option to `QuickJSOptions`. Called periodically during JS execution — return `true` to interrupt with an exception. Useful for implementing execution timeouts or step limits to prevent infinite loops. The VM remains usable after an interrupt.
