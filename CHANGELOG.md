# quickjs-wasi

## 3.0.1

### Patch Changes

- [#16](https://github.com/vercel-labs/quickjs-wasi/pull/16) [`5f80c0e`](https://github.com/vercel-labs/quickjs-wasi/commit/5f80c0eb44f521f866bb5ba223b00c1fbfcd4e99) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix value corruption when transferring objects/arrays containing `false`, `true`, `null`, or `undefined` into the VM via `hostToHandle`. These primitives resolve to cached singleton handles, and the object/array conversion disposed each value handle after `setProp`, freeing the singleton's shared heap `JSValue` and corrupting later reads (e.g. `false` showing up as `NaN`). Disposing a cached singleton handle is now a no-op.

- [`8944284`](https://github.com/vercel-labs/quickjs-wasi/commit/89442847cb984ee6d1eadc410d391143cba6f6c0) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Update QuickJS-ng from v0.15.0 to v0.15.1. This is an upstream bug-fix release: uncaught error dumps now walk the `cause` chain, and growable `SharedArrayBuffer`s are rejected when no SAB hooks are configured. No public API changes.

## 3.0.0

### Major Changes

- [`0c09620`](https://github.com/vercel-labs/quickjs-wasi/commit/0c0962057c5b25a93f1c8d170aff1992bfcf70bd) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Stop performing implicit filesystem I/O. The caller is now always responsible for providing the WASM bytes (or a pre-compiled `WebAssembly.Module`) for both the main runtime and any native extensions, using whichever loading mechanism is appropriate for their environment (`fetch()`, `node:fs/promises`, bundler imports, etc.).

  **Main runtime**

  The `wasm` option on `QuickJS.create()` / `QuickJS.restore()` is now required — the previous `node:fs/promises` fallback has been removed. A new `quickjs-wasi/quickjs.wasm` subpath export points to the published `.wasm` binary so callers can resolve it through their bundler or runtime.

  **Extensions**

  The Node-only convenience wrappers (`quickjs-wasi/url`, `quickjs-wasi/encoding`, `quickjs-wasi/base64`, `quickjs-wasi/headers`, `quickjs-wasi/crypto`, `quickjs-wasi/structured-clone`) have been removed. Each extension's compiled `.so` is now exposed directly via `quickjs-wasi/<name>.so` (e.g. `quickjs-wasi/url.so`, `quickjs-wasi/crypto.so`) so it can be loaded the same way as the main runtime.

  **Migration**

  ```ts
  // Before
  import { QuickJS } from "quickjs-wasi";
  import { urlExtension } from "quickjs-wasi/url";
  const vm = await QuickJS.create({ extensions: [urlExtension] });

  // After (Node)
  import { readFile } from "node:fs/promises";
  import { QuickJS } from "quickjs-wasi";

  const wasm = await readFile(
    new URL(import.meta.resolve("quickjs-wasi/quickjs.wasm"))
  );
  const urlSo = await readFile(
    new URL(import.meta.resolve("quickjs-wasi/url.so"))
  );

  const vm = await QuickJS.create({
    wasm,
    extensions: [{ name: "url", wasm: urlSo }],
  });

  // After (Vite / bundlers)
  import wasmUrl from "quickjs-wasi/quickjs.wasm?url";
  import urlSoUrl from "quickjs-wasi/url.so?url";

  const wasm = await WebAssembly.compileStreaming(fetch(wasmUrl));
  const urlSo = await fetch(urlSoUrl).then((r) => r.arrayBuffer());

  const vm = await QuickJS.create({
    wasm,
    extensions: [{ name: "url", wasm: urlSo }],
  });
  ```

### Minor Changes

- [`bb940f3`](https://github.com/vercel-labs/quickjs-wasi/commit/bb940f3516de16f26c4b0d42a6ef7d87d8523cb3) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Update QuickJS-ng from v0.13.0 to v0.15.0 (bumps through v0.14.0). Highlights:

  - **`atob()` / `btoa()` are now native built-ins.** They are controlled by a new `Intrinsics.ATOB_BTOA` flag, included in `Intrinsics.ALL` by default. Enabling this intrinsic also pulls in `DOMException` (errors thrown by these functions are `DOMException` instances).
  - **`Uint8Array` base64/hex methods** (`toBase64`, `fromBase64`, `toHex`, `fromHex`, `setFromBase64`, `setFromHex`) are now part of the native `TypedArrays` intrinsic.
  - **Explicit Resource Management** (`using` / `await using` in JavaScript) is now supported in the embedded VM.
  - New C API: `JS_GetPendingJobContext`, `JS_IsAsyncFunction`, `JS_NewUint64`, support for byte imports in modules, `JSON.parse` source text access.
  - Bug fixes for `Iterator.concat` reentrancy, fast array UAF + overflow, property set extensibility checks, atom leaks in `JS_NewSymbol`, big-endian builds, and stack-trace line numbers around `for/of` cleanup.

  **Breaking — `base64` extension removed.** The `quickjs-wasi/base64.so` subpath export has been deleted because every feature it provided is now native in the runtime. To migrate, drop the extension from your `extensions` array — `atob`, `btoa`, and the `Uint8Array` base64/hex methods are available unconditionally (assuming you have not disabled `Intrinsics.ATOB_BTOA` or `Intrinsics.TYPED_ARRAYS`).

  The WASM toolchain also bumps to wasi-sdk 32 (clang 22.1.0).

## 2.2.0

### Minor Changes

- [`4b6f034`](https://github.com/vercel-labs/quickjs-wasi/commit/4b6f034a4689d72d09decaa8e0b35586a28977fe) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `vm.compile()` and `vm.evalBytecode()` for bytecode compilation. Compile JavaScript source to a portable `Uint8Array` bytecode without executing it, then execute it later — even in a different VM instance. Also adds `CompileFlags.STRIP_SOURCE` and `CompileFlags.STRIP_DEBUG` for smaller bytecode output.

- [`f3f9556`](https://github.com/vercel-labs/quickjs-wasi/commit/f3f95565314a9119398c4b1dca05ec9f6ebaa075) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `timezoneOffset` option to `QuickJS.create()` for configuring the timezone used by `Date` inside the sandbox. Defaults to `'host'` which mirrors the host environment's timezone. Can also be set to a fixed offset in minutes or a callback for DST-aware logic.

- [`c37f38a`](https://github.com/vercel-labs/quickjs-wasi/commit/c37f38a1603cce5f5c4e216347ff73a47cc4fc04) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Expose `Crypto` and `SubtleCrypto` as global constructors in the crypto extension, matching the Web Crypto API spec. All three crypto constructors (`Crypto`, `SubtleCrypto`, `CryptoKey`) now throw `TypeError: Illegal constructor` when called with `new`, and support `instanceof` checks (e.g. `crypto instanceof Crypto`).

- [`6b99128`](https://github.com/vercel-labs/quickjs-wasi/commit/6b99128ff33c1ba26e927b2d48257928b5c4302b) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `vm.gcThreshold` getter/setter for controlling when automatic garbage collection triggers. When allocated memory exceeds the threshold, GC runs automatically. Set to 0 to disable.

- [`d82e66d`](https://github.com/vercel-labs/quickjs-wasi/commit/d82e66d6169d7842eb3e5258902ba5862963c9b2) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add introspection methods to `JSValueHandle` for inspecting QuickJS values without dumping them to host values. New type-checking getters: `isBool`, `isNumber`, `isString`, `isSymbol`, `isBigInt`, `isObject`, `isArray`, `isFunction`, `isError`, `isPromise`, `isArrayBuffer`. New convenience properties: `typeof`, `length`, `constructorName`. New methods: `keys()`, `getOwnPropertyNames()`, `hasOwnProperty()`, `propertyIsEnumerable()`, `getPrototypeOf()`.

- [`4811892`](https://github.com/vercel-labs/quickjs-wasi/commit/4811892474f85b083584129d93a89ba8892d227d) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `intrinsics` option to `QuickJS.create()` for controlling which built-in JavaScript features are available in the VM. Pass a bitmask of `Intrinsics.*` flags to create a minimal sandbox — for example, omit `Intrinsics.PROXY` to disallow `Proxy`, or omit `Intrinsics.DATE` to remove `Date`. Useful for security hardening or reducing memory usage. Note: `Intrinsics.EVAL` must be included for `vm.evalCode()` to work; without it, only pre-compiled bytecode via `vm.evalBytecode()` can be executed.

- [`ad61f8b`](https://github.com/vercel-labs/quickjs-wasi/commit/ad61f8b99d5fcb905f37a8761c88ac8c87726090) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `vm.getMemoryUsage()` method returning detailed memory statistics from the QuickJS runtime, including counts and sizes for atoms, strings, objects, properties, shapes, functions, arrays, and binary objects.

- [`59bc5b5`](https://github.com/vercel-labs/quickjs-wasi/commit/59bc5b570bc3f37a88dfaa75ffb793d1743f2626) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `moduleLoader` option for ES module support. Provides `normalize` and `load` callbacks that enable `import` statements to resolve and load modules. The callbacks are synchronous — for async module resolution, pre-fetch sources before creating the VM. Works with `QuickJS.create()` and `QuickJS.restore()`, and is compatible with snapshots (loaded modules survive, but the loader must be re-provided on restore for future imports).

- [`72d571b`](https://github.com/vercel-labs/quickjs-wasi/commit/72d571bc2895c67c40113d888b60077614be635c) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `onUnhandledRejection` option for tracking unhandled promise rejections. The callback receives the promise, rejection reason, and whether a handler was just attached. Works with both `QuickJS.create()` and `QuickJS.restore()`.

- [`f10db4d`](https://github.com/vercel-labs/quickjs-wasi/commit/f10db4d03d3debd12adf7a113e050f9be149c9d8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `vm.runGC()` method for explicitly triggering garbage collection. QuickJS runs GC automatically, but this is useful for reclaiming memory at a known point or before taking a snapshot.

- [`e127479`](https://github.com/vercel-labs/quickjs-wasi/commit/e127479408195cbc2eae9ef699625598f154f070) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `vm.versions` property returning version information for the runtime and loaded native libraries. Always includes `quickjs-wasi` (package version) and `quickjs` (engine version). Extensions can contribute additional entries by exporting a `qjs_ext_<name>_versions()` function — the built-in URL extension reports `ada` and the crypto extension reports `mbedtls`.

### Patch Changes

- [`309ec0b`](https://github.com/vercel-labs/quickjs-wasi/commit/309ec0b8b501edbd4c5789933ddd9a57bff037f9) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Make `prototype.constructor` non-enumerable on all extension classes (`URL`, `URLSearchParams`, `Headers`, `TextEncoder`, `TextDecoder`), matching the Web IDL spec. The property remains writable and configurable.

- [`32b1c38`](https://github.com/vercel-labs/quickjs-wasi/commit/32b1c3883e7c0cb2b9b25221a55ee4105c01f54c) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Make `JSValueHandle.vm` a public readonly property, allowing external code to access the QuickJS VM instance from any handle.

- [`7242e5d`](https://github.com/vercel-labs/quickjs-wasi/commit/7242e5d5d52308463097b033418fa46865bf4782) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Make `Constructor.prototype` non-writable, non-enumerable, and non-configurable on all extension constructors (`URL`, `URLSearchParams`, `Headers`, `TextEncoder`, `TextDecoder`, `CryptoKey`), matching the Web IDL spec for built-in interface objects.

- [`fbb40ee`](https://github.com/vercel-labs/quickjs-wasi/commit/fbb40ee87763adec3ee2370970d52c72756f5f21) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `Symbol.iterator` to `URLSearchParams.prototype`, aliased to `entries()` per the WHATWG URL spec. This makes `URLSearchParams` instances iterable with `for...of` and spread syntax.

## 2.1.0

### Minor Changes

- [`2cbdb4e`](https://github.com/vercel-labs/quickjs-wasi/commit/2cbdb4ebf4ab6265d80bc91f3f45dfc89e5070b7) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `EvalFlags` constants export and an optional `flags` parameter to `evalCode()`. The `EvalFlags.ASYNC` flag enables native top-level `await` support in evaluated scripts — the result is a Promise that resolves to the script's completion value. This is cleaner than wrapping code in an async IIFE, as it preserves last-expression-value semantics and avoids regex-based `await` detection.

- [`7c546ed`](https://github.com/vercel-labs/quickjs-wasi/commit/7c546ed4660a0182f76b4c1d15a55f262b189108) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add Uint8Array base64/hex methods to the base64 extension per the TC39 proposal-arraybuffer-base64 (Stage 4): `Uint8Array.prototype.toBase64()`, `Uint8Array.prototype.toHex()`, `Uint8Array.fromBase64()`, `Uint8Array.fromHex()`, `Uint8Array.prototype.setFromBase64()`, and `Uint8Array.prototype.setFromHex()`.

- [`3c57e14`](https://github.com/vercel-labs/quickjs-wasi/commit/3c57e1451f9291fb81be7ea35fc76d1a4c4162ed) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Update QuickJS-ng from v0.12.1 to v0.13.0. Includes bug fixes for FinalizationRegistry, async generators, regex engine, Iterator, and TypedArray, as well as performance improvements for String.prototype.concat, Promise creation, regexp operations, and context creation.

## 2.0.1

### Patch Changes

- [`f5261ba`](https://github.com/vercel-labs/quickjs-wasi/commit/f5261baea594415857923be7bc4cfbaf264b257e) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `./package.json` sub-export to the exports map

- [`73c323d`](https://github.com/vercel-labs/quickjs-wasi/commit/73c323d73675428b2d8d388295ae229b03be783c) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Replace `-` with `_` in extension name when deriving the default `initFn`, since hyphens are not valid in C function names

## 2.0.0

### Major Changes

- [`d231c61`](https://github.com/vercel-labs/quickjs-wasi/commit/d231c61b843cfd4828c937dcf5316ce0b7ecc857) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Replace opaque integer callback IDs with string names for host callbacks. `registerHostCallback()` now takes the function name instead of a numeric ID, making restore order-independent and self-documenting. `newFunction()` enforces unique names to prevent silent conflicts.

### Patch Changes

- [`0a32dbb`](https://github.com/vercel-labs/quickjs-wasi/commit/0a32dbb27c3bf46413f09a9b3bf11fac270657bc) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Use `new URL(import.meta.url)` pattern in extension files for consistent `@vercel/nft` asset tracing

- [`4f7bcb2`](https://github.com/vercel-labs/quickjs-wasi/commit/4f7bcb2c4ef94e3846926171a3cfe071aed22e77) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Rebuild WASM artifacts with wasi-sdk 32 (clang 22.1.0), upgraded from wasi-sdk 30 (clang 21.1.4).

## 1.3.0

### Minor Changes

- [`a1f46b5`](https://github.com/vercel-labs/quickjs-wasi/commit/a1f46b5c4bae0e00da0140325dfafe901733983f) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add Web Crypto API extension (`quickjs-wasi/crypto`) backed by mbedTLS 4.0 PSA Crypto

  - **New extension**: `crypto` global with `getRandomValues()`, `randomUUID()`, and full `SubtleCrypto` support

    - Digest: SHA-1, SHA-256, SHA-384, SHA-512
    - Sign/verify: HMAC, ECDSA (P-256/P-384/P-521), Ed25519, RSASSA-PKCS1-v1_5, RSA-PSS
    - Encrypt/decrypt: AES-GCM, AES-CBC, AES-CTR, RSA-OAEP
    - Key generation: all above algorithms plus AES-KW, ECDH, X25519
    - Key import/export: raw, pkcs8, spki formats
    - Key derivation: HKDF, PBKDF2, ECDH, X25519
    - Key wrapping: wrapKey/unwrapKey via encrypt/decrypt
    - CryptoKey class with type, extractable, algorithm, usages properties

  - **WASI override system**: the `wasi` option on `QuickJSOptions` is now a factory function `(memory: WebAssembly.Memory) => Record<string, Function>` that can override any `wasi_snapshot_preview1` host function. Overrides apply to both the main module and all extensions. Extensions can also provide their own WASI implementations via `ExtensionDescriptor.wasi`. Three-layer precedence: built-in defaults < extension-provided < user overrides.

  - **Extension loader improvements**:

    - Extensions that import `wasi_snapshot_preview1` functions now receive the shared WASI shim (no more duplicated implementations)
    - `GOT.func` entries are now resolved by adding main-module functions to the indirect function table, enabling extensions that use function pointers to libc functions (e.g. `memset`)

  - **Browser playground**: added Crypto toggle to the extension toolbar

  - **Breaking change**: `WasiOptions` is now a factory function instead of an object with a `now()` method. Migration: `{ now: () => timeNs }` becomes `(memory) => ({ clock_time_get(_clockId, _precision, resultPtr) { new DataView(memory.buffer).setBigUint64(resultPtr, timeNs, true); return 0; } })`

### Patch Changes

- [`a672f58`](https://github.com/vercel-labs/quickjs-wasi/commit/a672f589215b4255bd520dbee3e1929eafb8ba5a) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix `resolveModule()` to use `new URL()` pattern recognized by `@vercel/nft`, ensuring `quickjs.wasm` is included in traced file lists

## 1.2.0

### Minor Changes

- [`79d04f1`](https://github.com/vercel-labs/quickjs-wasi/commit/79d04f1c7cede01d3e5326898b4c210d8de40469) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `defineProp()` method on both `QuickJS` and `JSValueHandle` for defining properties with explicit descriptor flags (`writable`, `enumerable`, `configurable`), similar to `Object.defineProperty()`. Accepts string or `JSValueHandle` keys, supporting symbols.

- [`13f0b33`](https://github.com/vercel-labs/quickjs-wasi/commit/13f0b3310e2c4520c4fc1b11f90113e42b469807) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add native WASM `Headers` extension implementing the WHATWG Fetch Standard Headers API. Supports constructor (record, sequence, or Headers init), `append`, `delete`, `get`, `getSetCookie`, `has`, `set`, `entries`, `keys`, `values`, `forEach`, and `Symbol.iterator` with spec-compliant case-insensitive name matching, value normalization, sorted iteration, and Set-Cookie handling.

### Patch Changes

- [`c2c8009`](https://github.com/vercel-labs/quickjs-wasi/commit/c2c80098dfaeb45250024e62f38141320e3a08d9) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix native extension global property descriptors to match web browser behavior. `TextEncoder`, `TextDecoder`, `URL`, and `URLSearchParams` are now defined as writable and configurable but not enumerable on `globalThis`, matching how browsers define them. `btoa`, `atob`, and `structuredClone` were already correct.

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

  This enables the Workflow SDK `globalThis[Symbol.for("WORKFLOW_USE_STEP")]` pattern.

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
