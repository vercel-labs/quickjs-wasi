---
"quickjs-wasi": minor
---

Add `Promise` support to `hostToHandle()`. Host Promises are automatically bridged to QuickJS promises via `Deferred`, with `executePendingJobs()` called on resolution/rejection.
