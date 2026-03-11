# quickjs-wasi

## 1.1.0

### Minor Changes

- [`c1e7074`](https://github.com/vercel-labs/quickjs-wasi/commit/c1e7074f53eadd1953887b87578d70d3838ee700) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `quickjs-wasi/base64` sub-export with WHATWG-compliant atob and btoa

  - Native WASM extension implementing the HTML Standard's Base64 utility methods
  - `btoa(data)`: encode binary string to base64, throws for characters > U+00FF
  - `atob(data)`: forgiving-base64 decode (strips whitespace, allows missing padding)
  - Throws `InvalidCharacterError` DOMException (built into QuickJS-ng)
  - ~85x faster than core-js-pure polyfill, +41 bytes snapshot vs +512KB

- [`b79b714`](https://github.com/vercel-labs/quickjs-wasi/commit/b79b714d360859c57cf866e3e081cf46bf27d980) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `quickjs-wasi/encoding` sub-export with WHATWG-compliant TextEncoder and TextDecoder

  - Native WASM extension implementing the Encoding Standard (pure C, no C++ dependencies)
  - TextEncoder: `encode()`, `encodeInto()`, USVString semantics (lone surrogates → U+FFFD)
  - TextDecoder: UTF-8, UTF-16LE, UTF-16BE decoding with streaming, BOM handling, fatal mode
  - Accepts ArrayBuffer, TypedArray, and DataView inputs
  - `quickjs-wasi/encoding` package sub-export for ergonomic opt-in
  - 231 tests passing (67 unit + 164 WPT-based compliance tests)
  - ~20x faster than fast-text-encoding JS polyfill, +45 bytes snapshot overhead vs +64KB

- [`e5d4ec8`](https://github.com/vercel-labs/quickjs-wasi/commit/e5d4ec8bfc124c3245aa4ad9c4a9b60ef1598fd8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `quickjs-wasi/structured-clone` sub-export with WHATWG-compliant structuredClone

  - Native WASM extension implementing the Structured Clone algorithm
  - Deep clones: primitives, Date, RegExp, ArrayBuffer, TypedArrays, DataView, Map, Set, Array, Error, plain objects
  - Circular reference detection and preservation of shared references
  - Throws DataCloneError for non-cloneable types (functions, symbols, proxies, promises)

- [`29de279`](https://github.com/vercel-labs/quickjs-wasi/commit/29de27994e3f34754f500ee31361688949b69d47) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `quickjs-wasi/url` sub-export with WHATWG-compliant URL and URLSearchParams backed by ada-url

  - Replace hand-written URL parser with [ada-url](https://github.com/ada-url/ada) v3.4.3 for full WHATWG URL Standard compliance
  - Add `quickjs-wasi/url` package sub-export for ergonomic opt-in: `import { urlExtension } from 'quickjs-wasi/url'`
  - URL class: constructor with base URL support, all property getters/setters, `toString()`, `toJSON()`, static `URL.canParse()`
  - URLSearchParams class: `get()`, `getAll()`, `set()`, `has()`, `delete()`, `append()`, `sort()`, `toString()`, `forEach()`, `entries()`, `keys()`, `values()`, `size`
  - Extension loader: support C++ shared library self-resolution and graceful handling of unresolved symbols
  - 100% pass rate on 877 Web Platform Tests (urltestdata.json)

## 1.0.0

### Major Changes

- [`4e37d4a`](https://github.com/vercel-labs/quickjs-wasi/commit/4e37d4abdf503adb2a6824a4dc9a9ea99585b5bb) Thanks [@TooTallNate](https://github.com/TooTallNate)! - **Breaking:** `evalCode()` and `callFunction()` now throw a `JSException` directly when the evaluated code or called function throws, matching standard JavaScript semantics. The `unwrapResult()` method and `isException` property have been removed — exceptions propagate naturally via try/catch.

### Minor Changes

- [`f64397e`](https://github.com/vercel-labs/quickjs-wasi/commit/f64397e7e3634818eaee9eb2a08975a179131b6f) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `JSException` class that extends `Error` and is thrown by `unwrapResult()`. It exposes a `handle` property — a live `JSValueHandle` to the QuickJS exception value — allowing direct inspection of custom properties on the thrown error. Also fixes a bug where errors thrown from host callbacks were returned as regular values instead of being propagated as QuickJS exceptions.

- [`710c39a`](https://github.com/vercel-labs/quickjs-wasi/commit/710c39a688e70eb6336f8cca4d4a737b82fe97b0) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add native WASM extension support via dynamic linking. Extensions are C-based WASM shared libraries that link directly against the QuickJS C API with zero marshalling overhead. Extensions are fully compatible with snapshot/restore. Includes a proof-of-concept URL and URLSearchParams extension.

### Patch Changes

- [`3aff089`](https://github.com/vercel-labs/quickjs-wasi/commit/3aff0894fdd5c28faccf1f32bd20857922d486c7) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Increase WASM stack size to 1MB to prevent stack overflow traps. The default wasi-sdk stack (~173KB) was too small for QuickJS, causing hard WASM traps instead of catchable JS exceptions during recursive operations like JSON.stringify or devalue serialization at moderate depths.

## 0.2.0

### Minor Changes

- [`a8f453d`](https://github.com/vercel-labs/quickjs-wasi/commit/a8f453dbc3e5c74e8cf3bd1f81b0510282e6166d) Thanks [@TooTallNate](https://github.com/TooTallNate)! - **Breaking:** `HostFunction` type now uses TypeScript's `this` parameter instead of a leading `_this` argument. The `this` value from QuickJS is bound as the native `this` of the callback.

  Before:

  ```typescript
  vm.newFunction("add", (_this, ...args) => {
    return vm.newNumber(args[0].toNumber() + args[1].toNumber());
  });
  ```

  After:

  ```typescript
  vm.newFunction("add", (...args) => {
    return vm.newNumber(args[0].toNumber() + args[1].toNumber());
  });
  ```

  To access `this`, use a regular function declaration:

  ```typescript
  vm.newFunction("method", function (...args) {
    // `this` is the JSValueHandle for the QuickJS `this` value
    return this.getProp("name");
  });
  ```

- [`0316bfa`](https://github.com/vercel-labs/quickjs-wasi/commit/0316bfaeffdd23c5afe53d9a9246d196ab91b47e) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `QuickJS.serializeSnapshot()` and `QuickJS.deserializeSnapshot()` for converting snapshots to/from a versioned binary format suitable for persistent storage (S3, databases, etc.). The format includes a magic header and version number for forward compatibility. Apply your own compression (gzip, zstd) on top for best results.

- [`416a929`](https://github.com/vercel-labs/quickjs-wasi/commit/416a9293e96b43d6480b44315fe967bd12d22d43) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add Symbol support:

  - `vm.newSymbolFor(description)` — create global symbols (`Symbol.for()`)
  - `vm.setProp(obj, symbolHandle, value)` / `vm.getProp(obj, symbolHandle)` — get/set properties using symbol keys
  - `dump()` returns real host `Symbol.for(description)` for global symbols
  - `hostToHandle()` converts host `Symbol.for()` values to QuickJS global symbols
  - Local (anonymous) symbols dump as the string `"Symbol(description)"` and throw if passed to `hostToHandle()`

  This enables the Workflow DevKit `globalThis[Symbol.for("WORKFLOW_USE_STEP")]` pattern.

## 0.1.0

### Minor Changes

- [`ab32b36`](https://github.com/vercel-labs/quickjs-wasi/commit/ab32b3602131eab06b898fa0147afdf50e07cde4) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add ArrayBuffer and typed array marshalling: `vm.newArrayBuffer()`, `vm.newUint8Array()`, `handle.toArrayBuffer()`, `handle.toUint8Array()`. `dump()` returns proper `ArrayBuffer` / `Uint8Array` / typed array types. `hostToHandle()` converts `ArrayBuffer`, `Uint8Array`, and other typed arrays.

- [`e1b0a2f`](https://github.com/vercel-labs/quickjs-wasi/commit/e1b0a2fcdf9e505b195982fccbe81d0e30ef7fd3) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `Promise` support to `hostToHandle()`. Host Promises are automatically bridged to QuickJS promises via `Deferred`, with `executePendingJobs()` called on resolution/rejection.

- [`b5acb7b`](https://github.com/vercel-labs/quickjs-wasi/commit/b5acb7ba85403148a979529cfcadb648302f8f51) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `interruptHandler` option to `QuickJSOptions`. Called periodically during JS execution — return `true` to interrupt with an exception. Useful for implementing execution timeouts or step limits to prevent infinite loops. The VM remains usable after an interrupt.

- [`98c78be`](https://github.com/vercel-labs/quickjs-wasi/commit/98c78be76bdbf7c498938a84a285c03282b4f794) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `memoryLimit` option to `QuickJSOptions`. Restricts how much memory the QuickJS runtime can allocate — when exceeded, allocations fail and surface as JS exceptions. The limit is re-applied after `QuickJS.restore()`.

- [`d36fd2a`](https://github.com/vercel-labs/quickjs-wasi/commit/d36fd2abb749778ca1369e77bd8d74d0a69997c8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add configurable WASI clock via `QuickJSOptions.wasi`. The `wasi.now(clockId)` option controls both `Date.now()` / `new Date()` and the `Math.random()` PRNG seed at the engine level — no need to patch JS globals. QuickJS seeds its internal xorshift64\* PRNG from the clock value during context creation, so two VMs created with the same `now()` value produce identical `Math.random()` sequences.

### Patch Changes

- [`bd73bb6`](https://github.com/vercel-labs/quickjs-wasi/commit/bd73bb6af84f08622830167789cb34ba1b2a8c67) Thanks [@TooTallNate](https://github.com/TooTallNate)! - `dispose()` now releases all references to the WASM module, instance, and internal state so the WASM linear memory can be garbage collected. `JSValueHandle.dispose()` is safe to call after the VM has been disposed (becomes a no-op).

- [`3656ff6`](https://github.com/vercel-labs/quickjs-wasi/commit/3656ff6bb983e80da556d970c9f25bccbecc15c9) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix handle leaks on VM dispose: free cached singleton handles and internally-owned handles (unresolved promise resolve/reject functions). Make `Deferred.settled` lazy to avoid unnecessary QuickJS object allocation.

- [`4b4b81e`](https://github.com/vercel-labs/quickjs-wasi/commit/4b4b81ebb0ea8f8b527d53079245b5817eb1e18e) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Replace JSON.stringify hack in `dump()` with native property enumeration via `JS_GetOwnPropertyNames`. Handles circular references gracefully (returns `undefined`). Functions now dump as `undefined` instead of empty objects.

- [`ee7dd65`](https://github.com/vercel-labs/quickjs-wasi/commit/ee7dd65e230a9abf3eacd9fd7390d61b4a0f6ad5) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Preserve circular and shared references in `dump()`. Instead of returning `undefined` for circular references, `dump()` now returns the same host object — preserving the reference structure on the host side.

- [`972f0a4`](https://github.com/vercel-labs/quickjs-wasi/commit/972f0a4ce0783dd7753906952c4a9938288dec02) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Simplify `dispose()` to just mark the VM as unusable. The WASM instance and its linear memory are garbage collected by the host JS engine — no need to explicitly call `JS_FreeRuntime`. Removes `leakCheck` parameter from `dispose()`.
