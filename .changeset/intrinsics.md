---
"quickjs-wasi": minor
---

Add `intrinsics` option to `QuickJS.create()` for controlling which built-in JavaScript features are available in the VM. Pass a bitmask of `Intrinsics.*` flags to create a minimal sandbox — for example, omit `Intrinsics.PROXY` to disallow `Proxy`, or omit `Intrinsics.DATE` to remove `Date`. Useful for security hardening or reducing memory usage. Note: `Intrinsics.EVAL` must be included for `vm.evalCode()` to work; without it, only pre-compiled bytecode via `vm.evalBytecode()` can be executed.
