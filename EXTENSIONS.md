# Native WASM Extensions

quickjs-wasi supports loading native C extensions compiled as WebAssembly shared libraries. Extensions link directly against the QuickJS C API through WASM dynamic linking — they share the same linear memory, function table, and heap allocator as the main QuickJS module, so there is zero marshalling overhead when calling QuickJS APIs.

This enables implementing Web API polyfills (URL, FormData, Blob, etc.) and other performance-critical functionality in C rather than JavaScript, while keeping them loadable at runtime as separate `.so` files.

## Quick Start

### Using a Built-in Extension

The URL extension is available as a package sub-export:

```typescript
import { QuickJS } from 'quickjs-wasi';
import { urlExtension } from 'quickjs-wasi/url';

const vm = await QuickJS.create({
  extensions: [urlExtension],
});

vm.evalCode(`
  const url = new URL('https://example.com:8080/api?key=value');
  console.log(url.hostname); // 'example.com'
  console.log(url.port);     // '8080'

  const params = new URLSearchParams('a=1&b=2');
  console.log(params.get('a')); // '1'
`).dispose();
```

You can also load extensions manually from WASM bytes:

```typescript
import { QuickJS } from 'quickjs-wasi';
import { readFileSync } from 'fs';

const urlExt = readFileSync('./extensions/url/url.so');

const vm = await QuickJS.create({
  extensions: [{ name: 'url', wasm: urlExt }],
});
```

### Building an Extension

Extensions are C files that use the QuickJS C API, compiled with wasi-sdk as shared libraries:

```c
// my_extension.c
#include "quickjs.h"
#include <stdlib.h>

static JSValue js_hello(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    return JS_NewString(ctx, "Hello from a native extension!");
}

__attribute__((visibility("default")))
int qjs_ext_myext_init(JSContext *ctx, JSRuntime *rt) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue fn = JS_NewCFunction(ctx, js_hello, "hello", 0);
    JS_SetPropertyStr(ctx, global, "hello", fn);
    JS_FreeValue(ctx, global);
    return 0;
}
```

Compile with wasi-sdk:

```bash
# Compile with position-independent code
/tmp/wasi-sdk/bin/clang \
  --target=wasm32-wasip1 \
  --sysroot=/tmp/wasi-sdk/share/wasi-sysroot \
  -fPIC -O2 \
  -I path/to/quickjs-ng \
  -c my_extension.c -o my_extension.o

# Link as a shared library
/tmp/wasi-sdk/bin/wasm-ld \
  --shared \
  --no-entry \
  --export-dynamic \
  --allow-undefined \
  -o my_extension.so my_extension.o
```

Load it:

```typescript
const vm = await QuickJS.create({
  extensions: [{ name: 'myext', wasm: readFileSync('./my_extension.so') }],
});

vm.evalCode('hello()').consume(h => h.toString()); // "Hello from a native extension!"
```

## How It Works

### WASM Dynamic Linking

Extensions use the [WebAssembly dynamic linking convention](https://github.com/WebAssembly/tool-conventions/blob/main/DynamicLinking.md). The main `quickjs.wasm` module is a statically-linked WASI reactor that exports:

- **Memory** (`memory`) — the shared linear memory
- **Function table** (`__indirect_function_table`) — shared across all modules
- **Stack pointer** (`__stack_pointer`) — shared mutable global
- **QuickJS C API** — 200+ functions (`JS_NewClass`, `JS_SetPropertyStr`, `JS_Eval`, etc.)
- **libc** — `malloc`/`free`, string functions, math functions, formatting, etc.
- **Heap allocator** — `malloc`, `free`, `calloc`, `realloc`

Extensions are compiled as WASM shared libraries (`.so` files) with `-fPIC --shared`. They contain a `dylink.0` custom section that declares their memory and table requirements. When loaded, the extension loader:

1. **Parses `dylink.0`** to determine how much memory and table space the extension needs
2. **Allocates memory** for the extension's static data using `malloc` from the main module
3. **Grows the function table** to accommodate the extension's function pointers
4. **Resolves imports** — maps `env.*` imports to the main module's exports
5. **Instantiates** the extension WASM module with the shared memory and table
6. **Applies data relocations** (`__wasm_apply_data_relocs`) and calls constructors (`__wasm_call_ctors`)
7. **Calls the init function** (e.g., `qjs_ext_url_init(ctx, rt)`)

Because all modules share the same linear memory, a `JSContext*` pointer in the extension points to the same struct that QuickJS is using — there is no serialization or copying when calling QuickJS APIs.

### Extension Init Function

Each extension must export an init function. The default naming convention is `qjs_ext_<name>_init`, where `<name>` matches the `name` field in the `ExtensionDescriptor`. You can override this with the `initFn` option.

The init function receives the `JSContext*` and `JSRuntime*` pointers and should:

1. Register custom classes (`JS_NewClassID`, `JS_NewClass`)
2. Create prototypes and set property lists (`JS_SetClassProto`, `JS_SetPropertyFunctionList`)
3. Create constructors and set their `.prototype` property
4. Attach constructors/functions to the global object
5. Return `0` on success

```c
__attribute__((visibility("default")))
int qjs_ext_myext_init(JSContext *ctx, JSRuntime *rt) {
    // Register class, create prototype, attach to global...
    return 0;  // 0 = success
}
```

### Snapshot/Restore with Extensions

Extensions are fully compatible with the snapshot/restore system. The snapshot includes:

- **All linear memory** — this contains extension-allocated objects, class instances, prototypes, and the extension's static data
- **Extension metadata** — name, `memoryBase`, `tableBase`, and init function name for each loaded extension

When restoring from a snapshot:

1. **Memory is grown** to match the snapshot size
2. **Extensions are re-instantiated** with the **exact same** `memoryBase` and `tableBase` values — this reconstructs the function table identically
3. **Linear memory is overwritten** with the snapshot data — this restores all state, including extension objects
4. **Init functions are NOT called** — the state is already in the memory

This means:
- Objects created by extensions before the snapshot still work after restore
- New objects can be created after restore (the classes and prototypes are in memory)
- Extension code (the function table entries) is reconstructed deterministically

```typescript
// Create with extension, build state
const vm1 = await QuickJS.create({
  extensions: [{ name: 'url', wasm: urlExtBytes }],
});
vm1.evalCode(`
  globalThis.myUrl = new URL('https://example.com/api');
`).dispose();

// Snapshot
const bytes = QuickJS.serializeSnapshot(vm1.snapshot());
vm1.dispose();

// Restore — must provide same extensions in same order
const vm2 = await QuickJS.restore(QuickJS.deserializeSnapshot(bytes), {
  extensions: [{ name: 'url', wasm: urlExtBytes }],
});

// myUrl survived the snapshot
vm2.evalCode('myUrl.hostname').consume(h => h.toString()); // 'example.com'

// Can also create new URL objects
vm2.evalCode('new URL("https://other.com").hostname')
  .consume(h => h.toString()); // 'other.com'
```

## Writing Extensions

### Available APIs

Extensions can call any function exported by the main module. This includes:

**QuickJS C API** (200+ functions):
- Runtime/context: `JS_NewRuntime`, `JS_NewContext`, `JS_FreeValue`, `JS_DupValue`
- Values: `JS_NewString`, `JS_NewInt32`, `JS_NewFloat64`, `JS_NewObject`, `JS_NewArray`
- Properties: `JS_GetPropertyStr`, `JS_SetPropertyStr`, `JS_DefinePropertyValue`
- Classes: `JS_NewClassID`, `JS_NewClass`, `JS_SetClassProto`, `JS_GetClassProto`, `JS_NewObjectProtoClass`, `JS_SetOpaque`, `JS_GetOpaque`
- Functions: `JS_NewCFunction`, `JS_NewCFunction2`, `JS_NewCFunctionData`, `JS_Call`
- Errors: `JS_ThrowTypeError`, `JS_ThrowRangeError`, `JS_ThrowOutOfMemory`
- Type checking: `JS_IsString`, `JS_IsObject`, `JS_IsArray`, `JS_IsFunction`, etc.
- And many more — see [`quickjs.h`](https://github.com/quickjs-ng/quickjs/blob/master/quickjs.h) for the full API

**libc functions**:
- Memory: `malloc`, `free`, `calloc`, `realloc`, `memcpy`, `memset`, `memmove`, `memcmp`, `memchr`
- Strings: `strlen`, `strcmp`, `strncmp`, `strchr`, `strrchr`, `strstr`, `strcpy`, `strncpy`, `strcat`, `strncat`, `strdup`, `strtol`, `strtoul`, `strtod`, `atoi`, `atof`
- Characters: `isalpha`, `isalnum`, `isdigit`, `isxdigit`, `isspace`, `isprint`, `isupper`, `islower`, `toupper`, `tolower`
- Formatting: `snprintf`, `sprintf`, `vsnprintf`, `sscanf`
- Math: `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sqrt`, `pow`, `exp`, `log`, `log2`, `log10`, `fabs`, `floor`, `ceil`, `round`, `trunc`, `fmod`, `fmin`, `fmax`, `cbrt`, `exp2`, `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`, `copysign`, `ldexp`, `frexp`, `modf`, `remainder`
- Sorting: `qsort`, `bsearch`
- Other: `strerror`, `abort`

### Registering a Class

The typical pattern for registering a custom class with opaque C data:

```c
static JSClassID my_class_id;

static void my_class_finalizer(JSRuntime *rt, JSValue val) {
    MyData *data = JS_GetOpaque(val, my_class_id);
    if (data) {
        // Clean up your data
        free(data);
    }
}

static JSClassDef my_class_def = {
    "MyClass",
    .finalizer = my_class_finalizer,
};

static JSValue my_class_constructor(JSContext *ctx, JSValueConst new_target,
                                     int argc, JSValueConst *argv) {
    MyData *data = calloc(1, sizeof(MyData));
    if (!data) return JS_ThrowOutOfMemory(ctx);

    // Initialize data from arguments...

    JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
    JSValue obj = JS_NewObjectProtoClass(ctx, proto, my_class_id);
    JS_FreeValue(ctx, proto);

    if (JS_IsException(obj)) {
        free(data);
        return obj;
    }

    JS_SetOpaque(obj, data);
    return obj;
}

static JSValue my_getter(JSContext *ctx, JSValueConst this_val) {
    MyData *data = JS_GetOpaque(this_val, my_class_id);
    if (!data) return JS_EXCEPTION;
    return JS_NewString(ctx, data->some_field);
}

static const JSCFunctionListEntry my_proto_funcs[] = {
    JS_CGETSET_DEF("someField", my_getter, NULL),
};

// In your init function:
int qjs_ext_myext_init(JSContext *ctx, JSRuntime *rt) {
    JS_NewClassID(rt, &my_class_id);
    JS_NewClass(rt, my_class_id, &my_class_def);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, my_proto_funcs,
                               sizeof(my_proto_funcs) / sizeof(my_proto_funcs[0]));
    JS_SetClassProto(ctx, my_class_id, proto);

    JSValue ctor = JS_NewCFunction2(ctx, my_class_constructor, "MyClass", 1,
                                     JS_CFUNC_constructor, 0);
    // Important: set constructor.prototype so `new MyClass()` works
    JSValue proto_ref = JS_GetClassProto(ctx, my_class_id);
    JS_SetPropertyStr(ctx, ctor, "prototype", proto_ref);

    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "MyClass", ctor);
    JS_FreeValue(ctx, global);

    return 0;
}
```

### Compiler Flags

| Flag | Purpose |
|------|---------|
| `-fPIC` | **Required.** Position-independent code for shared libraries |
| `-O2` | Recommended optimization level |
| `-I path/to/quickjs-ng` | Include path for `quickjs.h` |
| `--target=wasm32-wasip1` | WASI target |
| `--sysroot=...` | wasi-sdk sysroot |

### Linker Flags

| Flag | Purpose |
|------|---------|
| `--shared` | **Required.** Produce a shared library with `dylink.0` section |
| `--no-entry` | No `main()` function |
| `--export-dynamic` | Export all non-hidden symbols |
| `--allow-undefined` | Allow unresolved symbols (resolved at load time against the main module) |

## Built-in Extensions

| Extension | Import | Provides |
|-----------|--------|----------|
| [URL](extensions/url/README.md) | `quickjs-wasi/url` | `URL`, `URLSearchParams` |
| [Encoding](extensions/encoding/README.md) | `quickjs-wasi/encoding` | `TextEncoder`, `TextDecoder` |
| [Base64](extensions/base64/README.md) | `quickjs-wasi/base64` | `atob()`, `btoa()`, `Uint8Array.fromBase64()`, `Uint8Array.fromHex()`, `.toBase64()`, `.toHex()`, `.setFromBase64()`, `.setFromHex()` |
| [Structured Clone](extensions/structured-clone/README.md) | `quickjs-wasi/structured-clone` | `structuredClone()` |
| [Crypto](extensions/crypto/README.md) | `quickjs-wasi/crypto` | `crypto`, `SubtleCrypto`, `CryptoKey` |
| [Headers](extensions/headers/README.md) | `quickjs-wasi/headers` | `Headers` |

See each extension's README for full API documentation.

## WASI Override Layering

Extensions that import `wasi_snapshot_preview1` functions (like the crypto extension importing `random_get`) receive WASI implementations from a three-layer merge:

1. **Built-in defaults** (lowest priority) — the implementations in `wasi-shim.ts`
2. **Extension-provided** — via `ExtensionDescriptor.wasi` factory
3. **User overrides** (highest priority) — via `QuickJSOptions.wasi` factory

This means an extension can ship its own WASI implementations, and users can still override them:

```typescript
// Extension ships its own random_get
const myExtension: ExtensionDescriptor = {
  name: 'my-ext',
  wasm: wasmBytes,
  wasi: (memory) => ({
    random_get(bufPtr, bufLen) {
      crypto.getRandomValues(new Uint8Array(memory.buffer, bufPtr, bufLen));
      return 0;
    },
  }),
};

// User overrides random_get for deterministic testing
const vm = await QuickJS.create({
  wasi: (memory) => ({
    random_get(bufPtr, bufLen) {
      new Uint8Array(memory.buffer, bufPtr, bufLen).fill(0x42);
      return 0;
    },
  }),
  extensions: [myExtension],
});
```

## Known Limitations

### Unstable ABI

The WASM dynamic linking convention is **not finalized**. Both `wasm-ld --shared` and `wasm-ld --pie` emit warnings:

```
wasm-ld: warning: creating shared libraries, with -shared, is not yet stable
```

The `dylink.0` section format and GOT conventions could change in a future wasi-sdk release. In practice, the convention has been stable since ~2020 (Emscripten uses the same format), but there is no formal stability guarantee.

### Same Toolchain Requirement

The main module and all extensions **must be compiled with the same wasi-sdk version**. If you upgrade wasi-sdk and rebuild `quickjs.wasm`, you must also rebuild all extensions. There is no versioning mechanism to detect mismatches — struct layouts, calling conventions, and symbol mangling could silently differ between toolchain versions.

The current build uses **wasi-sdk 30** (clang 21.1.4).

### No LTO for Extensions

The main module uses link-time optimization (`-flto`), but extensions cannot — LTO is incompatible with `-fPIC --shared` in wasi-sdk. Extension code will not be as aggressively optimized. For most extensions this is irrelevant, but compute-heavy extensions may notice a difference.

### Limited GOT Resolution

The loader resolves `GOT.func.*` entries by looking up functions in the main module's exports and adding them to the indirect function table. This allows extensions to call main-module functions via function pointers (e.g. `memset` used by mbedTLS). `GOT.mem.*` entries are zero-initialized — extensions that take the address of an external global variable may not work correctly.

### Snapshot Portability

A snapshot taken with extensions can **only** be restored with the exact same extensions, in the exact same order, compiled from the exact same source with the exact same toolchain. The snapshot stores raw memory addresses and function table indices — if any of these change (e.g., because an extension was recompiled), the restored snapshot will be corrupted.

### No Hot-Swapping

Extensions are loaded once at `QuickJS.create()` time and cannot be added, removed, or replaced on a running VM.

### Extensions Must Be Ordered Consistently

If you load extensions `[A, B]`, you must restore with `[A, B]` in the same order. The function table layout depends on loading order.

## Snapshot Format (Version 2)

Version 2 of the snapshot format adds extension metadata:

```
Offset  Size     Field
------  ----     -----
0       4        Magic: "QJSS" (0x514A5353, big-endian)
4       1        Version: 2
5       3        Reserved (zero)
8       4        Memory size in bytes (u32 LE)
12      4        Stack pointer (u32 LE)
16      4        Runtime pointer (u32 LE)
20      4        Context pointer (u32 LE)
24      4        Extension count (u32 LE)
28      ...      Extension entries (variable length):
                   nameLen (u32 LE)
                   name (UTF-8 bytes)
                   memoryBase (u32 LE)
                   tableBase (u32 LE)
                   initFnLen (u32 LE)
                   initFn (UTF-8 bytes)
N       memSize  Memory data
```

Version 1 snapshots (no extensions) are still supported for deserialization.
