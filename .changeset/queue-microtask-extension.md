---
"quickjs-wasi": minor
---

Add `quickjs-wasi/queue-microtask` sub-export with WHATWG-compliant queueMicrotask

- Native WASM extension providing the `queueMicrotask()` global function
- Uses QuickJS's `JS_EnqueueJob` to schedule callbacks on the microtask queue
- Throws `TypeError` for non-callable arguments
- Microtasks execute when host calls `vm.executePendingJobs()`
