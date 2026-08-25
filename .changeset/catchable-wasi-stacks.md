---
"quickjs-wasi": minor
---

Add the `maxStackSize` option and `MAX_STACK_SIZE` ceiling so WASI stack
overflow can be caught by guest JavaScript without exhausting the physical
WebAssembly stack.
