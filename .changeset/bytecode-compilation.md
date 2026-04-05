---
"quickjs-wasi": minor
---

Add `vm.compile()` and `vm.evalBytecode()` for bytecode compilation. Compile JavaScript source to a portable `Uint8Array` bytecode without executing it, then execute it later — even in a different VM instance. Also adds `CompileFlags.STRIP_SOURCE` and `CompileFlags.STRIP_DEBUG` for smaller bytecode output.
