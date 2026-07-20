---
"quickjs-wasi": minor
---

Module evaluation now resolves to the module namespace object (its exports).

Previously, evaluating code with `EvalFlags.TYPE_MODULE` (via `evalCode()` or
`evalBytecode()`) returned a promise that resolved to `undefined`, making it
impossible to access a module's exports from the host. The evaluation promise
is now chained so it resolves to the module's namespace object instead —
matching quickjs-emscripten's behavior:

```typescript
using promise = vm.evalCode('export default 42', '<eval>', EvalFlags.TYPE_MODULE);
vm.executePendingJobs();
const result = await vm.resolvePromise(promise);
if ('value' in result) {
  result.value.getProp('default').consume(h => h.toNumber()); // 42
}
```

Rejections (a throw during module evaluation) propagate through the returned
promise unchanged. Fixes [#22](https://github.com/vercel-labs/quickjs-wasi/issues/22).
