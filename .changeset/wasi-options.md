---
"quickjs-wasi": minor
---

Add configurable WASI clock via `QuickJSOptions.wasi`. The `wasi.now(clockId)` option controls both `Date.now()` / `new Date()` and the `Math.random()` PRNG seed at the engine level — no need to patch JS globals. QuickJS seeds its internal xorshift64* PRNG from the clock value during context creation, so two VMs created with the same `now()` value produce identical `Math.random()` sequences.
