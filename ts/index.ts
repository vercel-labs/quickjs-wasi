/**
 * QuickJS WASM - A snapshotable JavaScript runtime via WebAssembly.
 *
 * Provides a clean JavaScript API for running sandboxed JS code in a QuickJS
 * VM compiled to WASM. The key differentiator is the ability to snapshot the
 * entire VM state (including pending promises) and restore it in a fresh
 * WASM instance.
 */

import { createWasiShim } from './wasi-shim.ts';

// ---- WASM Export Types ----

interface QuickJSExports {
  memory: WebAssembly.Memory;
  __stack_pointer: WebAssembly.Global;
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

  // Value extraction
  qjs_get_float64(valPtr: number): number;
  qjs_get_string(valPtr: number): number;
  qjs_free_cstring(strPtr: number): void;
  qjs_typeof(valPtr: number): number;
  qjs_is_exception(valPtr: number): number;
  qjs_is_undefined(valPtr: number): number;

  // Value management
  qjs_dup_value(valPtr: number): number;
  qjs_free_value(valPtr: number): void;

  // Property operations
  qjs_get_global(): number;
  qjs_get_prop_string(objPtr: number, namePtr: number): number;
  qjs_set_prop_string(objPtr: number, namePtr: number, valPtr: number): number;

  // Function calls
  qjs_call(funcPtr: number, thisPtr: number, argc: number, argvPtr: number): number;

  // Promise operations
  qjs_new_promise(resolveOutPtr: number, rejectOutPtr: number): number;
  qjs_promise_state(promisePtr: number): number;
  qjs_promise_result(promisePtr: number): number;

  // Job queue
  qjs_is_job_pending(): number;
  qjs_execute_pending_job(): number;

  // Error handling
  qjs_get_exception(): number;

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

export interface Snapshot {
  /** The raw WASM linear memory contents */
  memory: Uint8Array;
  /** The stack pointer value at snapshot time */
  stackPointer: number;
  /** Size of memory in WASM pages (64KB each) */
  memoryPages: number;
  /** Pointer to JSRuntime in the WASM memory */
  runtimePtr: number;
  /** Pointer to JSContext in the WASM memory */
  contextPtr: number;
}

// ---- QuickJS VM ----

export class QuickJS {
  private exports: QuickJSExports;
  private module: WebAssembly.Module;
  private instance: WebAssembly.Instance;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private disposed = false;

  private constructor(
    module: WebAssembly.Module,
    instance: WebAssembly.Instance,
  ) {
    this.module = module;
    this.instance = instance;
    this.exports = instance.exports as unknown as QuickJSExports;
  }

  /**
   * Create a fresh QuickJS VM instance.
   */
  static async create(wasmInput?: BufferSource | WebAssembly.Module): Promise<QuickJS> {
    let module: WebAssembly.Module;

    if (wasmInput instanceof WebAssembly.Module) {
      module = wasmInput;
    } else if (wasmInput) {
      module = await WebAssembly.compile(wasmInput);
    } else {
      // Default: load from adjacent file
      const fs = await import('node:fs');
      const path = await import('node:path');
      const url = await import('node:url');
      const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
      const wasmPath = path.resolve(__dirname, '..', 'quickjs.wasm');
      const buf = fs.readFileSync(wasmPath);
      module = await WebAssembly.compile(buf);
    }

    const instance = await QuickJS.instantiate(module);
    const exports = instance.exports as unknown as QuickJSExports;

    // Initialize the WASI reactor
    exports._initialize();

    // Initialize QuickJS runtime and context
    const result = exports.qjs_init();
    if (result !== 0) {
      throw new Error('Failed to initialize QuickJS runtime');
    }

    return new QuickJS(module, instance);
  }

  /**
   * Restore a QuickJS VM from a snapshot.
   * The restored VM will have all the state from the snapshot, including
   * pending promises that can be resolved.
   */
  static async restore(snapshot: Snapshot, wasmInput?: BufferSource | WebAssembly.Module): Promise<QuickJS> {
    let module: WebAssembly.Module;

    if (wasmInput instanceof WebAssembly.Module) {
      module = wasmInput;
    } else if (wasmInput) {
      module = await WebAssembly.compile(wasmInput);
    } else {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const url = await import('node:url');
      const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
      const wasmPath = path.resolve(__dirname, '..', 'quickjs.wasm');
      const buf = fs.readFileSync(wasmPath);
      module = await WebAssembly.compile(buf);
    }

    // Create a memory pre-sized to the snapshot
    const memory = new WebAssembly.Memory({
      initial: snapshot.memoryPages,
    });

    // Copy the snapshotted memory in
    const target = new Uint8Array(memory.buffer);
    target.set(snapshot.memory);

    // Instantiate with the pre-populated memory
    const instance = await QuickJS.instantiateWithMemory(module, memory);
    const exports = instance.exports as unknown as QuickJSExports;

    // IMPORTANT: Do NOT call _initialize() or qjs_init() here!
    // The runtime and context already exist in the restored memory.
    // We just need to tell our interface layer where they are.
    exports.qjs_set_runtime_and_context(snapshot.runtimePtr, snapshot.contextPtr);

    // Restore the stack pointer
    exports.__stack_pointer.value = snapshot.stackPointer;

    return new QuickJS(module, instance);
  }

  // ---- Internal instantiation helpers ----

  private static async instantiate(module: WebAssembly.Module): Promise<WebAssembly.Instance> {
    let memory: WebAssembly.Memory | null = null;
    const wasiShim = createWasiShim(() => memory!);

    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: wasiShim,
    });

    memory = (instance.exports as any).memory as WebAssembly.Memory;
    return instance;
  }

  private static async instantiateWithMemory(
    module: WebAssembly.Module,
    memory: WebAssembly.Memory,
  ): Promise<WebAssembly.Instance> {
    const wasiShim = createWasiShim(() => memory);

    // We need to check if the module imports memory or exports it.
    // WASI reactor modules typically export their own memory.
    // But we want to inject our pre-filled memory.
    // The trick: WASI modules export `memory`. We can't inject it directly
    // if the module defines its own memory. Instead, we'll instantiate normally
    // and then copy the snapshot data into the exported memory.

    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: wasiShim,
    });

    const exportedMemory = (instance.exports as any).memory as WebAssembly.Memory;

    // Grow the exported memory to match the snapshot if needed
    const currentPages = exportedMemory.buffer.byteLength / 65536;
    const neededPages = memory.buffer.byteLength / 65536;
    if (neededPages > currentPages) {
      exportedMemory.grow(neededPages - currentPages);
    }

    // Copy snapshot data into the module's own memory
    const src = new Uint8Array(memory.buffer);
    const dst = new Uint8Array(exportedMemory.buffer);
    dst.set(src);

    return instance;
  }

  // ---- String helpers ----

  /** Write a JS string into WASM memory, returning the pointer. Caller must free. */
  private writeString(str: string): { ptr: number; len: number } {
    const encoded = this.encoder.encode(str);
    const ptr = this.exports.wasm_malloc(encoded.length + 1); // +1 for null terminator
    if (ptr === 0) throw new Error('wasm_malloc failed');
    const mem = new Uint8Array(this.exports.memory.buffer);
    mem.set(encoded, ptr);
    mem[ptr + encoded.length] = 0; // null terminator
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
   * Evaluate JavaScript code and return the result as a handle.
   */
  evalCode(code: string, filename: string = '<eval>'): JSValueHandle {
    this.assertNotDisposed();
    const codeStr = this.writeString(code);
    const fnStr = this.writeString(filename);
    const resultPtr = this.exports.qjs_eval(codeStr.ptr, codeStr.len, fnStr.ptr, 0);
    this.exports.wasm_free(codeStr.ptr);
    this.exports.wasm_free(fnStr.ptr);
    return new JSValueHandle(this, resultPtr);
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
        // Error executing job
        const exc = this.getException();
        throw new Error(`Job execution error: ${exc.toString()}`);
      }
      count++;
    }
    return count;
  }

  /**
   * Get the global object.
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
   * Create a new QuickJS object value.
   */
  newObject(): JSValueHandle {
    this.assertNotDisposed();
    return new JSValueHandle(this, this.exports.qjs_new_object());
  }

  /**
   * Get undefined.
   */
  getUndefined(): JSValueHandle {
    this.assertNotDisposed();
    return new JSValueHandle(this, this.exports.qjs_get_undefined());
  }

  /**
   * Create a new promise, returning the promise handle and resolve/reject functions.
   */
  newPromise(): { promise: JSValueHandle; resolve: JSValueHandle; reject: JSValueHandle } {
    this.assertNotDisposed();
    // Allocate space for the output pointers (2 x i32 = 8 bytes)
    const resolveOutPtr = this.exports.wasm_malloc(4);
    const rejectOutPtr = this.exports.wasm_malloc(4);

    const promisePtr = this.exports.qjs_new_promise(resolveOutPtr, rejectOutPtr);

    // Read back the pointers to resolve/reject JSValue handles
    const view = new DataView(this.exports.memory.buffer);
    const resolvePtr = view.getUint32(resolveOutPtr, true);
    const rejectPtr = view.getUint32(rejectOutPtr, true);

    this.exports.wasm_free(resolveOutPtr);
    this.exports.wasm_free(rejectOutPtr);

    return {
      promise: new JSValueHandle(this, promisePtr),
      resolve: new JSValueHandle(this, resolvePtr),
      reject: new JSValueHandle(this, rejectPtr),
    };
  }

  /**
   * Call a QuickJS function.
   */
  callFunction(func: JSValueHandle, thisVal: JSValueHandle, ...args: JSValueHandle[]): JSValueHandle {
    this.assertNotDisposed();
    const argc = args.length;

    // Build the argv array in WASM memory (array of pointers)
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
   * Get the current exception, if any.
   */
  getException(): JSValueHandle {
    this.assertNotDisposed();
    return new JSValueHandle(this, this.exports.qjs_get_exception());
  }

  // ---- Snapshot / Restore ----

  /**
   * Snapshot the entire VM state.
   * The returned snapshot can be used to restore the VM in a completely
   * fresh WASM instance, preserving all JS state including pending promises.
   */
  snapshot(): Snapshot {
    this.assertNotDisposed();

    const memory = this.exports.memory;
    const memoryBytes = new Uint8Array(memory.buffer);
    const memoryPages = memory.buffer.byteLength / 65536;

    return {
      memory: memoryBytes.slice(), // Copy the entire linear memory
      stackPointer: this.exports.__stack_pointer.value as number,
      memoryPages,
      runtimePtr: this.exports.qjs_get_runtime_ptr(),
      contextPtr: this.exports.qjs_get_context_ptr(),
    };
  }

  /**
   * Dispose the VM, freeing all resources.
   * If leakCheck is false, the runtime is abandoned without freeing
   * (useful when you don't need clean shutdown, e.g. after snapshotting).
   */
  dispose(leakCheck: boolean = true): void {
    if (!this.disposed) {
      this.disposed = true;
      if (leakCheck) {
        try {
          this.exports.qjs_destroy();
        } catch {
          // QuickJS may assert if there are leaked objects in debug builds.
          // For the PoC, we swallow this - proper handle tracking will fix it.
        }
      }
      // If leakCheck is false, we just mark as disposed without calling qjs_destroy.
      // The WASM instance will be GC'd by the host JS engine.
    }
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

// ---- JSValue Handle ----

/**
 * A handle to a JSValue inside the QuickJS WASM instance.
 * The handle holds a pointer to a heap-allocated JSValue in WASM memory.
 */
export class JSValueHandle {
  private vm: QuickJS;
  /** @internal - pointer to heap-allocated JSValue in WASM memory */
  readonly ptr: number;
  private disposed = false;

  constructor(vm: QuickJS, ptr: number) {
    this.vm = vm;
    this.ptr = ptr;
  }

  /**
   * Get the JS typeof tag.
   */
  get isException(): boolean {
    return this.vm._getExports().qjs_is_exception(this.ptr) !== 0;
  }

  get isUndefined(): boolean {
    return this.vm._getExports().qjs_is_undefined(this.ptr) !== 0;
  }

  /**
   * Get the promise state: 0 = pending, 1 = fulfilled, 2 = rejected
   */
  get promiseState(): number {
    return this.vm._getExports().qjs_promise_state(this.ptr);
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
   * Extract the value as a number.
   */
  toNumber(): number {
    return this.vm._getExports().qjs_get_float64(this.ptr);
  }

  /**
   * Extract the value as a string.
   */
  toString(): string {
    const cstrPtr = this.vm._getExports().qjs_get_string(this.ptr);
    if (cstrPtr === 0) return '<null>';
    const str = this.vm._readCString(cstrPtr);
    this.vm._getExports().qjs_free_cstring(cstrPtr);
    return str;
  }

  /**
   * Duplicate this handle (increment refcount).
   */
  dup(): JSValueHandle {
    return new JSValueHandle(this.vm, this.vm._getExports().qjs_dup_value(this.ptr));
  }

  /**
   * Dispose this handle, freeing the heap-allocated JSValue.
   */
  dispose(): void {
    if (!this.disposed) {
      this.vm._getExports().qjs_free_value(this.ptr);
      this.disposed = true;
    }
  }
}
