---
'quickjs-wasi': patch
---

`memoryLimit` now actually bounds retained memory: the runtime is created with malloc functions that use wasi-libc's `malloc_usable_size`, replacing quickjs-ng's default usable-size which returns 0 on wasm32-wasi. Previously every allocation was accounted as overhead only, so retained ArrayBuffers/TypedArrays (and all other allocations) grew real memory without bound under any limit — reaching GiB under an 8 MiB `memoryLimit` — and `getMemoryUsage().mallocSize` stayed near zero. Workloads near their configured limit may now throw where they silently over-allocated before; raise `memoryLimit` to match actual usage.
