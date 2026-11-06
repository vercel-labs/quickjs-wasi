---
"quickjs-wasi": minor
---

Update QuickJS-NG from v0.17.0 to v0.18.0. Out-of-memory errors (`InternalError: out of memory`) can no longer be caught by guest code: guest `catch`/`finally` blocks are skipped and the error propagates to the host as a `JSException`, leaving the VM usable. The release also includes fixes for `String.prototype.repeat`, `Reflect.set`, computed property assignment order, template literal conversion, `Date.parse` with Unicode spaces, and several memory leaks.
