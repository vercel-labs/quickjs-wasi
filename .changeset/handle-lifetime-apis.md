---
'quickjs-wasi': minor
---

Add `vm.withScope()` for batch handle disposal, `vm.newEphemeralFunction()` and `vm.unregisterHostCallback()` for host-callback lifetime management, and `handle.disposed`. `resolvePromise()` now subscribes via the captured `Promise.prototype.then` instead of reading `.then` off the value.
