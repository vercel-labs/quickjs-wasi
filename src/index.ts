/**
 * QuickJS WASM - A snapshotable JavaScript runtime via WebAssembly.
 *
 * Provides a clean JavaScript API for running sandboxed JS code in a QuickJS
 * VM compiled to WASM. The key differentiator is the ability to snapshot the
 * entire VM state (including pending promises) and restore it in a fresh
 * WASM instance.
 */

import { createWasiShim, type WasiOptions } from './wasi-shim.js';
import {
  loadExtension,
  initExtension,
  restoreExtensions,
  type ExtensionDescriptor,
  type LoadedExtension,
  type WasiImports,
} from './extensions.js';

// ---- Public types ----

export type HostFunction = (this: JSValueHandle, ...args: JSValueHandle[]) => JSValueHandle;

/** Property descriptor flags for `defineProp()`. */
export interface JSPropertyDescriptor {
  writable?: boolean;
  enumerable?: boolean;
  configurable?: boolean;
}

export type { WasiOptions };
export type { ExtensionDescriptor, LoadedExtension, DylinkInfo, WasiImports } from './extensions.js';

/**
 * Flags for `evalCode()`, matching the QuickJS `JS_EVAL_*` constants.
 */
export const EvalFlags = {
  /** Global script mode (default). */
  TYPE_GLOBAL: 0 as const,
  /** Module mode. */
  TYPE_MODULE: (1 << 0) as 1,
  /** Force strict mode. */
  STRICT: (1 << 3) as 8,
  /** Compile only — do not execute. */
  COMPILE_ONLY: (1 << 5) as 32,
  /** Omit stack frames before this eval from Error backtraces. */
  BACKTRACE_BARRIER: (1 << 6) as 64,
  /**
   * Allow top-level `await` in global scripts. When used, `evalCode()`
   * returns a handle to a Promise that resolves to the completion value.
   * Use together with `executePendingJobs()` and `resolvePromise()`.
   */
  ASYNC: (1 << 7) as 128,
} as const;

export interface QuickJSOptions {
  /** WASM module bytes or pre-compiled module. If omitted, loads from the package. */
  wasm?: BufferSource | WebAssembly.Module;
  /** Custom WASI function implementations. */
  wasi?: WasiOptions;
  /**
   * Maximum memory the QuickJS runtime can allocate, in bytes.
   * When exceeded, allocations fail and surface as JS exceptions
   * (e.g. `InternalError: out of memory`).
   */
  memoryLimit?: number;
  /**
   * Called periodically during JS execution. Return `true` to interrupt
   * the current execution with an `InternalError: interrupted` exception.
   * Useful for implementing execution timeouts or step limits.
   *
   * The handler is called approximately once per JS bytecode instruction,
   * so it should be fast.
   */
  interruptHandler?: () => boolean;
  /**
   * Native WASM extensions to load. Each extension is a WASM shared library
   * (.so) compiled with wasi-sdk that links against the QuickJS C API.
   *
   * Extensions are loaded in order and their init functions are called
   * after the QuickJS runtime is initialized. The same extensions (in the
   * same order) must be provided when restoring from a snapshot.
   */
  extensions?: ExtensionDescriptor[];
}

// ---- WASM Export Types ----

interface QuickJSExports {
  memory: WebAssembly.Memory;
  __stack_pointer: WebAssembly.Global;
  __indirect_function_table: WebAssembly.Table;
  _initialize(): void;

  // Lifecycle
  qjs_init(): number;
  qjs_destroy(): void;

  // Evaluation
  qjs_eval(codePtr: number, codeLen: number, filenamePtr: number, flags: number): number;

  // Value creation
  qjs_new_string(strPtr: number, strLen: number): number;
  qjs_new_number(num: number): number;
  qjs_new_object(): number;
  qjs_new_array(): number;
  qjs_get_undefined(): number;
  qjs_get_null(): number;
  qjs_get_true(): number;
  qjs_get_false(): number;

  // BigInt
  qjs_new_big_int64(lo: number, hi: number): number;
  qjs_get_big_int64(valPtr: number, loOutPtr: number, hiOutPtr: number): number;

  // Value extraction
  qjs_get_float64(valPtr: number): number;
  qjs_get_string(valPtr: number): number;
  qjs_free_cstring(strPtr: number): void;
  qjs_typeof(valPtr: number): number;
  qjs_is_exception(valPtr: number): number;
  qjs_is_undefined(valPtr: number): number;
  qjs_is_null(valPtr: number): number;
  qjs_is_bool(valPtr: number): number;
  qjs_is_number(valPtr: number): number;
  qjs_is_string(valPtr: number): number;
  qjs_is_object(valPtr: number): number;
  qjs_is_array(valPtr: number): number;
  qjs_is_function(valPtr: number): number;
  qjs_is_error(valPtr: number): number;
  qjs_is_promise(valPtr: number): number;
  qjs_is_symbol(valPtr: number): number;
  qjs_is_big_int(valPtr: number): number;
  qjs_is_array_buffer(valPtr: number): number;
  qjs_get_bool(valPtr: number): number;

  // Symbol
  qjs_new_symbol(descPtr: number, descLen: number, isGlobal: number): number;
  qjs_get_symbol_description(valPtr: number, descOutPtr: number): number;

  // Property access by value (for symbol keys)
  qjs_get_prop_value(objPtr: number, keyPtr: number): number;
  qjs_set_prop_value(objPtr: number, keyPtr: number, valPtr: number): number;

  // ArrayBuffer / TypedArray
  qjs_new_array_buffer(dataPtr: number, len: number): number;
  qjs_get_array_buffer(valPtr: number, lenOutPtr: number): number;
  qjs_new_uint8_array(dataPtr: number, len: number): number;
  qjs_get_typed_array_buffer(valPtr: number, byteOffsetOutPtr: number, byteLengthOutPtr: number, bytesPerElementOutPtr: number): number;

  // Value management
  qjs_dup_value(valPtr: number): number;
  qjs_free_value(valPtr: number): void;

  // Property operations
  qjs_get_global(): number;
  qjs_get_prop_string(objPtr: number, namePtr: number): number;
  qjs_set_prop_string(objPtr: number, namePtr: number, valPtr: number): number;
  qjs_define_prop_string(objPtr: number, namePtr: number, valPtr: number, flags: number): number;
  qjs_define_prop_value(objPtr: number, keyPtr: number, valPtr: number, flags: number): number;
  qjs_get_prop_uint32(objPtr: number, idx: number): number;
  qjs_set_prop_uint32(objPtr: number, idx: number, valPtr: number): number;
  qjs_get_own_property_names(objPtr: number): number;
  qjs_get_own_property_names_all(objPtr: number): number;
  qjs_has_own_property(objPtr: number, namePtr: number): number;
  qjs_property_is_enumerable(objPtr: number, namePtr: number): number;
  qjs_get_prototype_of(objPtr: number): number;
  qjs_get_value_ptr(valPtr: number): number;

  // Function calls
  qjs_call(funcPtr: number, thisPtr: number, argc: number, argvPtr: number): number;

  // Host function registration
  qjs_new_host_function(namePtr: number, nameLen: number, argCount: number): number;

  // Promise operations
  qjs_new_promise(resolveOutPtr: number, rejectOutPtr: number): number;
  qjs_promise_state(promisePtr: number): number;
  qjs_promise_result(promisePtr: number): number;

  // Job queue
  qjs_is_job_pending(): number;
  qjs_execute_pending_job(): number;

  // Error handling
  qjs_get_exception(): number;
  qjs_new_error(): number;
  qjs_throw(valPtr: number): number;

  // Runtime limits
  qjs_set_memory_limit(limit: number): void;
  qjs_set_max_stack_size(size: number): void;
  qjs_set_interrupt_handler(enable: number): void;

  // Snapshot support
  qjs_get_runtime_ptr(): number;
  qjs_get_context_ptr(): number;
  qjs_set_runtime_and_context(rtPtr: number, ctxPtr: number): void;

  // Memory management
  malloc(size: number): number;
  free(ptr: number): void;
  wasm_malloc(size: number): number;
  wasm_free(ptr: number): void;
}

// ---- Snapshot format ----

/** Metadata about an extension saved in a snapshot */
export interface SnapshotExtension {
  name: string;
  memoryBase: number;
  tableBase: number;
  initFn: string;
}

export interface Snapshot {
  /** The raw WASM linear memory contents */
  memory: Uint8Array;
  /** The stack pointer value at snapshot time */
  stackPointer: number;
  /** Pointer to JSRuntime in the WASM memory */
  runtimePtr: number;
  /** Pointer to JSContext in the WASM memory */
  contextPtr: number;
  /** Metadata about loaded extensions (empty if none) */
  extensions: SnapshotExtension[];
}

// ---- Snapshot serialization ----

/** Magic bytes: "QJSS" (QuickJS Snapshot) */
const SNAPSHOT_MAGIC = 0x514A5353;
/** Current serialization format version (2 = added extension metadata) */
const SNAPSHOT_VERSION = 2;
/**
 * Header layout (version 2):
 *   0-3:   Magic "QJSS" (u32 big-endian)
 *   4:     Version (u8)
 *   5-7:   Reserved (zero)
 *   8-11:  Memory size in bytes (u32 little-endian)
 *   12-15: Stack pointer (u32 little-endian)
 *   16-19: Runtime pointer (u32 little-endian)
 *   20-23: Context pointer (u32 little-endian)
 *   24-27: Extension count (u32 little-endian)
 *   28+:   Extension entries (variable length):
 *          nameLen(u32) + name(utf8) + memoryBase(u32) + tableBase(u32) + initFnLen(u32) + initFn(utf8)
 *   N+:    Memory data (N = memory size from offset 8)
 *
 * Version 1 (legacy): no extension metadata, memory starts at offset 24.
 */
const SNAPSHOT_HEADER_SIZE = 24;

// ---- Deferred promise type ----

export interface Deferred {
  /** Handle to the QuickJS promise object */
  handle: JSValueHandle;
  /** A host-side Promise that resolves when the QuickJS promise settles */
  settled: Promise<void>;
  /** Resolve the QuickJS promise with a value */
  resolve(value: JSValueHandle): void;
  /** Reject the QuickJS promise with a value */
  reject(value: JSValueHandle): void;
}

// ---- QuickJS VM ----

export class QuickJS {
  private exports: QuickJSExports;
  private module: WebAssembly.Module;
  private instance: WebAssembly.Instance;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private disposed = false;

  /** Registry of host callbacks, keyed by function name */
  private hostCallbacks = new Map<string, HostFunction>();
  /** Counter for internal-only callbacks (e.g. promise settle handlers) */
  private nextInternalId = 1;
  private interruptHandler: (() => boolean) | null = null;

  // Cached singleton handles
  private _global: JSValueHandle | null = null;
  private _undefined: JSValueHandle | null = null;
  private _null: JSValueHandle | null = null;
  private _true: JSValueHandle | null = null;
  private _false: JSValueHandle | null = null;

  // Handles that must be freed on dispose (e.g. unresolved promise resolve/reject functions)
  private _ownedHandles = new Set<JSValueHandle>();

  /** Loaded extensions in deterministic order */
  private loadedExtensions: LoadedExtension[] = [];

  private constructor(module: WebAssembly.Module) {
    this.module = module;
    this.instance = null!;
    this.exports = null!;
  }

  private setInstance(instance: WebAssembly.Instance) {
    this.instance = instance;
    this.exports = instance.exports as unknown as QuickJSExports;
  }

  // ---- Cached property accessors ----

  /** The global object. Cached — do not dispose. */
  get global(): JSValueHandle {
    if (!this._global) {
      this._global = new JSValueHandle(this, this.exports.qjs_get_global());
    }
    return this._global;
  }

  /** The undefined value. Cached — do not dispose. */
  get undefined(): JSValueHandle {
    if (!this._undefined) {
      this._undefined = new JSValueHandle(this, this.exports.qjs_get_undefined());
    }
    return this._undefined;
  }

  /** The null value. Cached — do not dispose. */
  get null(): JSValueHandle {
    if (!this._null) {
      this._null = new JSValueHandle(this, this.exports.qjs_get_null());
    }
    return this._null;
  }

  /** The true value. Cached — do not dispose. */
  get true(): JSValueHandle {
    if (!this._true) {
      this._true = new JSValueHandle(this, this.exports.qjs_get_true());
    }
    return this._true;
  }

  /** The false value. Cached — do not dispose. */
  get false(): JSValueHandle {
    if (!this._false) {
      this._false = new JSValueHandle(this, this.exports.qjs_get_false());
    }
    return this._false;
  }

  /**
   * Create a fresh QuickJS VM instance.
   *
   * @param options - Optional configuration. Can also pass raw WASM bytes
   *                  directly for backwards compatibility.
   */
  static async create(options?: QuickJSOptions | BufferSource | WebAssembly.Module): Promise<QuickJS> {
    const opts = QuickJS.normalizeOptions(options);
    const module = await QuickJS.resolveModule(opts.wasm);
    const vm = new QuickJS(module);
    const { instance, wasiBuiltins, wasiUserOverrides, memoryProxy } = await QuickJS.instantiate(module, vm, opts.wasi);
    vm.setInstance(instance);

    // Initialize the WASI reactor
    vm.exports._initialize();

    // Initialize QuickJS runtime and context
    const result = vm.exports.qjs_init();
    if (result !== 0) {
      throw new Error('Failed to initialize QuickJS runtime');
    }

    // Load and initialize extensions
    if (opts.extensions) {
      const mainExports = instance.exports as Record<string, WebAssembly.ExportValue>;
      for (const desc of opts.extensions) {
        const ext = await loadExtension(desc, mainExports, wasiBuiltins, wasiUserOverrides, memoryProxy);
        vm.loadedExtensions.push(ext);
        initExtension(ext, mainExports);
      }
    }

    // Apply runtime limits
    QuickJS.applyLimits(vm, opts);

    return vm;
  }

  /**
   * Restore a QuickJS VM from a snapshot.
   *
   * @param snapshot - The snapshot to restore from.
   * @param options - Optional configuration. Can also pass raw WASM bytes
   *                  directly for backwards compatibility.
   */
  static async restore(snapshot: Snapshot, options?: QuickJSOptions | BufferSource | WebAssembly.Module): Promise<QuickJS> {
    const opts = QuickJS.normalizeOptions(options);
    const module = await QuickJS.resolveModule(opts.wasm);
    const vm = new QuickJS(module);
    const { instance, wasiBuiltins, wasiUserOverrides, memoryProxy } = await QuickJS.instantiate(module, vm, opts.wasi);
    vm.setInstance(instance);

    const mainExports = instance.exports as Record<string, WebAssembly.ExportValue>;
    const exportedMemory = vm.exports.memory;

    // Grow memory FIRST — extensions need the memory to be large enough
    // for their __memory_base offsets (which were allocated in the original
    // larger memory during create()).
    const currentPages = exportedMemory.buffer.byteLength / 65536;
    const neededPages = Math.ceil(snapshot.memory.byteLength / 65536);
    if (neededPages > currentPages) {
      exportedMemory.grow(neededPages - currentPages);
    }

    // Re-instantiate extensions BEFORE overwriting memory.
    // This populates the indirect function table with the extension's
    // function pointers (via elem segments and __wasm_apply_data_relocs).
    // We use the exact same memory/table bases from the snapshot so that
    // function table indices match what the snapshotted QuickJS state expects.
    if (snapshot.extensions.length > 0) {
      const descriptors = opts.extensions ?? [];
      vm.loadedExtensions = await restoreExtensions(
        descriptors,
        snapshot.extensions,
        mainExports,
        wasiBuiltins,
        wasiUserOverrides,
        memoryProxy,
      );
    }

    // Copy snapshot data into the module's own memory.
    // This overwrites EVERYTHING — including the regions that extensions
    // just initialized. That's correct because the snapshot already contains
    // the complete state including extension data.
    const dst = new Uint8Array(exportedMemory.buffer);
    dst.set(snapshot.memory);

    // Set runtime/context pointers (they already exist in the restored memory)
    vm.exports.qjs_set_runtime_and_context(snapshot.runtimePtr, snapshot.contextPtr);

    // Restore the stack pointer
    vm.exports.__stack_pointer.value = snapshot.stackPointer;

    // Apply runtime limits
    QuickJS.applyLimits(vm, opts);

    return vm;
  }

  // ---- Snapshot serialization ----

  /**
   * Serialize a snapshot to a binary buffer for persistent storage.
   *
   * The format includes a versioned header followed by the raw memory.
   * Apply your own compression (gzip, zstd, etc.) on top for smaller
   * storage — the memory compresses very well due to large zero regions.
   *
   * Format (version 1):
   * ```
   * Offset  Size  Field
   * 0       4     Magic: "QJSS" (0x514A5353, big-endian)
   * 4       1     Version: 1
   * 5       3     Reserved (zero)
   * 8       4     Memory size in bytes (u32 little-endian)
   * 12      4     Stack pointer (u32 little-endian)
   * 16      4     Runtime pointer (u32 little-endian)
   * 20      4     Context pointer (u32 little-endian)
   * 24      N     Memory data (N = memory size from offset 8)
   * ```
   */
  static serializeSnapshot(snapshot: Snapshot): Uint8Array {
    const textEncoder = new TextEncoder();

    // Calculate extension metadata size
    let extMetaSize = 4; // extCount (u32)
    const extEncodedNames: Uint8Array[] = [];
    const extEncodedInitFns: Uint8Array[] = [];
    for (const ext of snapshot.extensions) {
      const nameBytes = textEncoder.encode(ext.name);
      const initFnBytes = textEncoder.encode(ext.initFn);
      extEncodedNames.push(nameBytes);
      extEncodedInitFns.push(initFnBytes);
      extMetaSize += 4 + nameBytes.length + 4 + 4 + 4 + initFnBytes.length;
    }

    const totalSize = SNAPSHOT_HEADER_SIZE + extMetaSize + snapshot.memory.byteLength;

    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // Header
    view.setUint32(0, SNAPSHOT_MAGIC, false); // big-endian for readability in hex
    view.setUint8(4, SNAPSHOT_VERSION);
    // bytes 5-7 are reserved (already zero)
    view.setUint32(8, snapshot.memory.byteLength, true);
    view.setUint32(12, snapshot.stackPointer, true);
    view.setUint32(16, snapshot.runtimePtr, true);
    view.setUint32(20, snapshot.contextPtr, true);

    // Extension metadata (version 2)
    let offset = SNAPSHOT_HEADER_SIZE;
    view.setUint32(offset, snapshot.extensions.length, true);
    offset += 4;

    for (let i = 0; i < snapshot.extensions.length; i++) {
      const ext = snapshot.extensions[i];
      const nameBytes = extEncodedNames[i];
      const initFnBytes = extEncodedInitFns[i];

      view.setUint32(offset, nameBytes.length, true);
      offset += 4;
      bytes.set(nameBytes, offset);
      offset += nameBytes.length;
      view.setUint32(offset, ext.memoryBase, true);
      offset += 4;
      view.setUint32(offset, ext.tableBase, true);
      offset += 4;
      view.setUint32(offset, initFnBytes.length, true);
      offset += 4;
      bytes.set(initFnBytes, offset);
      offset += initFnBytes.length;
    }

    // Memory data
    bytes.set(snapshot.memory, offset);

    return bytes;
  }

  /**
   * Deserialize a snapshot from a binary buffer produced by `serializeSnapshot()`.
   */
  static deserializeSnapshot(data: Uint8Array): Snapshot {
    if (data.length < SNAPSHOT_HEADER_SIZE) {
      throw new Error('Invalid snapshot: too small');
    }

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    // Validate magic
    const magic = view.getUint32(0, false);
    if (magic !== SNAPSHOT_MAGIC) {
      throw new Error(`Invalid snapshot: bad magic (expected 0x${SNAPSHOT_MAGIC.toString(16)}, got 0x${magic.toString(16)})`);
    }

    // Validate version
    const version = view.getUint8(4);
    if (version !== SNAPSHOT_VERSION && version !== 1) {
      throw new Error(`Unsupported snapshot version: ${version} (expected ${SNAPSHOT_VERSION})`);
    }

    const memorySize = view.getUint32(8, true);
    const stackPointer = view.getUint32(12, true);
    const runtimePtr = view.getUint32(16, true);
    const contextPtr = view.getUint32(20, true);

    let extensions: SnapshotExtension[] = [];
    let memoryOffset = SNAPSHOT_HEADER_SIZE;

    if (version >= 2) {
      // Version 2 adds extension metadata between the header and the memory data
      const extCount = view.getUint32(24, true);
      let offset = 28;
      const textDecoder = new TextDecoder();

      for (let i = 0; i < extCount; i++) {
        // name length (u32) + name (utf8) + memoryBase (u32) + tableBase (u32) + initFn length (u32) + initFn (utf8)
        const nameLen = view.getUint32(offset, true);
        offset += 4;
        const name = textDecoder.decode(data.slice(offset, offset + nameLen));
        offset += nameLen;
        const memBase = view.getUint32(offset, true);
        offset += 4;
        const tblBase = view.getUint32(offset, true);
        offset += 4;
        const initFnLen = view.getUint32(offset, true);
        offset += 4;
        const initFn = textDecoder.decode(data.slice(offset, offset + initFnLen));
        offset += initFnLen;
        extensions.push({ name, memoryBase: memBase, tableBase: tblBase, initFn });
      }
      memoryOffset = offset;
    }

    const expectedSize = memoryOffset + memorySize;
    if (data.length < expectedSize) {
      throw new Error(`Invalid snapshot: expected ${expectedSize} bytes, got ${data.length}`);
    }

    const memory = data.slice(memoryOffset, memoryOffset + memorySize);

    return { memory, stackPointer, runtimePtr, contextPtr, extensions };
  }

  // ---- Internal instantiation helpers ----

  private static normalizeOptions(options?: QuickJSOptions | BufferSource | WebAssembly.Module): QuickJSOptions {
    if (!options) return {};
    if (options instanceof WebAssembly.Module) return { wasm: options };
    if (typeof options === 'object' && ('wasm' in options || 'wasi' in options || 'memoryLimit' in options || 'interruptHandler' in options || 'extensions' in options)) return options as QuickJSOptions;
    // BufferSource (ArrayBuffer or ArrayBufferView)
    return { wasm: options as BufferSource };
  }

  private static applyLimits(vm: QuickJS, opts: QuickJSOptions): void {
    if (opts.memoryLimit !== undefined) {
      vm.exports.qjs_set_memory_limit(opts.memoryLimit);
    }
    if (opts.interruptHandler) {
      vm.interruptHandler = opts.interruptHandler;
      vm.exports.qjs_set_interrupt_handler(1);
    }
  }

  private static async resolveModule(wasmInput?: BufferSource | WebAssembly.Module): Promise<WebAssembly.Module> {
    if (wasmInput instanceof WebAssembly.Module) {
      return wasmInput;
    } else if (wasmInput) {
      return WebAssembly.compile(wasmInput);
    } else {
      const { readFile } = await import('node:fs/promises');
      const buf = await readFile(new URL('../quickjs.wasm', import.meta.url));
      return WebAssembly.compile(buf);
    }
  }

  private static async instantiate(module: WebAssembly.Module, vm: QuickJS, wasiOptions?: WasiOptions): Promise<{
    instance: WebAssembly.Instance;
    wasiBuiltins: WasiImports;
    wasiUserOverrides: WasiImports | undefined;
    memoryProxy: WebAssembly.Memory;
  }> {
    let memory: WebAssembly.Memory | null = null;

    // Create a memory proxy that defers to the actual memory once set.
    // This allows WASI override factories to close over the memory reference
    // before the WASM instance is created.
    const memoryProxy = new Proxy({} as WebAssembly.Memory, {
      get(_target, prop) {
        return (memory as any)[prop];
      },
    });

    // Build the builtins (no user overrides)
    const wasiBuiltins = createWasiShim(() => memory!);

    // Resolve user overrides via factory
    const wasiUserOverrides = wasiOptions ? wasiOptions(memoryProxy) : undefined;

    // Final shim for the main module: builtins + user overrides
    const wasiShim = { ...wasiBuiltins, ...wasiUserOverrides };

    const hostCall = (namePtr: number, nameLen: number, thisPtr: number, argc: number, argvPtr: number): number => {
      return vm.handleHostCall(namePtr, nameLen, thisPtr, argc, argvPtr);
    };

    const hostInterrupt = (): number => {
      return vm.interruptHandler ? (vm.interruptHandler() ? 1 : 0) : 0;
    };

    const instance = await WebAssembly.instantiate(module, {
      env: { host_call: hostCall, host_interrupt: hostInterrupt },
      wasi_snapshot_preview1: wasiShim,
    });

    memory = (instance.exports as any).memory as WebAssembly.Memory;
    return { instance, wasiBuiltins, wasiUserOverrides, memoryProxy };
  }

  /**
   * Called from WASM when a host function is invoked from QuickJS code.
   */
  private handleHostCall(namePtr: number, nameLen: number, thisPtr: number, argc: number, argvPtr: number): number {
    const name = this.decoder.decode(new Uint8Array(this.exports.memory.buffer, namePtr, nameLen));
    const callback = this.hostCallbacks.get(name);
    if (!callback) {
      return this.exports.qjs_get_undefined();
    }

    const thisHandle = new JSValueHandle(this, thisPtr);

    const args: JSValueHandle[] = [];
    if (argc > 0 && argvPtr !== 0) {
      const view = new DataView(this.exports.memory.buffer);
      for (let i = 0; i < argc; i++) {
        const argPtr = view.getUint32(argvPtr + i * 4, true);
        args.push(new JSValueHandle(this, argPtr));
      }
    }

    try {
      const result = callback.call(thisHandle, ...args);
      return this.exports.qjs_dup_value(result.ptr);
    } catch (err) {
      // Throw an exception inside QuickJS and return NULL to signal
      // to the C trampoline that an exception was thrown.
      const errHandle = this.newError(err instanceof Error ? err : String(err));
      this.exports.qjs_throw(errHandle.ptr);
      errHandle.dispose();
      return 0;
    }
  }

  // ---- String helpers ----

  /** Write a JS string into WASM memory, returning the pointer. Caller must free. */
  private writeString(str: string): { ptr: number; len: number } {
    const encoded = this.encoder.encode(str);
    const ptr = this.exports.wasm_malloc(encoded.length + 1);
    if (ptr === 0) throw new Error('wasm_malloc failed');
    const mem = new Uint8Array(this.exports.memory.buffer);
    mem.set(encoded, ptr);
    mem[ptr + encoded.length] = 0;
    return { ptr, len: encoded.length };
  }

  /** Read a null-terminated C string from WASM memory */
  private readCString(ptr: number): string {
    const mem = new Uint8Array(this.exports.memory.buffer);
    let end = ptr;
    while (mem[end] !== 0) end++;
    return this.decoder.decode(mem.slice(ptr, end));
  }

  // ---- Public API ----

  /**
   * Check if a result handle is an exception and throw a JSException if so.
   * Used internally by evalCode and callFunction.
   */
  private throwIfException(result: JSValueHandle): JSValueHandle {
    if (this.exports.qjs_is_exception(result.ptr) !== 0) {
      const exc = this.getException();
      result.dispose();
      // Track the handle so it gets cleaned up if the VM is disposed
      // before the caller disposes the exception.
      this._ownedHandles.add(exc);
      throw new JSException(exc);
    }
    return result;
  }

  /**
   * Evaluate JavaScript code and return the result as a handle.
   * If the code throws, a `JSException` (which extends `Error`) is thrown
   * on the host side — matching standard JavaScript semantics.
   *
   * @param code - The JavaScript source code to evaluate.
   * @param filename - Optional filename for error stack traces (default `'<eval>'`).
   * @param flags - Optional bitwise OR of `EvalFlags.*` constants.
   *   For example, pass `EvalFlags.ASYNC` to allow top-level `await` — the
   *   returned handle will be a Promise that resolves to the completion value.
   */
  evalCode(code: string, filename: string = '<eval>', flags: number = 0): JSValueHandle {
    this.assertNotDisposed();
    const codeStr = this.writeString(code);
    const fnStr = this.writeString(filename);
    const resultPtr = this.exports.qjs_eval(codeStr.ptr, codeStr.len, fnStr.ptr, flags);
    this.exports.wasm_free(codeStr.ptr);
    this.exports.wasm_free(fnStr.ptr);
    return this.throwIfException(new JSValueHandle(this, resultPtr));
  }

  /**
   * Execute all pending microtask jobs (promise reactions, etc.)
   * Returns the number of jobs executed.
   */
  executePendingJobs(): number {
    this.assertNotDisposed();
    let count = 0;
    while (this.exports.qjs_is_job_pending()) {
      const result = this.exports.qjs_execute_pending_job();
      if (result < 0) {
        const exc = this.getException();
        throw new Error(`Job execution error: ${exc.toString()}`);
      }
      count++;
    }
    return count;
  }

  /**
   * Get the global object. Prefer the cached `vm.global` property.
   */
  getGlobal(): JSValueHandle {
    this.assertNotDisposed();
    return new JSValueHandle(this, this.exports.qjs_get_global());
  }

  /**
   * Create a new QuickJS string value.
   */
  newString(str: string): JSValueHandle {
    this.assertNotDisposed();
    const { ptr, len } = this.writeString(str);
    const resultPtr = this.exports.qjs_new_string(ptr, len);
    this.exports.wasm_free(ptr);
    return new JSValueHandle(this, resultPtr);
  }

  /**
   * Create a new QuickJS number value.
   */
  newNumber(num: number): JSValueHandle {
    this.assertNotDisposed();
    return new JSValueHandle(this, this.exports.qjs_new_number(num));
  }

  /**
   * Create a new QuickJS BigInt value.
   */
  newBigInt(val: bigint): JSValueHandle {
    this.assertNotDisposed();
    // Split the bigint into lo/hi 32-bit halves
    const lo = Number(val & 0xFFFFFFFFn);
    const hi = Number((val >> 32n) & 0xFFFFFFFFn);
    return new JSValueHandle(this, this.exports.qjs_new_big_int64(lo, hi));
  }

  /**
   * Create a new QuickJS object value.
   */
  newObject(): JSValueHandle {
    this.assertNotDisposed();
    return new JSValueHandle(this, this.exports.qjs_new_object());
  }

  /**
   * Create a new QuickJS array value.
   */
  newArray(): JSValueHandle {
    this.assertNotDisposed();
    return new JSValueHandle(this, this.exports.qjs_new_array());
  }

  /**
   * Create a global symbol (`Symbol.for(description)`).
   * Global symbols with the same description are always the same symbol,
   * even across snapshot/restore.
   */
  newSymbolFor(description: string): JSValueHandle {
    this.assertNotDisposed();
    const { ptr, len } = this.writeString(description);
    const result = new JSValueHandle(this, this.exports.qjs_new_symbol(ptr, len, 1));
    this.exports.wasm_free(ptr);
    return result;
  }

  /**
   * Create a new QuickJS ArrayBuffer by copying data from a host buffer.
   */
  newArrayBuffer(data: ArrayBuffer | Uint8Array): JSValueHandle {
    this.assertNotDisposed();
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const ptr = this.exports.wasm_malloc(bytes.length);
    if (ptr === 0) throw new Error('wasm_malloc failed');
    new Uint8Array(this.exports.memory.buffer).set(bytes, ptr);
    const result = new JSValueHandle(this, this.exports.qjs_new_array_buffer(ptr, bytes.length));
    this.exports.wasm_free(ptr);
    return result;
  }

  /**
   * Create a new QuickJS Uint8Array by copying data from a host buffer.
   */
  newUint8Array(data: Uint8Array): JSValueHandle {
    this.assertNotDisposed();
    const ptr = this.exports.wasm_malloc(data.length);
    if (ptr === 0) throw new Error('wasm_malloc failed');
    new Uint8Array(this.exports.memory.buffer).set(data, ptr);
    const result = new JSValueHandle(this, this.exports.qjs_new_uint8_array(ptr, data.length));
    this.exports.wasm_free(ptr);
    return result;
  }

  /**
   * Get undefined. Prefer the cached `vm.undefined` property.
   */
  getUndefined(): JSValueHandle {
    this.assertNotDisposed();
    return new JSValueHandle(this, this.exports.qjs_get_undefined());
  }

  /**
   * Get null. Prefer the cached `vm.null` property.
   */
  getNull(): JSValueHandle {
    this.assertNotDisposed();
    return new JSValueHandle(this, this.exports.qjs_get_null());
  }

  /**
   * Get true. Prefer the cached `vm.true` property.
   */
  getTrue(): JSValueHandle {
    this.assertNotDisposed();
    return new JSValueHandle(this, this.exports.qjs_get_true());
  }

  /**
   * Get false. Prefer the cached `vm.false` property.
   */
  getFalse(): JSValueHandle {
    this.assertNotDisposed();
    return new JSValueHandle(this, this.exports.qjs_get_false());
  }

  /**
   * Create a new QuickJS function backed by a host callback.
   *
   * When the function is called inside QuickJS, the host callback is invoked
   * with the `this` value and arguments as JSValueHandles.
   */
  newFunction(name: string, fn: HostFunction): JSValueHandle {
    this.assertNotDisposed();
    if (this.hostCallbacks.has(name)) {
      throw new Error(`Host callback with name "${name}" is already registered`);
    }
    this.hostCallbacks.set(name, fn);

    const { ptr: namePtr, len: nameLen } = this.writeString(name);
    const resultPtr = this.exports.qjs_new_host_function(namePtr, nameLen, 0);
    this.exports.wasm_free(namePtr);
    return new JSValueHandle(this, resultPtr);
  }

  /**
   * Create an internal host function that bypasses the duplicate-name check.
   * Used for ephemeral callbacks (promise settle handlers, resolvePromise, etc.)
   * that are not intended to survive snapshot/restore.
   */
  private newInternalFunction(name: string, fn: HostFunction): JSValueHandle {
    this.hostCallbacks.set(name, fn);

    const { ptr: namePtr, len: nameLen } = this.writeString(name);
    const resultPtr = this.exports.qjs_new_host_function(namePtr, nameLen, 0);
    this.exports.wasm_free(namePtr);
    return new JSValueHandle(this, resultPtr);
  }

  /**
   * Create a new promise.
   *
   * Returns a Deferred with:
   * - `handle` - the QuickJS promise object
   * - `settled` - a host Promise that resolves when the QuickJS promise settles
   * - `resolve(value)` - resolve the promise with a QuickJS value
   * - `reject(value)` - reject the promise with a QuickJS value
   */
  newPromise(): Deferred {
    this.assertNotDisposed();
    const resolveOutPtr = this.exports.wasm_malloc(4);
    const rejectOutPtr = this.exports.wasm_malloc(4);

    const promisePtr = this.exports.qjs_new_promise(resolveOutPtr, rejectOutPtr);

    const view = new DataView(this.exports.memory.buffer);
    const resolvePtr = view.getUint32(resolveOutPtr, true);
    const rejectPtr = view.getUint32(rejectOutPtr, true);

    this.exports.wasm_free(resolveOutPtr);
    this.exports.wasm_free(rejectOutPtr);

    const promiseHandle = new JSValueHandle(this, promisePtr);
    const resolveHandle = new JSValueHandle(this, resolvePtr);
    const rejectHandle = new JSValueHandle(this, rejectPtr);

    const vm = this;

    // Track resolve/reject handles so they can be freed on VM dispose
    // if the promise is never resolved/rejected
    vm._ownedHandles.add(resolveHandle);
    vm._ownedHandles.add(rejectHandle);

    // Lazily-created settled promise — only attaches .then() handler when accessed
    let _settled: Promise<void> | null = null;

    return {
      handle: promiseHandle,
      get settled(): Promise<void> {
        if (!_settled) {
          let settledResolve: () => void;
          _settled = new Promise<void>((res) => {
            settledResolve = res;
          });

          const settleName = `__settle:${vm.nextInternalId++}`;
          const onSettleFn = vm.newInternalFunction(settleName, () => {
            settledResolve!();
            vm.hostCallbacks.delete(settleName);
            return vm.undefined;
          });

          const thenFn = promiseHandle.getProp('then');
          const onSettleDup = onSettleFn.dup();
          vm.callFunctionRaw(thenFn, promiseHandle, onSettleFn, onSettleDup).dispose();
          thenFn.dispose();
          onSettleFn.dispose();
          onSettleDup.dispose();
        }
        return _settled;
      },
      resolve(value: JSValueHandle) {
        vm.callFunctionRaw(resolveHandle, vm.undefined, value).dispose();
        vm._ownedHandles.delete(resolveHandle);
        resolveHandle.dispose();
      },
      reject(value: JSValueHandle) {
        vm.callFunctionRaw(rejectHandle, vm.undefined, value).dispose();
        vm._ownedHandles.delete(rejectHandle);
        rejectHandle.dispose();
      },
    };
  }

  /**
   * Resolve a promise handle. Returns a host-side Promise that resolves
   * with the settled value/error of the QuickJS promise.
   *
   * If the handle is not a promise, it is treated as an already-fulfilled value.
   *
   * The returned host Promise resolves to `{ value: JSValueHandle }` on
   * fulfillment or `{ error: JSValueHandle }` on rejection.
   */
  resolvePromise(promiseHandle: JSValueHandle): Promise<{ value: JSValueHandle } | { error: JSValueHandle }> {
    this.assertNotDisposed();

    // If the handle is not a promise, treat it as a fulfilled value
    if (!this.exports.qjs_is_promise(promiseHandle.ptr)) {
      return Promise.resolve({ value: promiseHandle.dup() });
    }

    // Check if already settled
    const state = this.exports.qjs_promise_state(promiseHandle.ptr);
    if (state === 1) {
      // fulfilled
      return Promise.resolve({ value: new JSValueHandle(this, this.exports.qjs_promise_result(promiseHandle.ptr)) });
    } else if (state === 2) {
      // rejected
      return Promise.resolve({ error: new JSValueHandle(this, this.exports.qjs_promise_result(promiseHandle.ptr)) });
    }

    // Pending — attach a .then/.catch to get notified
    return new Promise((hostResolve) => {
      const id = this.nextInternalId++;
      const fulfilledName = `__onFulfilled:${id}`;
      const rejectedName = `__onRejected:${id}`;

      const onFulfilled = this.newInternalFunction(fulfilledName, (...args) => {
        const val = args[0]?.dup() ?? this.undefined;
        this.hostCallbacks.delete(fulfilledName);
        this.hostCallbacks.delete(rejectedName);
        hostResolve({ value: val });
        return this.undefined;
      });
      const onRejected = this.newInternalFunction(rejectedName, (...args) => {
        const val = args[0]?.dup() ?? this.undefined;
        this.hostCallbacks.delete(fulfilledName);
        this.hostCallbacks.delete(rejectedName);
        hostResolve({ error: val });
        return this.undefined;
      });

      const thenFn = promiseHandle.getProp('then');
      this.callFunctionRaw(thenFn, promiseHandle, onFulfilled, onRejected).dispose();
      thenFn.dispose();
      onFulfilled.dispose();
      onRejected.dispose();
    });
  }

  /**
   * Call a QuickJS function. If the function throws, a `JSException`
   * is thrown on the host side.
   */
  callFunction(func: JSValueHandle, thisVal: JSValueHandle, ...args: JSValueHandle[]): JSValueHandle {
    return this.throwIfException(this.callFunctionRaw(func, thisVal, ...args));
  }

  /**
   * Internal: call a QuickJS function without throwing on exception.
   * Used by promise plumbing where exceptions are handled differently.
   */
  private callFunctionRaw(func: JSValueHandle, thisVal: JSValueHandle, ...args: JSValueHandle[]): JSValueHandle {
    this.assertNotDisposed();
    const argc = args.length;

    let argvPtr = 0;
    if (argc > 0) {
      argvPtr = this.exports.wasm_malloc(argc * 4);
      const view = new DataView(this.exports.memory.buffer);
      for (let i = 0; i < argc; i++) {
        view.setUint32(argvPtr + i * 4, args[i].ptr, true);
      }
    }

    const resultPtr = this.exports.qjs_call(func.ptr, thisVal.ptr, argc, argvPtr);

    if (argvPtr) this.exports.wasm_free(argvPtr);

    return new JSValueHandle(this, resultPtr);
  }

  /**
   * Set a property on an object. Accepts string or JSValueHandle as key.
   * JSValueHandle keys support symbols (including `Symbol.for()`).
   */
  setProp(obj: JSValueHandle, key: string | JSValueHandle, value: JSValueHandle): void {
    this.assertNotDisposed();
    if (typeof key === 'string') {
      const { ptr: namePtr } = this.writeString(key);
      this.exports.qjs_set_prop_string(obj.ptr, namePtr, value.ptr);
      this.exports.wasm_free(namePtr);
    } else {
      this.exports.qjs_set_prop_value(obj.ptr, key.ptr, value.ptr);
    }
  }

  /**
   * Define a property on an object with explicit property descriptor flags.
   * Unlike `setProp`, this allows controlling `writable`, `enumerable`, and
   * `configurable` attributes, matching `Object.defineProperty()` semantics.
   * Accepts string or JSValueHandle as key (JSValueHandle keys support symbols).
   *
   * All flags default to `false` when not specified.
   */
  defineProp(obj: JSValueHandle, key: string | JSValueHandle, value: JSValueHandle, descriptor?: JSPropertyDescriptor): void {
    this.assertNotDisposed();
    let flags = 0;
    if (descriptor?.configurable) flags |= 1; // JS_PROP_CONFIGURABLE
    if (descriptor?.writable) flags |= 2;     // JS_PROP_WRITABLE
    if (descriptor?.enumerable) flags |= 4;   // JS_PROP_ENUMERABLE
    if (typeof key === 'string') {
      const { ptr: namePtr } = this.writeString(key);
      this.exports.qjs_define_prop_string(obj.ptr, namePtr, value.ptr, flags);
      this.exports.wasm_free(namePtr);
    } else {
      this.exports.qjs_define_prop_value(obj.ptr, key.ptr, value.ptr, flags);
    }
  }

  /**
   * Get a property from an object using a JSValueHandle key.
   * Supports symbol keys (including `Symbol.for()`).
   */
  getProp(obj: JSValueHandle, key: JSValueHandle): JSValueHandle {
    this.assertNotDisposed();
    return new JSValueHandle(this, this.exports.qjs_get_prop_value(obj.ptr, key.ptr));
  }

  /**
   * Get the current exception, if any.
   */
  getException(): JSValueHandle {
    this.assertNotDisposed();
    return new JSValueHandle(this, this.exports.qjs_get_exception());
  }

  /**
   * Create a new QuickJS Error object.
   * Accepts a string message or a native Error object.
   */
  newError(messageOrError: string | Error): JSValueHandle {
    this.assertNotDisposed();
    const errPtr = this.exports.qjs_new_error();
    const errHandle = new JSValueHandle(this, errPtr);

    if (typeof messageOrError === 'string') {
      const msgHandle = this.newString(messageOrError);
      errHandle.setProp('message', msgHandle);
      msgHandle.dispose();
    } else {
      const msgHandle = this.newString(messageOrError.message);
      errHandle.setProp('message', msgHandle);
      msgHandle.dispose();

      if (messageOrError.name) {
        const nameHandle = this.newString(messageOrError.name);
        errHandle.setProp('name', nameHandle);
        nameHandle.dispose();
      }

      if (messageOrError.stack) {
        const stackHandle = this.newString(messageOrError.stack);
        errHandle.setProp('stack', stackHandle);
        stackHandle.dispose();
      }
    }

    return errHandle;
  }

  /**
   * Get the typeof a handle as a string.
   */
  typeof(handle: JSValueHandle): string {
    this.assertNotDisposed();
    const e = this.exports;
    if (e.qjs_is_undefined(handle.ptr)) return 'undefined';
    if (e.qjs_is_null(handle.ptr)) return 'object'; // typeof null === 'object'
    if (e.qjs_is_bool(handle.ptr)) return 'boolean';
    if (e.qjs_is_number(handle.ptr)) return 'number';
    if (e.qjs_is_big_int(handle.ptr)) return 'bigint';
    if (e.qjs_is_string(handle.ptr)) return 'string';
    if (e.qjs_is_symbol(handle.ptr)) return 'symbol';
    if (e.qjs_is_function(handle.ptr)) return 'function';
    if (e.qjs_is_object(handle.ptr)) return 'object';
    return 'unknown';
  }

  /**
   * Convert a QuickJS handle to a host JavaScript value.
   * Handles strings, numbers, booleans, null, undefined, bigint, arrays,
   * errors, functions, and plain objects. Circular references in objects
   * are returned as `undefined`.
   */
  dump(handle: JSValueHandle): unknown {
    this.assertNotDisposed();
    return this._dump(handle, new Map());
  }

  private _dump(handle: JSValueHandle, visited: Map<number, unknown>): unknown {
    const e = this.exports;

    if (e.qjs_is_undefined(handle.ptr)) return undefined;
    if (e.qjs_is_null(handle.ptr)) return null;
    if (e.qjs_is_bool(handle.ptr)) return e.qjs_get_bool(handle.ptr) !== 0;
    if (e.qjs_is_number(handle.ptr)) return e.qjs_get_float64(handle.ptr);
    if (e.qjs_is_string(handle.ptr)) return handle.toString();
    if (e.qjs_is_big_int(handle.ptr)) return handle.toBigInt();
    if (e.qjs_is_symbol(handle.ptr)) {
      const descOutPtr = e.wasm_malloc(4);
      const kind = e.qjs_get_symbol_description(handle.ptr, descOutPtr);
      const view = new DataView(e.memory.buffer);
      const descPtr = view.getUint32(descOutPtr, true);
      e.wasm_free(descOutPtr);
      if (kind === 1) {
        // Global symbol — reconstruct as Symbol.for(description)
        const descHandle = new JSValueHandle(this, descPtr);
        const description = descHandle.toString();
        descHandle.dispose();
        return Symbol.for(description);
      } else if (kind === 2) {
        // Local (anonymous) symbol — can't be reconstructed on host
        const descHandle = new JSValueHandle(this, descPtr);
        descHandle.dispose();
        return undefined;
      }
      return undefined;
    }
    if (e.qjs_is_array_buffer(handle.ptr)) return handle.toArrayBuffer();

    if (e.qjs_is_exception(handle.ptr)) {
      const exc = this.getException();
      const msg = exc.toString();
      exc.dispose();
      return new Error(msg);
    }

    // Functions cannot be meaningfully serialized
    if (e.qjs_is_function(handle.ptr)) return undefined;

    // Detect circular references using the underlying JS object pointer.
    // If we've already visited this object, return the same host object
    // (preserving the circular structure on the host side).
    if (e.qjs_is_object(handle.ptr)) {
      const objPtr = e.qjs_get_value_ptr(handle.ptr);
      if (objPtr) {
        const existing = visited.get(objPtr);
        if (existing !== undefined) return existing;
      }
    }

    // Check for typed arrays (before regular array check — typed arrays are not Array.isArray)
    if (e.qjs_is_object(handle.ptr)) {
      const byteOffsetPtr = e.wasm_malloc(4);
      const byteLengthPtr = e.wasm_malloc(4);
      const bytesPerElemPtr = e.wasm_malloc(4);
      const abPtr = e.qjs_get_typed_array_buffer(handle.ptr, byteOffsetPtr, byteLengthPtr, bytesPerElemPtr);
      const abHandle = new JSValueHandle(this, abPtr);

      if (e.qjs_is_exception(abHandle.ptr) === 0) {
        const view = new DataView(e.memory.buffer);
        const byteOffset = view.getUint32(byteOffsetPtr, true);
        const byteLength = view.getUint32(byteLengthPtr, true);
        const bytesPerElement = view.getUint32(bytesPerElemPtr, true);
        e.wasm_free(byteOffsetPtr);
        e.wasm_free(byteLengthPtr);
        e.wasm_free(bytesPerElemPtr);

        const abLenPtr = e.wasm_malloc(4);
        const abDataPtr = e.qjs_get_array_buffer(abHandle.ptr, abLenPtr);
        e.wasm_free(abLenPtr);
        abHandle.dispose();

        if (abDataPtr !== 0) {
          const rawBytes = new Uint8Array(e.memory.buffer, abDataPtr + byteOffset, byteLength).slice();

          switch (bytesPerElement) {
            case 1: return rawBytes;
            case 2: return new Uint16Array(rawBytes.buffer);
            case 4: return new Uint32Array(rawBytes.buffer);
            case 8: return new Float64Array(rawBytes.buffer);
            default: return rawBytes;
          }
        }
      } else {
        abHandle.dispose();
        e.wasm_free(byteOffsetPtr);
        e.wasm_free(byteLengthPtr);
        e.wasm_free(bytesPerElemPtr);
      }
    }

    if (e.qjs_is_array(handle.ptr)) {
      const lenHandle = handle.getProp('length');
      const len = e.qjs_get_float64(lenHandle.ptr);
      lenHandle.dispose();
      const arr: unknown[] = [];
      // Register the array in the visited map BEFORE populating it,
      // so circular references within the array resolve to this same array.
      const objPtr = e.qjs_get_value_ptr(handle.ptr);
      if (objPtr) visited.set(objPtr, arr);
      for (let i = 0; i < len; i++) {
        const elemPtr = e.qjs_get_prop_uint32(handle.ptr, i);
        const elemHandle = new JSValueHandle(this, elemPtr);
        arr.push(this._dump(elemHandle, visited));
        elemHandle.dispose();
      }
      return arr;
    }

    if (e.qjs_is_error(handle.ptr)) {
      const nameHandle = handle.getProp('name');
      const msgHandle = handle.getProp('message');
      const stackHandle = handle.getProp('stack');
      const name = nameHandle.isUndefined ? 'Error' : nameHandle.toString();
      const message = msgHandle.isUndefined ? '' : msgHandle.toString();
      const stack = stackHandle.isUndefined ? undefined : stackHandle.toString();
      nameHandle.dispose();
      msgHandle.dispose();
      stackHandle.dispose();
      const err = new Error(message);
      err.name = name;
      if (stack !== undefined) {
        err.stack = stack;
      }
      return err;
    }

    if (e.qjs_is_object(handle.ptr)) {
      const keysPtr = e.qjs_get_own_property_names(handle.ptr);
      const keysHandle = new JSValueHandle(this, keysPtr);
      if (e.qjs_is_exception(keysHandle.ptr) !== 0) {
        keysHandle.dispose();
        return {};
      }
      const lenHandle = keysHandle.getProp('length');
      const len = e.qjs_get_float64(lenHandle.ptr);
      lenHandle.dispose();

      const obj: Record<string, unknown> = {};
      // Register the object in the visited map BEFORE populating it,
      // so circular references resolve to this same object.
      const objPtr = e.qjs_get_value_ptr(handle.ptr);
      if (objPtr) visited.set(objPtr, obj);
      for (let i = 0; i < len; i++) {
        const keyPtr = e.qjs_get_prop_uint32(keysHandle.ptr, i);
        const keyHandle = new JSValueHandle(this, keyPtr);
        const key = keyHandle.toString();
        keyHandle.dispose();

        const valHandle = handle.getProp(key);
        obj[key] = this._dump(valHandle, visited);
        valHandle.dispose();
      }
      keysHandle.dispose();
      return obj;
    }

    return undefined;
  }

  /**
   * Convert a host JavaScript value to a QuickJS handle.
   */
  hostToHandle(value: unknown): JSValueHandle {
    this.assertNotDisposed();
    if (value === undefined) return this.undefined;
    if (value === null) return this.null;
    if (value === true) return this.true;
    if (value === false) return this.false;
    if (typeof value === 'number') return this.newNumber(value);
    if (typeof value === 'string') return this.newString(value);
    if (typeof value === 'bigint') return this.newBigInt(value);

    if (typeof value === 'symbol') {
      const key = Symbol.keyFor(value);
      if (key !== undefined) {
        return this.newSymbolFor(key);
      }
      // Local symbols can't be transferred to QuickJS
      throw new Error(`Cannot convert local symbol to QuickJS handle. Use Symbol.for() for cross-boundary symbols.`);
    }

    if (value instanceof Promise) {
      const deferred = this.newPromise();
      value.then(
        (r: unknown) => {
          deferred.resolve(this.hostToHandle(r));
          this.executePendingJobs();
        },
        (err: unknown) => {
          deferred.reject(this.hostToHandle(err));
          this.executePendingJobs();
        }
      );
      return deferred.handle;
    }

    if (value instanceof Error) {
      return this.newError(value);
    }

    if (value instanceof ArrayBuffer) {
      return this.newArrayBuffer(value);
    }

    if (value instanceof Uint8Array) {
      return this.newUint8Array(value);
    }

    if (ArrayBuffer.isView(value)) {
      // Other typed arrays — convert via Uint8Array view of the underlying buffer
      return this.newArrayBuffer(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }

    if (Array.isArray(value)) {
      const arr = this.newArray();
      for (let i = 0; i < value.length; i++) {
        const elemHandle = this.hostToHandle(value[i]);
        this.exports.qjs_set_prop_uint32(arr.ptr, i, elemHandle.ptr);
        elemHandle.dispose();
      }
      return arr;
    }

    if (typeof value === 'object' && value !== null) {
      const obj = this.newObject();
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        const valHandle = this.hostToHandle(val);
        obj.setProp(key, valHandle);
        valHandle.dispose();
      }
      return obj;
    }

    return this.undefined;
  }

  // ---- Snapshot / Restore ----

  /**
   * Snapshot the entire VM state.
   *
   * Returns a snapshot containing the full WASM linear memory. Use
   * `QuickJS.serializeSnapshot()` to convert to a versioned binary
   * buffer for persistent storage.
   */
  snapshot(): Snapshot {
    this.assertNotDisposed();

    return {
      memory: new Uint8Array(this.exports.memory.buffer).slice(),
      stackPointer: this.exports.__stack_pointer.value as number,
      runtimePtr: this.exports.qjs_get_runtime_ptr(),
      contextPtr: this.exports.qjs_get_context_ptr(),
      extensions: this.loadedExtensions.map((ext) => ({
        name: ext.name,
        memoryBase: ext.memoryBase,
        tableBase: ext.tableBase,
        initFn: ext.initFn,
      })),
    };
  }

  /**
   * Re-register a host callback after restoring from a snapshot.
   * The name must match the name passed to `newFunction()` before the snapshot.
   */
  registerHostCallback(name: string, fn: HostFunction): void {
    this.hostCallbacks.set(name, fn);
  }

  /**
   * Dispose the VM, releasing all references to the WASM instance
   * so it can be garbage collected by the host JS engine.
   */
  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;

      // Release references so the WASM instance and its linear memory
      // can be garbage collected even if someone holds onto this QuickJS object.
      this._global = null;
      this._undefined = null;
      this._null = null;
      this._true = null;
      this._false = null;
      this._ownedHandles.clear();
      this.hostCallbacks.clear();
      this.exports = null!;
      this.instance = null!;
      this.module = null!;
    }
  }

  /**
   * Support for `using` declarations (Explicit Resource Management).
   * Automatically disposes the VM when it goes out of scope.
   *
   * ```typescript
   * using vm = await QuickJS.create(wasmBytes);
   * vm.evalCode('1 + 2');
   * // vm is automatically disposed here
   * ```
   */
  [Symbol.dispose](): void {
    this.dispose();
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('QuickJS instance has been disposed');
    }
  }

  // ---- Internal accessors for JSValueHandle ----

  /** @internal */
  _getExports(): QuickJSExports {
    return this.exports;
  }

  /** @internal */
  _getMemory(): WebAssembly.Memory {
    return this.exports.memory;
  }

  /** @internal */
  _writeString(str: string): { ptr: number; len: number } {
    return this.writeString(str);
  }

  /** @internal */
  _readCString(ptr: number): string {
    return this.readCString(ptr);
  }
}

// ---- JSException ----

/**
 * An exception thrown from QuickJS code. Extends `Error` so it works with
 * standard error handling (`instanceof Error`, `.message`, `.stack`), and
 * also exposes a `handle` property — a live `JSValueHandle` to the QuickJS
 * exception value, allowing direct inspection of custom properties.
 *
 * The `handle` must be disposed when you're done with it (or use `using`).
 * If the error propagates uncaught, the handle will be cleaned up when the
 * VM is disposed.
 */
export class JSException extends Error {
  /**
   * A live handle to the QuickJS exception value. You can read custom
   * properties, call methods, etc. Must be disposed when done.
   */
  readonly handle: JSValueHandle;

  // Cached values so they survive handle disposal / VM teardown.
  // Using # fields keeps them out of console.log / Object.keys output.
  #name: string;
  #message: string;
  #stack: string | undefined;

  /** @internal */
  constructor(handle: JSValueHandle) {
    super();
    this.handle = handle;

    // V8 installs a lazy `stack` accessor on Error instances that shadows
    // our prototype getter. Delete it so our getter takes effect.
    delete (this as any).stack;

    // Read error properties eagerly and cache them.
    using msgHandle = handle.getProp('message');
    this.#name = handle.getProp('name').consume(h => h.isUndefined ? 'Error' : h.toString());
    this.#message = msgHandle.isUndefined ? handle.toString() : msgHandle.toString();
    this.#stack = handle.getProp('stack').consume(h => h.isUndefined ? undefined : h.toString());
  }

  override get name(): string {
    return this.#name;
  }

  override set name(v: string) {
    this.#name = v;
  }

  override get message(): string {
    return this.#message;
  }

  override set message(v: string) {
    this.#message = v;
  }

  override get stack(): string | undefined {
    return this.#stack;
  }

  override set stack(v: string | undefined) {
    this.#stack = v;
  }

  dispose(): void {
    this.handle.dispose();
  }

  [Symbol.dispose](): void {
    this.handle.dispose();
  }
}

// ---- JSValue Handle ----

/**
 * A handle to a JSValue inside the QuickJS WASM instance.
 */
export class JSValueHandle {
  /** The QuickJS VM instance this handle belongs to. */
  readonly vm: QuickJS;
  /** @internal */
  readonly ptr: number;
  private disposed = false;

  constructor(vm: QuickJS, ptr: number) {
    this.vm = vm;
    this.ptr = ptr;
  }

  get isUndefined(): boolean {
    return this.vm._getExports().qjs_is_undefined(this.ptr) !== 0;
  }

  get isNull(): boolean {
    return this.vm._getExports().qjs_is_null(this.ptr) !== 0;
  }

  /**
   * Get the promise state: 0 = pending, 1 = fulfilled, 2 = rejected
   */

  get isBool(): boolean {
    return this.vm._getExports().qjs_is_bool(this.ptr) !== 0;
  }

  get isNumber(): boolean {
    return this.vm._getExports().qjs_is_number(this.ptr) !== 0;
  }

  get isString(): boolean {
    return this.vm._getExports().qjs_is_string(this.ptr) !== 0;
  }

  get isSymbol(): boolean {
    return this.vm._getExports().qjs_is_symbol(this.ptr) !== 0;
  }

  get isBigInt(): boolean {
    return this.vm._getExports().qjs_is_big_int(this.ptr) !== 0;
  }

  get isObject(): boolean {
    return this.vm._getExports().qjs_is_object(this.ptr) !== 0;
  }

  get isArray(): boolean {
    return this.vm._getExports().qjs_is_array(this.ptr) !== 0;
  }

  get isFunction(): boolean {
    return this.vm._getExports().qjs_is_function(this.ptr) !== 0;
  }

  get isError(): boolean {
    return this.vm._getExports().qjs_is_error(this.ptr) !== 0;
  }

  get isPromise(): boolean {
    return this.vm._getExports().qjs_is_promise(this.ptr) !== 0;
  }

  get isArrayBuffer(): boolean {
    return this.vm._getExports().qjs_is_array_buffer(this.ptr) !== 0;
  }

  get promiseState(): number {
    return this.vm._getExports().qjs_promise_state(this.ptr);
  }

  /**
   * Get the typeof this value as a string.
   * Returns the same values as the native `typeof` operator.
   */
  get typeof(): string {
    return this.vm.typeof(this);
  }

  /**
   * Get the length property of this value (for arrays, strings, etc.).
   */
  get length(): number {
    const h = this.getProp('length');
    const n = h.toNumber();
    h.dispose();
    return n;
  }

  /**
   * Get the constructor name of this object, or undefined if unavailable.
   */
  get constructorName(): string | undefined {
    const ctor = this.getProp('constructor');
    if (ctor.isUndefined || ctor.isNull) {
      ctor.dispose();
      return undefined;
    }
    const name = ctor.getProp('name');
    ctor.dispose();
    if (name.isUndefined || name.isNull) {
      name.dispose();
      return undefined;
    }
    const result = name.toString();
    name.dispose();
    return result;
  }

  /**
   * Get the own enumerable string property names (equivalent to Object.keys()).
   */
  keys(): string[] {
    const e = this.vm._getExports();
    const keysPtr = e.qjs_get_own_property_names(this.ptr);
    const keysHandle = new JSValueHandle(this.vm, keysPtr);
    if (e.qjs_is_exception(keysHandle.ptr) !== 0) {
      keysHandle.dispose();
      return [];
    }
    const lenHandle = keysHandle.getProp('length');
    const len = e.qjs_get_float64(lenHandle.ptr);
    lenHandle.dispose();
    const result: string[] = [];
    for (let i = 0; i < len; i++) {
      const keyPtr = e.qjs_get_prop_uint32(keysHandle.ptr, i);
      const keyHandle = new JSValueHandle(this.vm, keyPtr);
      result.push(keyHandle.toString());
      keyHandle.dispose();
    }
    keysHandle.dispose();
    return result;
  }

  /**
   * Get all own property names including non-enumerable ones
   * (equivalent to Object.getOwnPropertyNames()).
   */
  getOwnPropertyNames(): string[] {
    const e = this.vm._getExports();
    const keysPtr = e.qjs_get_own_property_names_all(this.ptr);
    const keysHandle = new JSValueHandle(this.vm, keysPtr);
    if (e.qjs_is_exception(keysHandle.ptr) !== 0) {
      keysHandle.dispose();
      return [];
    }
    const lenHandle = keysHandle.getProp('length');
    const len = e.qjs_get_float64(lenHandle.ptr);
    lenHandle.dispose();
    const result: string[] = [];
    for (let i = 0; i < len; i++) {
      const keyPtr = e.qjs_get_prop_uint32(keysHandle.ptr, i);
      const keyHandle = new JSValueHandle(this.vm, keyPtr);
      result.push(keyHandle.toString());
      keyHandle.dispose();
    }
    keysHandle.dispose();
    return result;
  }

  /**
   * Check if a property is an own property (equivalent to Object.prototype.hasOwnProperty).
   */
  hasOwnProperty(name: string): boolean {
    const { ptr: namePtr } = this.vm._writeString(name);
    const result = this.vm._getExports().qjs_has_own_property(this.ptr, namePtr);
    this.vm._getExports().wasm_free(namePtr);
    return result === 1;
  }

  /**
   * Check if a property is enumerable (equivalent to Object.prototype.propertyIsEnumerable).
   */
  propertyIsEnumerable(name: string): boolean {
    const { ptr: namePtr } = this.vm._writeString(name);
    const result = this.vm._getExports().qjs_property_is_enumerable(this.ptr, namePtr);
    this.vm._getExports().wasm_free(namePtr);
    return result === 1;
  }

  /**
   * Get the prototype of this object (equivalent to Object.getPrototypeOf()).
   */
  getPrototypeOf(): JSValueHandle {
    const protoPtr = this.vm._getExports().qjs_get_prototype_of(this.ptr);
    return new JSValueHandle(this.vm, protoPtr);
  }

  /**
   * Get a property by name.
   */
  getProp(name: string): JSValueHandle {
    const { ptr: namePtr } = this.vm._writeString(name);
    const resultPtr = this.vm._getExports().qjs_get_prop_string(this.ptr, namePtr);
    this.vm._getExports().wasm_free(namePtr);
    return new JSValueHandle(this.vm, resultPtr);
  }

  /**
   * Set a property by name.
   */
  setProp(name: string, value: JSValueHandle): void {
    const { ptr: namePtr } = this.vm._writeString(name);
    this.vm._getExports().qjs_set_prop_string(this.ptr, namePtr, value.ptr);
    this.vm._getExports().wasm_free(namePtr);
  }

  /**
   * Define a property with explicit property descriptor flags.
   * Unlike `setProp`, this allows controlling `writable`, `enumerable`, and
   * `configurable` attributes, matching `Object.defineProperty()` semantics.
   * Accepts string or JSValueHandle as key (JSValueHandle keys support symbols).
   *
   * All flags default to `false` when not specified.
   */
  defineProp(key: string | JSValueHandle, value: JSValueHandle, descriptor?: JSPropertyDescriptor): void {
    let flags = 0;
    if (descriptor?.configurable) flags |= 1; // JS_PROP_CONFIGURABLE
    if (descriptor?.writable) flags |= 2;     // JS_PROP_WRITABLE
    if (descriptor?.enumerable) flags |= 4;   // JS_PROP_ENUMERABLE
    if (typeof key === 'string') {
      const { ptr: namePtr } = this.vm._writeString(key);
      this.vm._getExports().qjs_define_prop_string(this.ptr, namePtr, value.ptr, flags);
      this.vm._getExports().wasm_free(namePtr);
    } else {
      this.vm._getExports().qjs_define_prop_value(this.ptr, key.ptr, value.ptr, flags);
    }
  }

  /**
   * Extract the value as a number.
   */
  toNumber(): number {
    return this.vm._getExports().qjs_get_float64(this.ptr);
  }

  /**
   * Extract the value as a BigInt.
   */
  toBigInt(): bigint {
    const e = this.vm._getExports();
    const loPtr = e.wasm_malloc(4);
    const hiPtr = e.wasm_malloc(4);
    const ret = e.qjs_get_big_int64(this.ptr, loPtr, hiPtr);
    if (ret !== 0) {
      e.wasm_free(loPtr);
      e.wasm_free(hiPtr);
      throw new Error('Failed to convert value to BigInt');
    }
    const view = new DataView(e.memory.buffer);
    const lo = view.getUint32(loPtr, true);
    const hi = view.getInt32(hiPtr, true); // signed for the high word
    e.wasm_free(loPtr);
    e.wasm_free(hiPtr);
    return (BigInt(hi) << 32n) | BigInt(lo);
  }

  /**
   * Extract the value as an ArrayBuffer (copies from WASM memory).
   * Works on ArrayBuffer values. For typed arrays, gets the underlying buffer.
   */
  toArrayBuffer(): ArrayBuffer {
    const e = this.vm._getExports();
    const lenOutPtr = e.wasm_malloc(4);

    if (e.qjs_is_array_buffer(this.ptr)) {
      const dataPtr = e.qjs_get_array_buffer(this.ptr, lenOutPtr);
      if (dataPtr === 0) {
        e.wasm_free(lenOutPtr);
        throw new Error('Failed to get ArrayBuffer data');
      }
      const view = new DataView(e.memory.buffer);
      const len = view.getUint32(lenOutPtr, true);
      e.wasm_free(lenOutPtr);
      // Copy out of WASM memory
      return new Uint8Array(e.memory.buffer, dataPtr, len).slice().buffer;
    }

    // Try typed array → underlying ArrayBuffer
    e.wasm_free(lenOutPtr);
    const byteOffsetPtr = e.wasm_malloc(4);
    const byteLengthPtr = e.wasm_malloc(4);
    const bytesPerElemPtr = e.wasm_malloc(4);
    const abPtr = e.qjs_get_typed_array_buffer(this.ptr, byteOffsetPtr, byteLengthPtr, bytesPerElemPtr);
    const abHandle = new JSValueHandle(this.vm, abPtr);

    if (this.vm._getExports().qjs_is_exception(abHandle.ptr) !== 0) {
      abHandle.dispose();
      e.wasm_free(byteOffsetPtr);
      e.wasm_free(byteLengthPtr);
      e.wasm_free(bytesPerElemPtr);
      throw new Error('Value is not an ArrayBuffer or typed array');
    }

    const view = new DataView(e.memory.buffer);
    const byteOffset = view.getUint32(byteOffsetPtr, true);
    const byteLength = view.getUint32(byteLengthPtr, true);
    e.wasm_free(byteOffsetPtr);
    e.wasm_free(byteLengthPtr);
    e.wasm_free(bytesPerElemPtr);

    // Get the raw data from the underlying ArrayBuffer
    const abLenPtr = e.wasm_malloc(4);
    const abDataPtr = e.qjs_get_array_buffer(abHandle.ptr, abLenPtr);
    e.wasm_free(abLenPtr);
    abHandle.dispose();

    if (abDataPtr === 0) {
      throw new Error('Failed to get ArrayBuffer data from typed array');
    }

    // Copy the relevant slice out of WASM memory
    return new Uint8Array(e.memory.buffer, abDataPtr + byteOffset, byteLength).slice().buffer;
  }

  /**
   * Extract the value as a Uint8Array (copies from WASM memory).
   * Works on Uint8Array, ArrayBuffer, and other typed array values.
   */
  toUint8Array(): Uint8Array {
    return new Uint8Array(this.toArrayBuffer());
  }

  /**
   * Extract the value as a string (calls JS_ToCString - works on any value).
   */
  toString(): string {
    const cstrPtr = this.vm._getExports().qjs_get_string(this.ptr);
    if (cstrPtr === 0) return '<null>';
    const str = this.vm._readCString(cstrPtr);
    this.vm._getExports().qjs_free_cstring(cstrPtr);
    return str;
  }

  /**
   * Use this handle, then dispose it. Returns the callback's return value.
   */
  consume<T>(fn: (handle: JSValueHandle) => T): T {
    try {
      return fn(this);
    } finally {
      this.dispose();
    }
  }

  /**
   * Duplicate this handle (increment refcount).
   */
  dup(): JSValueHandle {
    return new JSValueHandle(this.vm, this.vm._getExports().qjs_dup_value(this.ptr));
  }

  /**
   * Dispose this handle, freeing the heap-allocated JSValue.
   * Safe to call after the VM has been disposed (becomes a no-op).
   */
  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      // If the VM is already disposed, the WASM instance is gone —
      // no need to (and we can't) call qjs_free_value.
      const exports = this.vm._getExports();
      if (exports) {
        exports.qjs_free_value(this.ptr);
      }
    }
  }

  /**
   * Support for `using` declarations (Explicit Resource Management).
   * Automatically disposes the handle when it goes out of scope.
   *
   * ```typescript
   * using result = vm.evalCode('1 + 2');
   * console.log(result.toNumber()); // 3
   * // result is automatically disposed here
   * ```
   */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
