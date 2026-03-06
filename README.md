# quickjs-wasm

A snapshotable JavaScript runtime via WebAssembly. Runs [QuickJS](https://github.com/quickjs-ng/quickjs) compiled to WASM, with the ability to **snapshot the entire VM state** (including pending promises) and **restore it in a fresh WASM instance**.

## Motivation

The [Workflow DevKit](https://github.com/vercel/workflow) project implements durable function execution for TypeScript using an event-replay technique: workflow code is re-executed from the beginning on every resumption, with the full event log used as the source of truth for previously completed work. This approach has scaling limitations:

- As the event log grows, re-fetching it becomes expensive
- Replaying the full log takes increasingly longer
- There is an effective upper bound on how much work a workflow can do
- Running "forever" workflows is impractical

This project explores a fundamentally different approach: **VM snapshotting**. Instead of replaying from the beginning, we snapshot the JavaScript execution environment at each suspension point and restore it on resumption. The restored VM already has the correct state - only events since the last snapshot need to be fetched and applied.

## How It Works

### The Core Insight

WebAssembly linear memory is a flat byte array. Everything QuickJS allocates - the runtime struct, all contexts, all JS objects, the GC heap, the atom table, the promise job queue, pending promises - lives in this linear memory. There are no external pointers, file handles, or OS resources. When you copy the memory wholesale to a new WASM instance, all internal pointer relationships are preserved because they reference the same linear address space.

### Snapshot

When `snapshot()` is called on an idle VM (no C stack frames in flight):

1. The entire WASM linear memory is copied (`WebAssembly.Memory.buffer`)
2. The `__stack_pointer` WASM global is captured
3. The `JSRuntime*` and `JSContext*` pointer values are recorded
4. These are bundled into a serializable `Snapshot` object

### Restore

When `QuickJS.restore(snapshot)` is called:

1. A fresh WASM module is instantiated
2. The snapshot bytes are copied over the module's linear memory
3. The `__stack_pointer` global is restored
4. `qjs_set_runtime_and_context()` tells the C interface where the runtime/context live
5. **`_initialize()` and `qjs_init()` are NOT called** - the runtime already exists in memory

The restored VM has all previous JS state intact, including pending promises that can be resolved with new data.

### Architecture

```
Host (Node.js / Deno / Bun / Browser)
 |
 +-- QuickJS class (ts/index.ts)
 |    |-- evalCode(), newPromise(), callFunction(), executePendingJobs()
 |    |-- snapshot() -> Snapshot { memory, stackPointer, runtimePtr, contextPtr }
 |    +-- restore(snapshot) -> QuickJS
 |
 +-- WASI Shim (ts/wasi-shim.ts)
 |    |-- clock_time_get (for Date.now())
 |    |-- fd_write (for console output)
 |    |-- random_get (for Math.random)
 |    +-- fd_close, fd_fdstat_get, fd_seek (stubs)
 |
 +-- quickjs.wasm (1.4 MB)
      |-- QuickJS-NG engine (quickjs.c, dtoa.c, libregexp.c, libunicode.c)
      +-- Interface layer (c/interface.c)
           |-- qjs_init(), qjs_destroy()
           |-- qjs_eval(), qjs_new_promise(), qjs_call(), ...
           |-- qjs_get_runtime_ptr(), qjs_get_context_ptr()
           +-- qjs_set_runtime_and_context() (for restore)
```

## Project Structure

```
quickjs-wasm/
 |-- quickjs-ng/            # Git submodule: github.com/quickjs-ng/quickjs
 |-- c/
 |   +-- interface.c        # C wrapper exporting WASM-friendly functions
 |-- ts/
 |   |-- index.ts           # QuickJS + JSValueHandle classes with snapshot/restore
 |   +-- wasi-shim.ts       # Minimal WASI polyfill for universal WebAssembly compat
 |-- test/
 |   +-- snapshot.test.ts   # PoC tests including the snapshot/restore/promise test
 |-- Makefile               # Compiles quickjs-ng + interface.c -> quickjs.wasm
 |-- package.json
 +-- tsconfig.json
```

## Prerequisites

- [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) (tested with v30) - set `WASI_SDK` env var or it defaults to `/tmp/wasi-sdk`
- Node.js >= 22 (for `--experimental-strip-types`)
- pnpm

## Building

```sh
# Install wasi-sdk (if not already installed)
curl -sL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-30/wasi-sdk-30.0-arm64-macos.tar.gz" \
  | tar xz -C /tmp --strip-components=0
export WASI_SDK=/tmp/wasi-sdk-30.0-arm64-macos

# Clone with submodules
git clone --recursive <repo-url>
cd quickjs-wasm

# Install dependencies
pnpm install

# Build the WASM binary
make

# Run the tests
pnpm test
```

## Test Output

```
=== QuickJS WASM Snapshot/Restore PoC ===

--- Test: Basic Eval ---
  PASS: eval should not throw
  PASS: 1 + 2 should equal 3
  PASS: string concatenation works

--- Test: Promise Creation ---
  PASS: new promise should be pending (state 0)
  PASS: promiseResult should be undefined before resolve
  PASS: promise should be resolved with correct value

--- Test: Snapshot and Restore (Simple State) ---
  Snapshot size: 256 KB
  Memory pages: 4
  PASS: counter should be 42 after restore
  PASS: message should be preserved after restore
  PASS: can evaluate new code in restored VM

--- Test: Snapshot with Pending Promise (THE KEY TEST) ---
  PASS: stepResult should be "not yet" before snapshot
  Snapshot taken with pending promise
  Snapshot size: 256 KB
  Original VM disposed. Simulating resumption in a new process...
  PASS: stepResult should still be "not yet" after restore
  PASS: resolve function should be available after restore
  Executed 1 pending jobs after resolving promise
  Final stepResult: "completed: step-42-result"
  PASS: Promise .then handler should have executed in the restored VM!

=== Results: 13 passed, 0 failed ===
```

## Usage Example

```typescript
import { QuickJS } from './ts/index.ts';

// Create a VM and set up a pending promise
const vm = await QuickJS.create(wasmBytes);
const { promise, resolve } = vm.newPromise();
const global = vm.getGlobal();
global.setProp('waitForStep', promise);

vm.evalCode(`
  globalThis.result = null;
  waitForStep.then(value => {
    globalThis.result = "got: " + value;
  });
`);
vm.executePendingJobs();

// Snapshot the VM (promise is still pending)
const snapshot = vm.snapshot();
// snapshot.memory is a Uint8Array that can be persisted to S3, Redis, etc.

// ... time passes, process restarts ...

// Restore the VM and resolve the promise
const vm2 = await QuickJS.restore(snapshot, wasmBytes);
const global2 = vm2.getGlobal();
const restoredResolve = global2.getProp('__resolveFunc');
const arg = vm2.newString('step completed');
vm2.callFunction(restoredResolve, vm2.getUndefined(), arg);
vm2.executePendingJobs();

const result = global2.getProp('result');
console.log(result.toString()); // "got: step completed"
```

## Implications for Durable Workflows

This approach changes the fundamental execution model:

| | Event Replay (current) | VM Snapshot (this project) |
|---|---|---|
| **Resumption cost** | O(n) - replay full event log | O(1) - restore snapshot + fetch delta |
| **Event log growth** | Unbounded, all events needed | Can be trimmed after snapshot |
| **Long-running workflows** | Impractical at scale | No degradation over time |
| **State representation** | Implicit (derived from log) | Explicit (WASM memory snapshot) |
| **Snapshot size** | N/A | ~256 KB baseline, grows with JS heap |
| **Determinism requirement** | Yes (seeded PRNG, frozen time) | No (state is captured, not re-derived) |

The snapshot approach eliminates the need for deterministic replay entirely. The JS VM's state is the source of truth, not the event log. Events from before the snapshot are no longer needed at runtime - they're "baked in" to the snapshot.

## Technical Details

### WASM Binary

- Built from [quickjs-ng](https://github.com/quickjs-ng/quickjs) (MIT license)
- Compiled with wasi-sdk targeting `wasm32-wasip1` in reactor mode (`-mexec-model=reactor`)
- 1.4 MB uncompressed (~400 KB gzipped)
- Exports `memory` and `__stack_pointer` for snapshot support
- Only 6 WASI imports needed (shimmed in TypeScript)

### What Gets Snapshotted

The snapshot captures the entire WASM linear memory, which contains:

- The `JSRuntime` struct (GC state, job queue, module loader state)
- The `JSContext` struct (global object, intrinsics, atom table)
- All JS objects (via QuickJS's GC heap)
- The promise job queue (pending `.then` callbacks)
- The string intern table (atoms)
- The `dlmalloc` heap metadata
- The C interface's `static JSRuntime *rt` and `static JSContext *ctx` globals

Plus the `__stack_pointer` WASM global (a single i32).

### What Does NOT Need Snapshotting

- The WASM module's code section (immutable, same `.wasm` file on restore)
- The function table (part of the module, reconstructed on instantiation)
- WASI state (trivially re-created by the shim)

### Limitations and Future Work

- **Host callbacks**: The current PoC stores resolve/reject functions as JS globals. A production system would need a proper host function registry that can be re-mapped after restore.
- **Snapshot size**: Currently captures the entire linear memory. Could be optimized with sparse/delta encoding (only non-zero pages, like Wizer does).
- **Memory growth**: If the original VM grew its memory, the restored instance needs to match. Handled in the current implementation.
- **Compression**: Snapshots are raw bytes. gzip/brotli/zstd compression would significantly reduce storage and transfer costs.
- **Multiple contexts**: Currently supports a single JSRuntime + JSContext. Could be extended.
- **Browser compatibility**: The TypeScript wrapper uses only the standard `WebAssembly` API. The WASI shim is environment-agnostic. The only Node.js-specific code is the default WASM loading path (easily overridden by passing `wasmBytes` directly).
