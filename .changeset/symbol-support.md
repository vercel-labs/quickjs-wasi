---
"quickjs-wasi": minor
---

Add Symbol support:

- `vm.newSymbolFor(description)` — create global symbols (`Symbol.for()`)
- `vm.setProp(obj, symbolHandle, value)` / `vm.getProp(obj, symbolHandle)` — get/set properties using symbol keys
- `dump()` returns real host `Symbol.for(description)` for global symbols
- `hostToHandle()` converts host `Symbol.for()` values to QuickJS global symbols
- Local (anonymous) symbols dump as the string `"Symbol(description)"` and throw if passed to `hostToHandle()`

This enables the Workflow DevKit `globalThis[Symbol.for("WORKFLOW_USE_STEP")]` pattern.
