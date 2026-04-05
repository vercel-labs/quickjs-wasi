---
"quickjs-wasi": minor
---

Add `onUnhandledRejection` option for tracking unhandled promise rejections. The callback receives the promise, rejection reason, and whether a handler was just attached. Works with both `QuickJS.create()` and `QuickJS.restore()`.
