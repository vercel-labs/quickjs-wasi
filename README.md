# quickjs-wasi

A snapshotable JavaScript runtime via WebAssembly. Runs [QuickJS](https://github.com/quickjs-ng/quickjs) compiled to WASM, with the ability to **snapshot the entire VM state** (including pending promises) and **restore it in a fresh WASM instance**.

## Motivation

The [Workflow DevKit](https://github.com/vercel/workflow) project implements durable function execution for TypeScript using an event-replay technique: workflow code is re-executed from the beginning on every resumption, with the full event log used as the source of truth for previously completed work. This approach has scaling limitations:

- As the event log grows, re-fetching it becomes expensive
- Replaying the full log takes increasingly longer
- There is an effective upper bound on how much work a workflow can do
- Running "forever" workflows is impractical

This project explores a fundamentally different approach: **VM snapshotting**. Instead of replaying from the beginning, we snapshot the JavaScript execution environment at each suspension point and restore it on resumption. The restored VM already has the correct state — only events since the last snapshot need to be fetched and applied.

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
  using result = vm.unwrapResult(vm.evalCode('1 + 2'));
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
using msg = vm.unwrapResult(vm.evalCode('message'));
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
  using add = vm.newFunction('add', (_this, ...args) => {
    return vm.newNumber(args[0].toNumber() + args[1].toNumber());
  });
  vm.setProp(vm.global, 'add', add);
}

using result = vm.unwrapResult(vm.evalCode('add(3, 4)'));
console.log(result.toNumber()); // 7
```

### Promises and Async Host Functions

Bridge async host operations into the QuickJS sandbox:

```typescript
using vm = await QuickJS.create(wasmBytes);

// Create an async host function that returns a promise to QuickJS
{
  using dnsResolve = vm.newFunction('dnsResolve', (_this, ...args) => {
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

// unwrapResult() throws a host Error if the eval/call produced an exception
try {
  vm.unwrapResult(vm.evalCode('throw new TypeError("bad")'));
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

### Snapshot and Restore

The key differentiator — snapshot the entire VM state and restore it later:

```typescript
let snapshot: Snapshot;

{
  using vm = await QuickJS.create(wasmBytes);

  // Build up some state, including a pending promise
  vm.unwrapResult(vm.evalCode(`
    globalThis.counter = 0;

    let __resolve;
    globalThis.pendingWork = new Promise(r => { __resolve = r; });
    globalThis.__resolve = __resolve;

    globalThis.pendingWork.then(value => {
      globalThis.counter = value;
    });
  `)).dispose();
  vm.executePendingJobs();

  // Take a snapshot — this is a plain object with a Uint8Array
  snapshot = vm.snapshot();
  // snapshot.memory can be persisted to S3, Redis, a database, etc.
}

// ... time passes, maybe a different process entirely ...

{
  // Restore the VM from the snapshot
  using vm = await QuickJS.restore(snapshot, wasmBytes);

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

Host functions registered with `newFunction()` are assigned integer IDs that get baked into the snapshot. After restoring, re-register the callbacks:

```typescript
let snapshot: Snapshot;

{
  using vm = await QuickJS.create(wasmBytes);
  // fn is assigned callback ID 1 (first registered callback)
  using fn = vm.newFunction('hostAdd', (_this, ...args) => {
    return vm.newNumber(args[0].toNumber() + args[1].toNumber());
  });
  vm.setProp(vm.global, 'hostAdd', fn);
  snapshot = vm.snapshot();
}

{
  // After restore — re-register with the same ID
  using vm = await QuickJS.restore(snapshot, wasmBytes);
  vm.registerHostCallback(1, (_this, ...args) => {
    return vm.newNumber(args[0].toNumber() + args[1].toNumber());
  });

  // hostAdd() works again
  using result = vm.unwrapResult(vm.evalCode('hostAdd(100, 200)'));
  console.log(result.toNumber()); // 300
}
```

### Sandboxed Execution (PAC Files)

quickjs-wasm can be used as a drop-in sandbox for running untrusted code, similar to how [pac-resolver](https://github.com/TooTallNate/proxy-agents/tree/main/packages/pac-resolver) uses quickjs-emscripten:

```typescript
using vm = await QuickJS.create(wasmBytes);

// Inject sandbox functions
{
  using isPlainHostName = vm.newFunction('isPlainHostName', (_this, ...args) => {
    const host = args[0].toString();
    return host.includes('.') ? vm.false : vm.true;
  });
  vm.setProp(vm.global, 'isPlainHostName', isPlainHostName);
}

// Evaluate untrusted PAC code
vm.unwrapResult(vm.evalCode(`
  function FindProxyForURL(url, host) {
    if (isPlainHostName(host)) return "DIRECT";
    return "PROXY proxy:8080";
  }
`)).dispose();

// Call it
{
  using fn = vm.global.getProp('FindProxyForURL');
  using url = vm.newString('http://intranet/');
  using host = vm.newString('intranet');
  using result = vm.unwrapResult(vm.callFunction(fn, vm.undefined, url, host));
  console.log(result.toString()); // "DIRECT"
}
```

## API Reference

### `QuickJS` (VM Instance)

| Method | Description |
|--------|-------------|
| `QuickJS.create(wasmInput?)` | Create a fresh VM instance |
| `QuickJS.restore(snapshot, wasmInput?)` | Restore a VM from a snapshot |
| `vm.evalCode(code, filename?)` | Evaluate JS code, returns `JSValueHandle` |
| `vm.unwrapResult(handle)` | Returns the handle if not an exception, otherwise throws |
| `vm.callFunction(fn, this, ...args)` | Call a QuickJS function |
| `vm.executePendingJobs()` | Drain the promise microtask queue |
| `vm.newString(str)` | Create a string value |
| `vm.newNumber(num)` | Create a number value |
| `vm.newBigInt(val)` | Create a BigInt value |
| `vm.newObject()` | Create an empty object |
| `vm.newArray()` | Create an empty array |
| `vm.newFunction(name, callback)` | Create a function backed by a host callback |
| `vm.newPromise()` | Create a `Deferred` (promise + resolve/reject) |
| `vm.newError(messageOrError)` | Create an Error from a string or native `Error` |
| `vm.resolvePromise(handle)` | Await a QuickJS promise from the host side |
| `vm.setProp(obj, key, value)` | Set a property on a QuickJS object |
| `vm.typeof(handle)` | Get the `typeof` as a string |
| `vm.dump(handle)` | Convert a QuickJS value to a host value |
| `vm.hostToHandle(value)` | Convert a host value to a QuickJS handle |
| `vm.snapshot()` | Capture the entire VM state |
| `vm.registerHostCallback(id, fn)` | Re-register a host callback after restore |
| `vm.dispose(leakCheck?)` | Free the VM |
| `vm[Symbol.dispose]()` | Same as `dispose()` — enables `using vm = ...` |

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
| `handle.isException` | `true` if this is an exception result |
| `handle.isUndefined` | `true` if this is `undefined` |
| `handle.isNull` | `true` if this is `null` |
| `handle.promiseState` | `0` pending, `1` fulfilled, `2` rejected |
| `handle.toNumber()` | Extract as a `number` |
| `handle.toBigInt()` | Extract as a `bigint` |
| `handle.toString()` | Extract as a `string` |
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

When `vm.newFunction()` is called, an integer ID is allocated and a QuickJS C function is created via `JS_NewCFunctionData2` with that ID stored as function data. When QuickJS code calls the function, the C trampoline extracts the ID and calls the imported `host_call(func_id, this_ptr, argc, argv_ptr)` function, which dispatches to the registered host callback by ID.

This design survives snapshot/restore: the ID is stored in QuickJS's heap (part of the snapshot), and after restore, `registerHostCallback(id, fn)` re-maps the ID to a new host function.

## Implications for Durable Workflows

| | Event Replay (current) | VM Snapshot (this project) |
|---|---|---|
| **Resumption cost** | O(n) — replay full event log | O(1) — restore snapshot + fetch delta |
| **Event log growth** | Unbounded, all events needed | Can be trimmed after snapshot |
| **Long-running workflows** | Impractical at scale | No degradation over time |
| **State representation** | Implicit (derived from log) | Explicit (WASM memory snapshot) |
| **Snapshot size** | N/A | ~256 KB baseline, grows with JS heap |
| **Determinism requirement** | Yes (seeded PRNG, frozen time) | No (state is captured, not re-derived) |

## Project Structure

```
quickjs-wasi/
 |-- quickjs-ng/            # Git submodule: github.com/quickjs-ng/quickjs
 |-- c/
 |   +-- interface.c        # C wrapper (~470 lines) exporting WASM functions
 |-- src/
 |   |-- index.ts           # QuickJS + JSValueHandle + Deferred
 |   +-- wasi-shim.ts       # Minimal WASI polyfill (6 functions)
 |-- dist/                  # Compiled JS + declarations (not committed)
 |-- quickjs.wasm           # Built WASM binary (not committed)
 |-- test/
 |   |-- snapshot.test.ts   # Core tests
 |   +-- pac-resolver/      # Integration tests (PAC file sandbox)
 |-- Makefile
 |-- package.json
 +-- tsconfig.json
```

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

- **Snapshot size**: Currently captures the entire linear memory (~256 KB baseline). Could be optimized with sparse/delta encoding (only non-zero pages).
- **Compression**: Snapshots are raw bytes. gzip/brotli/zstd compression would reduce storage costs.
- **Memory limits**: No `JS_SetMemoryLimit` or `JS_SetInterruptHandler` exposed yet. Needed for untrusted code sandboxing.
- **ES Modules**: Only script-mode eval is supported. `import`/`export` and module loaders are not yet wired through.
- **Object key enumeration**: `dump()` uses a JSON.stringify fallback for plain objects. Should expose `JS_GetOwnPropertyNames` for proper enumeration.
- **Browser compatibility**: The WASI shim and WebAssembly API usage should work in browsers, but the default WASM loading path uses `node:fs`. Pass `wasmBytes` directly for browser use.
