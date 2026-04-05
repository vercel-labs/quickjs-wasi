---
"quickjs-wasi": minor
---

Add `moduleLoader` option for ES module support. Provides `normalize` and `load` callbacks that enable `import` statements to resolve and load modules. The callbacks are synchronous — for async module resolution, pre-fetch sources before creating the VM. Works with `QuickJS.create()` and `QuickJS.restore()`, and is compatible with snapshots (loaded modules survive, but the loader must be re-provided on restore for future imports).
