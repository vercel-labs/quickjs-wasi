---
"quickjs-wasi": patch
---

Improve module loader error handling:

- Errors thrown by `moduleLoader.load` / `moduleLoader.normalize` now propagate
  to the guest with their real message instead of being swallowed and replaced
  by a generic `could not load module` error.
- Returning a Promise (an `async` callback) from `load` or `normalize` now
  throws a clear `TypeError` explaining that the callbacks must be synchronous,
  instead of coercing the Promise to source text and failing with a confusing
  `SyntaxError`. For async module sources (e.g. loading over `https://`), see
  the fetch-and-retry pattern documented in the README's "ES Modules" section.
