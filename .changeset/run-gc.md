---
"quickjs-wasi": minor
---

Add `vm.runGC()` method for explicitly triggering garbage collection. QuickJS runs GC automatically, but this is useful for reclaiming memory at a known point or before taking a snapshot.
