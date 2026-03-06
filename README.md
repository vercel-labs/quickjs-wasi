# quickjs-wasm

A snapshotable JavaScript runtime via WebAssembly. Runs [QuickJS](https://github.com/quickjs-ng/quickjs) compiled to WASM, with the ability to **snapshot the entire VM state** (including pending promises) and **restore it in a fresh WASM instance**.

## Motivation

The [Workflow DevKit](https://github.com/vercel/workflow) project implements durable function execution for TypeScript using an event-replay technique: workflow code is re-executed from the beginning on every resumption, with the full event log used as the source of truth for previously completed work. This approach has scaling limitations:

- As the event log grows, re-fetching it becomes expensive
- Replaying the full log takes increasingly longer
- There is an effective upper bound on how much work a workflow can do
- Running "forever" workflows is impractical

This project explores a fundamentally different approach: **VM snapshotting**. Instead of replaying from the beginning, we snapshot the JavaScript execution environment at each suspension point and restore it on resumption. The restored VM already has the correct state — only events since the last snapshot need to be fetched and applied.

## Quick Start

```sh
pnpm install
make          # builds quickjs.wasm via wasi-sdk
pnpm test     # runs all 44 tests
```

## Usage

### Basic Evaluation

```typescript
import { QuickJS } from 'quickjs-wasm';

const vm = await QuickJS.create(wasmBytes);

// Evaluate code — returns a JSValueHandle
const result = vm.unwrapResult(vm.evalCode('1 + 2'));
console.log(result.toNumber()); // 3
result.dispose();

// Use cached properties for common values
console.log(vm.dump(vm.true));      // true
console.log(vm.dump(vm.null));      // null
console.log(vm.dump(vm.undefined)); // undefined

vm.dispose();
```

### Working with Values

```typescript
const vm = await QuickJS.create(wasmBytes);

// Create values
const str = vm.newString('hello');
const num = vm.newNumber(42);
const big = vm.newBigInt(9007199254740993n);
const obj = vm.newObject();
const arr = vm.newArray();

// Set properties on the global object
vm.setProp(vm.global, 'message', str);
vm.unwrapResult(vm.evalCode('message')).consume(h => {
  console.log(h.toString()); // "hello"
});

// Convert host values to QuickJS handles (and back)
const handle = vm.hostToHandle({ x: 1, y: [2, 3] });
const dumped = vm.dump(handle); // { x: 1, y: [2, 3] }

// Use consume() for automatic disposal
const value = vm.evalCode('1 + 2').consume(h => h.toNumber()); // 3

str.dispose();
num.dispose();
big.dispose();
obj.dispose();
arr.dispose();
handle.dispose();
vm.dispose();
```

### Host Functions

Register JavaScript functions backed by host (Node.js) callbacks:

```typescript
const vm = await QuickJS.create(wasmBytes);

// The first argument to the callback is always `this`
const add = vm.newFunction('add', (_this, ...args) => {
  return vm.newNumber(args[0].toNumber() + args[1].toNumber());
});
vm.setProp(vm.global, 'add', add);
add.dispose();

const result = vm.unwrapResult(vm.evalCode('add(3, 4)'));
console.log(result.toNumber()); // 7
result.dispose();
```

### Promises and Async Host Functions

Bridge async host operations into the QuickJS sandbox:

```typescript
const vm = await QuickJS.create(wasmBytes);

// Create an async host function that returns a promise to QuickJS
const dnsResolve = vm.newFunction('dnsResolve', (_this, ...args) => {
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
dnsResolve.dispose();
```

### Error Handling

```typescript
const vm = await QuickJS.create(wasmBytes);

// unwrapResult() throws a host Error if the eval/call produced an exception
try {
  vm.unwrapResult(vm.evalCode('throw new TypeError("bad")'));
} catch (err) {
  console.log(err.name);    // "TypeError"
  console.log(err.message); // "bad"
  console.log(err.stack);   // QuickJS stack trace
}

// Create errors from host Error objects (preserves name, message, stack)
const errHandle = vm.newError(new RangeError('out of bounds'));
vm.setProp(vm.global, 'hostError', errHandle);
errHandle.dispose();
```

### Snapshot and Restore

The key differentiator — snapshot the entire VM state and restore it later:

```typescript
const vm = await QuickJS.create(wasmBytes);

// Build up some state, including a pending promise
vm.unwrapResult(vm.evalCode(`
  globalThis.counter = 0;

  // Create a promise that will be resolved later
  let __resolve;
  globalThis.pendingWork = new Promise(r => { __resolve = r; });
  globalThis.__resolve = __resolve;

  globalThis.pendingWork.then(value => {
    globalThis.counter = value;
  });
`)).dispose();
vm.executePendingJobs();

// Take a snapshot — this is a plain object with a Uint8Array
const snapshot = vm.snapshot();
// snapshot.memory can be persisted to S3, Redis, a database, etc.
vm.dispose(false);

// ... time passes, maybe a different process entirely ...

// Restore the VM from the snapshot
const vm2 = await QuickJS.restore(snapshot, wasmBytes);

// The pending promise still exists — resolve it
const resolve = vm2.global.getProp('__resolve');
const arg = vm2.newNumber(42);
vm2.callFunction(resolve, vm2.undefined, arg).dispose();
vm2.executePendingJobs();
arg.dispose();
resolve.dispose();

// The .then handler ran in the restored VM
const counter = vm2.global.getProp('counter');
console.log(counter.toNumber()); // 42
counter.dispose();

vm2.dispose(false);
```

### Host Callbacks After Restore

Host functions registered with `newFunction()` are assigned integer IDs that get baked into the snapshot. After restoring, re-register the callbacks:

```typescript
// Before snapshot
const vm1 = await QuickJS.create(wasmBytes);
const fn = vm1.newFunction('hostAdd', (_this, ...args) => {
  return vm1.newNumber(args[0].toNumber() + args[1].toNumber());
});
// fn was assigned callback ID 1 (first registered callback)
vm1.setProp(vm1.global, 'hostAdd', fn);
fn.dispose();

const snapshot = vm1.snapshot();
vm1.dispose(false);

// After restore — re-register with the same ID
const vm2 = await QuickJS.restore(snapshot, wasmBytes);
vm2.registerHostCallback(1, (_this, ...args) => {
  return vm2.newNumber(args[0].toNumber() + args[1].toNumber());
});

// hostAdd() works again
const result = vm2.unwrapResult(vm2.evalCode('hostAdd(100, 200)'));
console.log(result.toNumber()); // 300
result.dispose();
vm2.dispose(false);
```

### Sandboxed Execution (PAC Files)

quickjs-wasm can be used as a drop-in sandbox for running untrusted code, similar to how [pac-resolver](https://github.com/nicolo-ribaudo/nicolo-ribaudo) uses quickjs-emscripten:

```typescript
const vm = await QuickJS.create(wasmBytes);

// Inject sandbox functions
const isPlainHostName = vm.newFunction('isPlainHostName', (_this, ...args) => {
  const host = args[0].toString();
  return host.includes('.') ? vm.false : vm.true;
});
vm.setProp(vm.global, 'isPlainHostName', isPlainHostName);
isPlainHostName.dispose();

// Evaluate untrusted PAC code
vm.unwrapResult(vm.evalCode(`
  function FindProxyForURL(url, host) {
    if (isPlainHostName(host)) return "DIRECT";
    return "PROXY proxy:8080";
  }
`)).dispose();

// Call it
const fn = vm.global.getProp('FindProxyForURL');
const url = vm.newString('http://intranet/');
const host = vm.newString('intranet');
const result = vm.unwrapResult(vm.callFunction(fn, vm.undefined, url, host));
console.log(result.toString()); // "DIRECT"

result.dispose();
fn.dispose();
url.dispose();
host.dispose();
vm.dispose(false);
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
quickjs-wasm/
 |-- quickjs-ng/            # Git submodule: github.com/quickjs-ng/quickjs
 |-- c/
 |   +-- interface.c        # C wrapper (~470 lines) exporting WASM functions
 |-- ts/
 |   |-- index.ts           # QuickJS + JSValueHandle + Deferred
 |   +-- wasi-shim.ts       # Minimal WASI polyfill (6 functions)
 |-- test/
 |   |-- snapshot.test.ts   # 30 core tests
 |   +-- pac-resolver/      # 14 integration tests (PAC file sandbox)
 |-- Makefile
 |-- package.json
 +-- tsconfig.json
```

## Prerequisites

- [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) (tested with v30) — set `WASI_SDK` env var or defaults to `/tmp/wasi-sdk`
- Node.js >= 22
- pnpm

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
