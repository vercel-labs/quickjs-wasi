---
"quickjs-wasi": major
---

**Breaking:** `evalCode()` and `callFunction()` now throw a `JSException` directly when the evaluated code or called function throws, matching standard JavaScript semantics. The `unwrapResult()` method and `isException` property have been removed — exceptions propagate naturally via try/catch.
