---
"quickjs-wasi": patch
---

Optimize WASM binary sizes. The build now compiles with `-Oz`, strips debug
info at link time, and runs `binaryen`'s `wasm-opt -Oz` as a post-link pass —
applied to both `quickjs.wasm` and all extension `.so` files. Total shipped
binary size drops from 2.61 MB to 1.10 MB (-58%); `quickjs.wasm` specifically
goes from 1.52 MB to 597 KB (-62%). Override the optimization level with
`make OPT=-O2` to favor runtime speed over size.
