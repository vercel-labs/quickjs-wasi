---
"quickjs-wasi": patch
---

Settle synchronous module namespace promises without draining unrelated guest jobs. Preserve deferred resolution for asynchronous modules and namespaces exporting `then`.
