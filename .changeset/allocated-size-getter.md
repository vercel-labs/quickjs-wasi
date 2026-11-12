---
"quickjs-wasi": minor
---

Add `vm.getAllocatedSize()`, a constant-time read of the bytes the runtime has allocated: the value `memoryLimit` is enforced against. Unlike `vm.getMemoryUsage()`, which walks the whole heap, its cost doesn't grow with heap size, so it suits frequent sampling. `getMemoryUsage()` also reports the same value as a new `allocatedSize` field.
