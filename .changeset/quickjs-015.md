---
'quickjs-wasi': minor
---

Update QuickJS-ng from v0.13.0 to v0.15.0 (bumps through v0.14.0). Highlights:

- **`atob()` / `btoa()` are now native built-ins.** They are controlled by a new `Intrinsics.ATOB_BTOA` flag, included in `Intrinsics.ALL` by default. Enabling this intrinsic also pulls in `DOMException` (errors thrown by these functions are `DOMException` instances).
- **`Uint8Array` base64/hex methods** (`toBase64`, `fromBase64`, `toHex`, `fromHex`, `setFromBase64`, `setFromHex`) are now part of the native `TypedArrays` intrinsic.
- **Explicit Resource Management** (`using` / `await using` in JavaScript) is now supported in the embedded VM.
- New C API: `JS_GetPendingJobContext`, `JS_IsAsyncFunction`, `JS_NewUint64`, support for byte imports in modules, `JSON.parse` source text access.
- Bug fixes for `Iterator.concat` reentrancy, fast array UAF + overflow, property set extensibility checks, atom leaks in `JS_NewSymbol`, big-endian builds, and stack-trace line numbers around `for/of` cleanup.

**Breaking — `base64` extension removed.** The `quickjs-wasi/base64.so` subpath export has been deleted because every feature it provided is now native in the runtime. To migrate, drop the extension from your `extensions` array — `atob`, `btoa`, and the `Uint8Array` base64/hex methods are available unconditionally (assuming you have not disabled `Intrinsics.ATOB_BTOA` or `Intrinsics.TYPED_ARRAYS`).

The WASM toolchain also bumps to wasi-sdk 32 (clang 22.1.0).
