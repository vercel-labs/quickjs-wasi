---
"quickjs-wasi": patch
---

Fix `resolveModule()` to use `new URL()` pattern recognized by `@vercel/nft`, ensuring `quickjs.wasm` is included in traced file lists
