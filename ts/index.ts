/**
 * QuickJS WASM - A snapshotable JavaScript runtime via WebAssembly.
 *
 * Provides a clean JavaScript API for running sandboxed JS code in a QuickJS
 * VM compiled to WASM. The key differentiator is the ability to snapshot the
 * entire VM state (including pending promises) and restore it in a fresh
 * WASM instance.
 */

import { createWasiShim } from './wasi-shim.ts';

// ---- Type for host callback functions ----

export type HostFunction = (this_val: JSValueHandle, ...args: JSValueHandle[]) => JSValueHandle;

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
  qjs_is_null(valPtr: number): number;
  qjs_is_bool(valPtr: number): number;
  qjs_is_number(valPtr: number): number;
  qjs_is_string(valPtr: number): number;
  qjs_is_object(valPtr: number): number;
  qjs_is_array(valPtr: number): number;
  qjs_is_function(valPtr: number): number;
  qjs_is_error(valPtr: number): number;
  qjs_is_promise(valPtr: number): number;
  qjs_get_bool(valPtr: number): number;

  // Value management
  qjs_dup_value(valPtr: number): number;
  qjs_free_value(valPtr: number): void;

  // Property operations
  qjs_get_global(): number;
  qjs_get_prop_string(objPtr: number, namePtr: number): number;
  qjs_set_prop_string(objPtr: number, namePtr: number, valPtr: number): number;
  qjs_get_prop_uint32(objPtr: number, idx: number): number;
  qjs_set_prop_uint32(objPtr: number, idx: number, valPtr: number): number;

  // Function calls
  qjs_call(funcPtr: number, thisPtr: number, argc: number, argvPtr: number): number;

  // Host function registration
  qjs_new_host_function(namePtr: number, nameLen: number, funcId: number, argCount: number): number;

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

// ---- Deferred promise type ----

export interface Deferred {
  /** Handle to the QuickJS promise object */
  promise: JSValueHandle;
  /** Handle to the resolve function */
  resolve: JSValueHandle;
  /** Handle to the reject function */
  reject: JSValueHandle;
  /** A host-side Promise that resolves when the QuickJS promise settles */
  settled: Promise<void>;
}

// ---- QuickJS VM ----

export class QuickJS {
  private exports: QuickJSExports;
  private module: WebAssembly.Module;
  private instance: WebAssembly.Instance;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private disposed = false;

  /** Registry of host callbacks, keyed by integer ID */
  private hostCallbacks = new Map<number, HostFunction>();
  private nextCallbackId = 1;

  private constructor(module: WebAssembly.Module) {
    this.module = module;
    this.instance = null!;
    this.exports = null!;
  }

  private setInstance(instance: WebAssembly.Instance) {
    this.instance = instance;
    this.exports = instance.exports as unknown as QuickJSExports;
  }

  /**
   * Create a fresh QuickJS VM instance.
   */
  static async create(wasmInput?: BufferSource | WebAssembly.Module): Promise<QuickJS> {
    const module = await QuickJS.resolveModule(wasmInput);
    const vm = new QuickJS(module);
    const instance = await QuickJS.instantiate(module, vm);
    vm.setInstance(instance);

    // Initialize the WASI reactor
    vm.exports._initialize();

    // Initialize QuickJS runtime and context
    const result = vm.exports.qjs_init();
    if (result !== 0) {
      throw new Error('Failed to initialize QuickJS runtime');
    }

    return vm;
  }

  /**
   * Restore a QuickJS VM from a snapshot.
   */
  static async restore(snapshot: Snapshot, wasmInput?: BufferSource | WebAssembly.Module): Promise<QuickJS> {
    const module = await QuickJS.resolveModule(wasmInput);
    const vm = new QuickJS(module);
    const instance = await QuickJS.instantiate(module, vm);
    vm.setInstance(instance);

    const exportedMemory = vm.exports.memory;

    // Grow the exported memory to match the snapshot if needed
    const currentPages = exportedMemory.buffer.byteLength / 65536;
    const neededPages = snapshot.memoryPages;
    if (neededPages > currentPages) {
      exportedMemory.grow(neededPages - currentPages);
    }

    // Copy snapshot data into the module's own memory
    const dst = new Uint8Array(exportedMemory.buffer);
    dst.set(snapshot.memory);

    // Set runtime/context pointers (they already exist in the restored memory)
    vm.exports.qjs_set_runtime_and_context(snapshot.runtimePtr, snapshot.contextPtr);

    // Restore the stack pointer
    vm.exports.__stack_pointer.value = snapshot.stackPointer;

    return vm;
  }

  // ---- Internal instantiation helpers ----

  private static async resolveModule(wasmInput?: BufferSource | WebAssembly.Module): Promise<WebAssembly.Module> {
    if (wasmInput instanceof WebAssembly.Module) {
      return wasmInput;
    } else if (wasmInput) {
      return WebAssembly.compile(wasmInput);
    } else {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const url = await import('node:url');
      const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
      const wasmPath = path.resolve(__dirname, '..', 'quickjs.wasm');
      const buf = fs.readFileSync(wasmPath);
      return WebAssembly.compile(buf);
    }
  }

  private static async instantiate(module: WebAssembly.Module, vm: QuickJS): Promise<WebAssembly.Instance> {
    let memory: WebAssembly.Memory | null = null;
    const wasiShim = createWasiShim(() => memory!);

    const hostCall = (funcId: number, thisPtr: number, argc: number, argvPtr: number): number => {
      return vm.handleHostCall(funcId, thisPtr, argc, argvPtr);
    };

    const instance = await WebAssembly.instantiate(module, {
      env: { host_call: hostCall },
      wasi_snapshot_preview1: wasiShim,
    });

    memory = (instance.exports as any).memory as WebAssembly.Memory;
    return instance;
  }

  /**
   * Called from WASM when a host function is invoked from QuickJS code.
   */
  private handleHostCall(funcId: number, thisPtr: number, argc: number, argvPtr: number): number {
    const callback = this.hostCallbacks.get(funcId);
    if (!callback) {
      // Return undefined if callback not found (e.g. after restore without re-registration)
      return this.exports.qjs_get_undefined();
    }

    // Wrap the this pointer
    const thisHandle = new JSValueHandle(this, thisPtr);

    // Read the argv pointers from WASM memory
    const args: JSValueHandle[] = [];
    if (argc > 0 && argvPtr !== 0) {
      const view = new DataView(this.exports.memory.buffer);
      for (let i = 0; i < argc; i++) {
        const argPtr = view.getUint32(argvPtr + i * 4, true);
        args.push(new JSValueHandle(this, argPtr));
      }
    }

    try {
      const result = callback.call(undefined, thisHandle, ...args);
      // Dup the result so the C side can own it
      return this.exports.qjs_dup_value(result.ptr);
    } catch (err) {
      // If the host callback throws, create an error in QuickJS
      const errStr = err instanceof Error ? err.message : String(err);
      const errHandle = this.newError(errStr);
      // Return the error as an exception
      const excPtr = this.exports.qjs_dup_value(errHandle.ptr);
      errHandle.dispose();
      return excPtr;
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
   * Create a new QuickJS array value.
   */
  newArray(): JSValueHandle {
    this.assertNotDisposed();
    return new JSValueHandle(this, this.exports.qjs_new_array());
  }

  /**
   * Get undefined.
   */
  getUndefined(): JSValueHandle {
    this.assertNotDisposed();
    return new JSValueHandle(this, this.exports.qjs_get_undefined());
  }

  /**
   * Get null.
   */
  getNull(): JSValueHandle {
    this.assertNotDisposed();
    return new JSValueHandle(this, this.exports.qjs_get_null());
  }

  /**
   * Get true.
   */
  getTrue(): JSValueHandle {
    this.assertNotDisposed();
    return new JSValueHandle(this, this.exports.qjs_get_true());
  }

  /**
   * Get false.
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
    const funcId = this.nextCallbackId++;
    this.hostCallbacks.set(funcId, fn);

    const { ptr: namePtr, len: nameLen } = this.writeString(name);
    const resultPtr = this.exports.qjs_new_host_function(namePtr, nameLen, funcId, 0);
    this.exports.wasm_free(namePtr);
    return new JSValueHandle(this, resultPtr);
  }

  /**
   * Create a new promise, returning the promise handle, resolve/reject functions,
   * and a host-side Promise that settles when the QuickJS promise settles.
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

    const promise = new JSValueHandle(this, promisePtr);
    const resolve = new JSValueHandle(this, resolvePtr);
    const reject = new JSValueHandle(this, rejectPtr);

    // Create a host-side Promise that resolves when the QuickJS promise settles.
    // We attach a .then/.catch handler on the QuickJS side that calls back to the host.
    let settledResolve: () => void;
    const settled = new Promise<void>((res) => {
      settledResolve = res;
    });

    // Register a temporary host callback that resolves the settled promise
    const settleCallbackId = this.nextCallbackId++;
    this.hostCallbacks.set(settleCallbackId, () => {
      settledResolve();
      this.hostCallbacks.delete(settleCallbackId);
      return this.getUndefined();
    });

    // Create a host function for the settle callback and attach it
    const { ptr: onSettleName, len: onSettleNameLen } = this.writeString('__onSettle');
    const onSettleFn = new JSValueHandle(this, this.exports.qjs_new_host_function(onSettleName, onSettleNameLen, settleCallbackId, 0));
    this.exports.wasm_free(onSettleName);

    // Attach .then(onSettle, onSettle) to the promise
    const thenFn = promise.getProp('then');
    const undef = this.getUndefined();
    const onSettleDup = onSettleFn.dup();
    this.callFunction(thenFn, promise, onSettleFn, onSettleDup).dispose();
    thenFn.dispose();
    undef.dispose();
    onSettleFn.dispose();
    onSettleDup.dispose();

    return { promise, resolve, reject, settled };
  }

  /**
   * Call a QuickJS function.
   */
  callFunction(func: JSValueHandle, thisVal: JSValueHandle, ...args: JSValueHandle[]): JSValueHandle {
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
   * Get the current exception, if any.
   */
  getException(): JSValueHandle {
    this.assertNotDisposed();
    return new JSValueHandle(this, this.exports.qjs_get_exception());
  }

  /**
   * Create a new QuickJS Error object with the given message.
   */
  newError(message: string): JSValueHandle {
    this.assertNotDisposed();
    const errPtr = this.exports.qjs_new_error();
    const errHandle = new JSValueHandle(this, errPtr);
    const msgHandle = this.newString(message);
    errHandle.setProp('message', msgHandle);
    msgHandle.dispose();
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
    if (e.qjs_is_string(handle.ptr)) return 'string';
    if (e.qjs_is_function(handle.ptr)) return 'function';
    if (e.qjs_is_object(handle.ptr)) return 'object';
    return 'unknown';
  }

  /**
   * Convert a QuickJS handle to a host JavaScript value.
   * Handles strings, numbers, booleans, null, undefined, arrays, and plain objects.
   * Functions and other complex types are returned as-is (the handle).
   */
  dump(handle: JSValueHandle): unknown {
    this.assertNotDisposed();
    const e = this.exports;

    if (e.qjs_is_undefined(handle.ptr)) return undefined;
    if (e.qjs_is_null(handle.ptr)) return null;
    if (e.qjs_is_bool(handle.ptr)) return e.qjs_get_bool(handle.ptr) !== 0;
    if (e.qjs_is_number(handle.ptr)) return e.qjs_get_float64(handle.ptr);
    if (e.qjs_is_string(handle.ptr)) return handle.toString();

    if (e.qjs_is_exception(handle.ptr)) {
      const exc = this.getException();
      const msg = exc.toString();
      exc.dispose();
      return new Error(msg);
    }

    if (e.qjs_is_array(handle.ptr)) {
      const lenHandle = handle.getProp('length');
      const len = e.qjs_get_float64(lenHandle.ptr);
      lenHandle.dispose();
      const arr: unknown[] = [];
      for (let i = 0; i < len; i++) {
        const elemPtr = e.qjs_get_prop_uint32(handle.ptr, i);
        const elemHandle = new JSValueHandle(this, elemPtr);
        arr.push(this.dump(elemHandle));
        elemHandle.dispose();
      }
      return arr;
    }

    if (e.qjs_is_error(handle.ptr)) {
      const msgHandle = handle.getProp('message');
      const msg = msgHandle.toString();
      msgHandle.dispose();
      return new Error(msg);
    }

    if (e.qjs_is_object(handle.ptr)) {
      // For plain objects, we can't easily enumerate keys from C.
      // Use JSON.stringify as a workaround for the PoC.
      const jsonResult = this.evalCode(`(v) => JSON.stringify(v)`);
      if (jsonResult.isException) {
        jsonResult.dispose();
        return '[object Object]';
      }
      const undef = this.getUndefined();
      const jsonStr = this.callFunction(jsonResult, undef, handle);
      jsonResult.dispose();
      undef.dispose();
      if (jsonStr.isException || this.exports.qjs_is_undefined(jsonStr.ptr)) {
        jsonStr.dispose();
        return '[object Object]';
      }
      const str = jsonStr.toString();
      jsonStr.dispose();
      try {
        return JSON.parse(str);
      } catch {
        return str;
      }
    }

    return undefined;
  }

  /**
   * Convert a host JavaScript value to a QuickJS handle.
   */
  hostToHandle(value: unknown): JSValueHandle {
    this.assertNotDisposed();
    if (value === undefined) return this.getUndefined();
    if (value === null) return this.getNull();
    if (value === true) return this.getTrue();
    if (value === false) return this.getFalse();
    if (typeof value === 'number') return this.newNumber(value);
    if (typeof value === 'string') return this.newString(value);

    if (Array.isArray(value)) {
      const arr = this.newArray();
      for (let i = 0; i < value.length; i++) {
        const elemHandle = this.hostToHandle(value[i]);
        const view = new DataView(this.exports.memory.buffer);
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

    return this.getUndefined();
  }

  // ---- Snapshot / Restore ----

  /**
   * Snapshot the entire VM state.
   */
  snapshot(): Snapshot {
    this.assertNotDisposed();

    const memory = this.exports.memory;
    const memoryBytes = new Uint8Array(memory.buffer);
    const memoryPages = memory.buffer.byteLength / 65536;

    return {
      memory: memoryBytes.slice(),
      stackPointer: this.exports.__stack_pointer.value as number,
      memoryPages,
      runtimePtr: this.exports.qjs_get_runtime_ptr(),
      contextPtr: this.exports.qjs_get_context_ptr(),
    };
  }

  /**
   * Re-register a host callback after restoring from a snapshot.
   * The func_id must match the ID that was used before the snapshot.
   */
  registerHostCallback(funcId: number, fn: HostFunction): void {
    this.hostCallbacks.set(funcId, fn);
    // Ensure the next allocated ID doesn't collide
    if (funcId >= this.nextCallbackId) {
      this.nextCallbackId = funcId + 1;
    }
  }

  /**
   * Dispose the VM, freeing all resources.
   */
  dispose(leakCheck: boolean = true): void {
    if (!this.disposed) {
      this.disposed = true;
      if (leakCheck) {
        try {
          this.exports.qjs_destroy();
        } catch {
          // QuickJS may assert if there are leaked objects in debug builds.
        }
      }
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
 */
export class JSValueHandle {
  private vm: QuickJS;
  /** @internal */
  readonly ptr: number;
  private disposed = false;

  constructor(vm: QuickJS, ptr: number) {
    this.vm = vm;
    this.ptr = ptr;
  }

  get isException(): boolean {
    return this.vm._getExports().qjs_is_exception(this.ptr) !== 0;
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
   */
  dispose(): void {
    if (!this.disposed) {
      this.vm._getExports().qjs_free_value(this.ptr);
      this.disposed = true;
    }
  }
}
