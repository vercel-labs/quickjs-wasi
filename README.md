# quickjs-wasi

A snapshotable JavaScript runtime via WebAssembly. Runs [QuickJS](https://github.com/quickjs-ng/quickjs) compiled to WASM, with the ability to **snapshot the entire VM state** (including pending promises) and **restore it in a fresh WASM instance**.

## Install

```sh
npm install quickjs-wasi
```

## Usage

### Basic Evaluation

Both `QuickJS` and `JSValueHandle` implement `Symbol.dispose`, so you can use `using` declarations for automatic cleanup:

```typescript
import { QuickJS } from 'quickjs-wasi';

{
  using vm = await QuickJS.create(wasmBytes);

  // Evaluate code — handles are auto-disposed with `using`
  using result = vm.evalCode('1 + 2');
  console.log(result.toNumber()); // 3
} // vm and result are automatically disposed here
```

### Working with Values

```typescript
using vm = await QuickJS.create(wasmBytes);

// Create values — `using` ensures they're disposed at end of scope
{
  using str = vm.newString('hello');
  using num = vm.newNumber(42);
  using big = vm.newBigInt(9007199254740993n);
  vm.setProp(vm.global, 'message', str);
}

// Read back the value
using msg = vm.evalCode('message');
console.log(msg.toString()); // "hello"

// Convert host values to QuickJS handles (and back)
using handle = vm.hostToHandle({ x: 1, y: [2, 3] });
const dumped = vm.dump(handle); // { x: 1, y: [2, 3] }

// consume() is still useful for inline one-liners
const value = vm.evalCode('1 + 2').consume(h => h.toNumber()); // 3
```

### Host Functions

Register JavaScript functions backed by host (Node.js) callbacks:

```typescript
using vm = await QuickJS.create(wasmBytes);

// The first argument to the callback is always `this`
{
  using add = vm.newFunction('add', (...args) => {
    return vm.newNumber(args[0].toNumber() + args[1].toNumber());
  });
  vm.setProp(vm.global, 'add', add);
}

using result = vm.evalCode('add(3, 4)');
console.log(result.toNumber()); // 7
```

### Promises and Async Host Functions

Bridge async host operations into the QuickJS sandbox:

```typescript
using vm = await QuickJS.create(wasmBytes);

// Create an async host function that returns a promise to QuickJS
{
  using dnsResolve = vm.newFunction('dnsResolve', (...args) => {
    const hostname = args[0].toString();
    const deferred = vm.newPromise();

    // Do real async work on the host side
    dns.resolve4(hostname).then(
      (addresses) => {
        deferred.resolve(vm.newString(addresses[0]));
        vm.executePendingJobs(); // drain the QuickJS job queue
      },
      (err) => {
        deferred.reject(vm.newError(err));
        vm.executePendingJobs();
      }
    );

    return deferred.handle; // return the QuickJS promise
  });
  vm.setProp(vm.global, 'dnsResolve', dnsResolve);
}
```

### Error Handling

```typescript
using vm = await QuickJS.create(wasmBytes);

// evalCode() throws a JSException if the evaluated code throws
try {
  vm.evalCode('throw new TypeError("bad")');
} catch (err) {
  console.log(err.name);    // "TypeError"
  console.log(err.message); // "bad"
  console.log(err.stack);   // QuickJS stack trace
}

// Create errors from host Error objects (preserves name, message, stack)
{
  using errHandle = vm.newError(new RangeError('out of bounds'));
  vm.setProp(vm.global, 'hostError', errHandle);
}
```

### WASI Overrides

The `wasi` option lets you override any `wasi_snapshot_preview1` host function. It's a factory that receives the WASM linear memory and returns an object of override functions. Overrides apply to both the main module and all loaded extensions.

This is useful for deterministic execution — QuickJS uses a [xorshift64*](https://en.wikipedia.org/wiki/Xorshift) PRNG that is seeded once from the clock value during context creation. Override `clock_time_get` to control both `Date.now()` and the `Math.random()` seed:

```typescript
const fixedClock = (memory: WebAssembly.Memory) => ({
  clock_time_get(_clockId: number, _precision: bigint, resultPtr: number) {
    new DataView(memory.buffer).setBigUint64(resultPtr, 1700000000000n * 1_000_000n, true);
    return 0;
  },
});

using vm1 = await QuickJS.create({ wasm: wasmBytes, wasi: fixedClock });
using vm2 = await QuickJS.create({ wasm: wasmBytes, wasi: fixedClock });

vm1.evalCode('Math.random()').consume(h => h.toNumber());
// => 0.8130834347906803

vm2.evalCode('Math.random()').consume(h => h.toNumber());
// => 0.8130834347906803 (identical)
```

Override `random_get` to control the crypto extension's RNG:

```typescript
using vm = await QuickJS.create({
  wasm: wasmBytes,
  wasi: (memory) => ({
    random_get(bufPtr: number, bufLen: number) {
      new Uint8Array(memory.buffer, bufPtr, bufLen).fill(0x42); // deterministic
      return 0;
    },
  }),
  extensions: [cryptoExtension],
});
```

The time can also be advanced between calls for realistic behavior:

```typescript
let currentTime = 1700000000000n;
using vm = await QuickJS.create({
  wasm: wasmBytes,
  wasi: (memory) => ({
    clock_time_get(_clockId: number, _precision: bigint, resultPtr: number) {
      new DataView(memory.buffer).setBigUint64(resultPtr, currentTime * 1_000_000n, true);
      return 0;
    },
  }),
});

vm.evalCode('Date.now()').consume(h => h.toNumber()); // 1700000000000
currentTime += 1000n; // advance 1 second
vm.evalCode('Date.now()').consume(h => h.toNumber()); // 1700000001000
```

### Memory Limits

Restrict how much memory the QuickJS runtime can allocate. When exceeded, allocations fail and surface as JS exceptions:

```typescript
using vm = await QuickJS.create({
  wasm: wasmBytes,
  memoryLimit: 4 * 1024 * 1024, // 4 MB
});

vm.evalCode(`
  try {
    const huge = new Array(10000000).fill("x".repeat(1000));
  } catch (e) {
    console.log(e.message); // allocation failure
  }
`);
```

The limit is re-applied after `QuickJS.restore()`, so you can use a different limit for restored VMs than the original.

### Interrupt Handler

Prevent infinite loops and enforce execution timeouts:

```typescript
const start = Date.now();
using vm = await QuickJS.create({
  wasm: wasmBytes,
  interruptHandler: () => {
    // Return true to interrupt — called periodically during JS execution
    return Date.now() - start > 5000; // 5 second timeout
  },
});

try {
  vm.evalCode('while (true) {}');
} catch (err) {
  // JSException — interrupted
  err.dispose();
}

// VM is still usable after an interrupt
vm.evalCode('1 + 2').consume(h => h.toNumber()); // 3
```

The handler is called approximately once per JS bytecode instruction, so it should be fast. When it returns `true`, the current execution is interrupted and throws a `JSException`. The VM remains usable after an interrupt.

### Timezone Offset

By default, `Date` inside the sandbox mirrors the host environment's timezone. You can override this with a fixed offset or a dynamic callback:

```typescript
// Fixed offset: UTC-8 (480 minutes west of UTC)
using vm = await QuickJS.create({
  wasm: wasmBytes,
  timezoneOffset: 480,
});
vm.evalCode('new Date().getTimezoneOffset()').consume(h => h.toNumber()); // 480
```

```typescript
// Force UTC (offset 0)
using vm = await QuickJS.create({
  wasm: wasmBytes,
  timezoneOffset: 0,
});
```

```typescript
// Dynamic callback for custom DST-aware logic
using vm = await QuickJS.create({
  wasm: wasmBytes,
  timezoneOffset: (timeSecs) => {
    // Return offset in minutes (getTimezoneOffset convention: positive = west of UTC)
    return new Date(timeSecs * 1000).getTimezoneOffset();
  },
});
```

The `timezoneOffset` option accepts:

- **`'host'`** (default) — mirrors the host's timezone, including DST transitions.
- **A number** — fixed UTC offset in minutes using the `getTimezoneOffset()` sign convention (positive values are west of UTC, e.g. `480` for UTC-8).
- **A callback `(timeSecs: number) => number`** — called with seconds since epoch, must return the offset in minutes. Useful for custom timezone logic. The callback is invoked whenever QuickJS needs to convert between UTC and local time (e.g. `getHours()`, `toString()`, `new Date(year, month, ...)`, `getTimezoneOffset()`), so it may be called multiple times per Date operation.

### Snapshot and Restore

The key differentiator — snapshot the entire VM state and restore it later:

```typescript
let snapshot: Snapshot;

{
  using vm = await QuickJS.create(wasmBytes);

  // Build up some state, including a pending promise
  vm.evalCode(`
    globalThis.counter = 0;

    let __resolve;
    globalThis.pendingWork = new Promise(r => { __resolve = r; });
    globalThis.__resolve = __resolve;

    globalThis.pendingWork.then(value => {
      globalThis.counter = value;
    });
  `).dispose();
  vm.executePendingJobs();

  // Take a snapshot
  snapshot = vm.snapshot();
}

// Serialize to a binary buffer for storage (apply gzip on top for best compression)
const bytes = QuickJS.serializeSnapshot(snapshot);
await storage.put('snapshots/run-123', bytes);

// ... time passes, maybe a different process entirely ...

// Deserialize and restore
const loaded = await storage.get('snapshots/run-123');
const restored = QuickJS.deserializeSnapshot(loaded);

{
  using vm = await QuickJS.restore(restored, wasmBytes);

  // The pending promise still exists — resolve it
  using resolve = vm.global.getProp('__resolve');
  using arg = vm.newNumber(42);
  vm.callFunction(resolve, vm.undefined, arg).dispose();
  vm.executePendingJobs();

  // The .then handler ran in the restored VM
  using counter = vm.global.getProp('counter');
  console.log(counter.toNumber()); // 42
}
```

### Host Callbacks After Restore

Host functions registered with `newFunction()` are keyed by their name, which gets baked into the snapshot. After restoring, re-register the callbacks by name:

```typescript
let snapshot: Snapshot;

{
  using vm = await QuickJS.create(wasmBytes);
  using fn = vm.newFunction('hostAdd', (...args) => {
    return vm.newNumber(args[0].toNumber() + args[1].toNumber());
  });
  vm.setProp(vm.global, 'hostAdd', fn);
  snapshot = vm.snapshot();
}

{
  // After restore — re-register by name
  using vm = await QuickJS.restore(snapshot, wasmBytes);
  vm.registerHostCallback('hostAdd', (...args) => {
    return vm.newNumber(args[0].toNumber() + args[1].toNumber());
  });

  // hostAdd() works again
  using result = vm.evalCode('hostAdd(100, 200)');
  console.log(result.toNumber()); // 300
}
```

Note: each call to `newFunction()` must use a unique name. Attempting to register two host functions with the same name will throw an error.

### Native WASM Extensions

Load C-based extensions compiled as WASM shared libraries. Extensions link directly against the QuickJS C API with zero marshalling overhead — they share the same linear memory and can register custom classes, prototypes, and globals.

```typescript
import { QuickJS } from 'quickjs-wasi';
import { readFileSync } from 'fs';

const urlExt = readFileSync('./extensions/url/url.so');

using vm = await QuickJS.create({
  extensions: [{ name: 'url', wasm: urlExt }],
});

using result = vm.evalCode(`
  const url = new URL('https://example.com:8080/api?key=value#section');
  url.hostname // 'example.com'
`);
```

Extensions survive snapshot/restore — provide the same extensions when restoring:

```typescript
const snapshot = vm.snapshot();

using vm2 = await QuickJS.restore(snapshot, {
  extensions: [{ name: 'url', wasm: urlExt }],
});
// URL objects created before the snapshot still work
```

See [EXTENSIONS.md](./EXTENSIONS.md) for how to build extensions, how dynamic linking works, and known limitations.

## API Reference

### `QuickJS` (VM Instance)

| Method | Description |
|--------|-------------|
| `QuickJS.create(options?)` | Create a fresh VM instance |
| `QuickJS.restore(snapshot, options?)` | Restore a VM from a snapshot |
| `QuickJS.serializeSnapshot(snapshot)` | Serialize a snapshot to a versioned binary `Uint8Array` |
| `QuickJS.deserializeSnapshot(data)` | Deserialize a snapshot from a binary `Uint8Array` |
| `vm.evalCode(code, filename?)` | Evaluate JS code, returns `JSValueHandle` (throws `JSException` on error) |
| `vm.callFunction(fn, this, ...args)` | Call a QuickJS function (throws `JSException` on error) |
| `vm.executePendingJobs()` | Drain the promise microtask queue |
| `vm.newString(str)` | Create a string value |
| `vm.newNumber(num)` | Create a number value |
| `vm.newBigInt(val)` | Create a BigInt value |
| `vm.newObject()` | Create an empty object |
| `vm.newArray()` | Create an empty array |
| `vm.newSymbolFor(description)` | Create a global symbol (`Symbol.for(description)`) |
| `vm.newArrayBuffer(data)` | Create an ArrayBuffer from host `ArrayBuffer` or `Uint8Array` |
| `vm.newUint8Array(data)` | Create a Uint8Array from host `Uint8Array` |
| `vm.newFunction(name, callback)` | Create a function backed by a host callback |
| `vm.newPromise()` | Create a `Deferred` (promise + resolve/reject) |
| `vm.newError(messageOrError)` | Create an Error from a string or native `Error` |
| `vm.resolvePromise(handle)` | Await a QuickJS promise from the host side |
| `vm.setProp(obj, key, value)` | Set a property (key: string or handle, including symbols) |
| `vm.getProp(obj, key)` | Get a property using a handle key (including symbols) |
| `vm.typeof(handle)` | Get the `typeof` as a string |
| `vm.dump(handle)` | Convert a QuickJS value to a host value |
| `vm.hostToHandle(value)` | Convert a host value to a QuickJS handle |
| `vm.snapshot()` | Capture the entire VM state (including extension metadata) |
| `vm.registerHostCallback(name, fn)` | Re-register a host callback by name after restore |
| `vm.dispose()` | Free the VM |
| `vm[Symbol.dispose]()` | Same as `dispose()` — enables `using vm = ...` |

### `QuickJSOptions`

| Option | Description |
|--------|-------------|
| `wasm` | WASM module bytes or pre-compiled `WebAssembly.Module` |
| `wasi` | WASI override factory: `(memory) => ({ random_get, clock_time_get, ... })`. Applies to main module and all extensions |
| `memoryLimit` | Maximum memory the QuickJS runtime can allocate (bytes) |
| `interruptHandler` | Callback to interrupt execution (return `true` to stop) |
| `extensions` | Array of `ExtensionDescriptor` objects — native WASM extensions to load |
| `timezoneOffset` | Timezone for `Date` inside the VM: `'host'` (default), fixed offset in minutes, or `(timeSecs) => minutes` callback |

### `ExtensionDescriptor`

| Property | Description |
|----------|-------------|
| `name` | Identifier string (used in snapshot metadata) |
| `wasm` | WASM bytes (`BufferSource`) or pre-compiled `WebAssembly.Module` |
| `initFn?` | Init function name (default: `qjs_ext_${name}_init`) |
| `wasi?` | Extension-provided WASI overrides: `(memory) => ({...})`. Layered between built-in defaults and user overrides |

### Cached Properties

These are singleton handles — do **not** dispose them:

| Property | Value |
|----------|-------|
| `vm.global` | The global object |
| `vm.undefined` | `undefined` |
| `vm.null` | `null` |
| `vm.true` | `true` |
| `vm.false` | `false` |

### `JSValueHandle`

| Method / Property | Description |
|-------------------|-------------|
| `handle.isUndefined` | `true` if this is `undefined` |
| `handle.isNull` | `true` if this is `null` |
| `handle.promiseState` | `0` pending, `1` fulfilled, `2` rejected |
| `handle.toNumber()` | Extract as a `number` |
| `handle.toBigInt()` | Extract as a `bigint` |
| `handle.toString()` | Extract as a `string` |
| `handle.toArrayBuffer()` | Extract as an `ArrayBuffer` (copy from WASM memory) |
| `handle.toUint8Array()` | Extract as a `Uint8Array` (copy from WASM memory) |
| `handle.getProp(name)` | Get a property by name |
| `handle.setProp(name, value)` | Set a property by name |
| `handle.consume(fn)` | Call `fn(handle)`, then dispose, return result |
| `handle.dup()` | Duplicate the handle (increment refcount) |
| `handle.dispose()` | Free the handle |
| `handle[Symbol.dispose]()` | Same as `dispose()` — enables `using handle = ...` |

### `Deferred` (from `vm.newPromise()`)

| Property / Method | Description |
|--------------------|-------------|
| `deferred.handle` | The QuickJS promise object |
| `deferred.settled` | Host `Promise<void>` that resolves on settlement |
| `deferred.resolve(handle)` | Resolve the promise with a QuickJS value |
| `deferred.reject(handle)` | Reject the promise with a QuickJS value |

### Data Marshalling

`dump()` and `hostToHandle()` automatically convert values between the host and the QuickJS VM. The following types are supported:

| Host Type | QuickJS Type | `dump()` returns | `hostToHandle()` accepts |
|-----------|-------------|-----------------|------------------------|
| `undefined` | undefined | `undefined` | `undefined` |
| `null` | null | `null` | `null` |
| `boolean` | boolean | `boolean` | `boolean` |
| `number` | number | `number` | `number` |
| `string` | string | `string` | `string` |
| `bigint` | BigInt | `bigint` | `bigint` |
| `Symbol.for()` | global Symbol | `Symbol.for(description)` | `Symbol.for(description)` |
| `Error` | Error | `Error` (with name, message, stack) | `Error` |
| `Array` | Array | `Array` (recursive) | `Array` (recursive) |
| `ArrayBuffer` | ArrayBuffer | `ArrayBuffer` (copy) | `ArrayBuffer` |
| `Uint8Array` | Uint8Array | `Uint8Array` (copy) | `Uint8Array` |
| Other typed arrays | typed array | Corresponding typed array (copy) | `ArrayBuffer` (via view) |
| `Promise` | Promise | — | QuickJS Promise (bridged via `Deferred`) |
| Plain object | Object | `Record<string, unknown>` (recursive, own enumerable keys) | Object (recursive) |

**Notes:**

- Global symbols (`Symbol.for()`) round-trip as real host `Symbol` values via `Symbol.for(description)`
- Local (anonymous) symbols dump as `undefined` and throw if passed to `hostToHandle()`
- Functions dump as `undefined` (cannot be meaningfully serialized)
- Circular and shared references are preserved — `dump()` returns the same host object for the same QuickJS object pointer
- Only own enumerable string properties are included when dumping objects
- Binary data is always **copied** between host and WASM memory — there is no zero-copy view API
- `dump()` for typed arrays determines the host constructor from bytes-per-element (1 → `Uint8Array`, 2 → `Uint16Array`, 4 → `Uint32Array`, 8 → `Float64Array`)

## How It Works

### The Core Insight

WebAssembly linear memory is a flat byte array. Everything QuickJS allocates — the runtime struct, all contexts, all JS objects, the GC heap, the atom table, the promise job queue, pending promises — lives in this linear memory. There are no external pointers, file handles, or OS resources. When you copy the memory wholesale to a new WASM instance, all internal pointer relationships are preserved because they reference the same linear address space.

### One VM = One WASM Instance

Unlike quickjs-emscripten which has a two-level model (`QuickJSWASMModule` → `QuickJSContext`), quickjs-wasm uses a simpler one-level model: each `QuickJS.create()` call instantiates its own WASM module with its own linear memory, runtime, and context. This gives stronger isolation (no shared memory between VMs) and makes snapshotting clean — one instance, one context, one snapshot.

### Architecture

```
Host (Node.js / Deno / Bun / Browser)
 |
 +-- QuickJS class (ts/index.ts)
 |    |-- evalCode(), callFunction(), newFunction(), ...
 |    |-- snapshot() -> Snapshot { memory, stackPointer, runtimePtr, contextPtr }
 |    +-- restore(snapshot) -> QuickJS
 |
 +-- WASI Shim (ts/wasi-shim.ts)
 |    |-- clock_time_get, fd_write, random_get
 |    +-- fd_close, fd_fdstat_get, fd_seek (stubs)
 |
 +-- quickjs.wasm (1.4 MB)
      |-- QuickJS-NG engine
      +-- C interface layer (c/interface.c)
           |-- Lifecycle, eval, value creation/extraction
           |-- Host callback trampoline (imported host_call)
           +-- Snapshot support (get/set runtime and context pointers)
```

### Host Callback Mechanism

When `vm.newFunction(name, fn)` is called, a QuickJS C function is created via `JS_NewCFunctionData2` with the function name stored as a JS string in `func_data[0]`. When QuickJS code calls the function, the C trampoline extracts the name and calls the imported `host_call(name_ptr, name_len, this_ptr, argc, argv_ptr)` function, which dispatches to the registered host callback by name.

This design survives snapshot/restore: the name string is stored in QuickJS's heap (part of the snapshot), and after restore, `registerHostCallback(name, fn)` re-maps the name to a new host function. Because callbacks are keyed by name rather than sequential integer IDs, the registration order doesn't matter and adding or removing host functions won't silently break restore.

## Development

### Prerequisites

- [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) (tested with v30) — set `WASI_SDK` env var or defaults to `/tmp/wasi-sdk`
- Node.js >= 22
- pnpm

### Building Locally

```sh
# Clone with submodules
git clone --recursive https://github.com/vercel-labs/quickjs-wasm.git
cd quickjs-wasm

# Install wasi-sdk (macOS arm64 — adjust URL for your platform)
curl -sL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-30/wasi-sdk-30.0-arm64-macos.tar.gz" \
  | tar xz -C /tmp --strip-components=1 --one-top-level=wasi-sdk

# Install dependencies
pnpm install

# Build WASM binary + TypeScript
pnpm run build

# Run tests
pnpm test
```

## Technical Details

### WASM Binary

- Built from [quickjs-ng](https://github.com/quickjs-ng/quickjs) (MIT license)
- Compiled with wasi-sdk targeting `wasm32-wasip1` in reactor mode
- 1.4 MB uncompressed
- 7 WASM imports: 6 WASI functions + 1 `env.host_call` for host callbacks
- Exports `memory` and `__stack_pointer` for snapshot support

### What Gets Snapshotted

The snapshot captures the entire WASM linear memory, which contains:

- The `JSRuntime` struct (GC state, job queue, module loader state)
- The `JSContext` struct (global object, intrinsics, atom table)
- All JS objects (via QuickJS's GC heap)
- The promise job queue (pending `.then` callbacks)
- The string intern table (atoms)
- The `dlmalloc` heap metadata
- The C interface's `static JSRuntime *rt` and `static JSContext *ctx` globals
- Host callback IDs stored in function data

Plus the `__stack_pointer` WASM global (a single i32).

### Limitations and Future Work

- **Snapshot size**: Snapshots capture the entire WASM linear memory (~256 KB baseline, grows with heap). Use `serializeSnapshot()` to get a binary buffer, then apply your own compression (gzip/zstd) — the memory compresses very well due to large zero regions.
- **Stack size limit**: QuickJS-ng disables `JS_SetMaxStackSize` on WASI, so deep recursion causes a WASM trap (not a catchable exception).
- **ES Modules**: Only script-mode eval is supported. `import`/`export` and module loaders are not yet wired through.
- **Extension ABI**: Native WASM extensions use an experimental dynamic linking ABI that is [not yet stabilized](https://github.com/WebAssembly/tool-conventions/blob/main/DynamicLinking.md). All extensions must be compiled with the same wasi-sdk version as the main module. See [EXTENSIONS.md](./EXTENSIONS.md) for details.

### Browser Usage

quickjs-wasi works in browsers — the TypeScript API uses only the standard `WebAssembly` API and the WASI shim is environment-agnostic. The only Node.js-specific code is the default WASM loading fallback (which uses `node:fs`). In the browser, pass the WASM bytes directly:

```typescript
import { QuickJS } from 'quickjs-wasi';

// Fetch the .wasm file and compile it once
const response = await fetch('/quickjs.wasm');
const wasmModule = await WebAssembly.compileStreaming(response);

// Create VMs from the pre-compiled module (fast — no re-compilation)
using vm = await QuickJS.create({ wasm: wasmModule });
```

See [`examples/browser/`](./examples/browser/) for a complete Vite demo app.
