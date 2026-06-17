---
'quickjs-wasi': patch
---

Fix value corruption when transferring objects/arrays containing `false`, `true`, `null`, or `undefined` into the VM via `hostToHandle`. These primitives resolve to cached singleton handles, and the object/array conversion disposed each value handle after `setProp`, freeing the singleton's shared heap `JSValue` and corrupting later reads (e.g. `false` showing up as `NaN`). Disposing a cached singleton handle is now a no-op.
