---
'quickjs-wasi': patch
---

`resolvePromise()`, `Deferred.settled`, and module namespace resolution now subscribe via quickjs-ng's engine-level `JS_PromiseThen` instead of a captured `Promise.prototype.then`, so guest code that patches `then` or `Symbol.species` can no longer intercept or observe host promise subscriptions.
