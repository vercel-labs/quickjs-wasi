---
'quickjs-wasi': patch
---

`resolvePromise()` now subscribes via a captured `Promise.prototype.then` instead of reading `.then` off the value, so a proxy trap or shadowed accessor can no longer intercept it.
