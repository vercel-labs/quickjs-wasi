---
'quickjs-wasi': minor
---

Add `vm.markPromiseHandled(promise)`: suppress the `onUnhandledRejection` callback for a promise whose rejection the host observes through other means.
