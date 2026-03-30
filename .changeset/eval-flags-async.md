---
"quickjs-wasi": minor
---

Add `EvalFlags` constants export and an optional `flags` parameter to `evalCode()`. The `EvalFlags.ASYNC` flag enables native top-level `await` support in evaluated scripts — the result is a Promise that resolves to the script's completion value. This is cleaner than wrapping code in an async IIFE, as it preserves last-expression-value semantics and avoids regex-based `await` detection.
