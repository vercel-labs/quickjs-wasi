/*
 * QuickJS WASM Interface Layer
 *
 * Thin C wrapper around the QuickJS API that exports WASM-friendly functions.
 * All JSValue types are heap-allocated and passed as pointers (i32 in WASM).
 *
 * This is compiled as a WASI reactor - no main(), exports are called by the host.
 */

#include "quickjs.h"
#include <stdlib.h>
#include <string.h>

/* ---- Module-level state ---- */

static JSRuntime *rt = NULL;
static JSContext *ctx = NULL;

/* ---- Helper: heap-allocate a JSValue so it can cross the WASM boundary ---- */

static JSValue *jsvalue_to_heap(JSValue val) {
    JSValue *ptr = (JSValue *)malloc(sizeof(JSValue));
    if (ptr) {
        *ptr = val;
    }
    return ptr;
}

/* ---- Host callback support ---- */

/*
 * Imported from the host environment. When QuickJS calls a host function,
 * this import is invoked with:
 *   func_id  - the callback ID assigned by the host
 *   this_ptr - pointer to heap-allocated JSValue for 'this'
 *   argc     - argument count
 *   argv_ptr - pointer to array of JSValue* pointers in WASM memory
 *
 * Returns a pointer to a heap-allocated JSValue (the return value).
 */
__attribute__((import_module("env"), import_name("host_call")))
extern JSValue *host_call(int func_id, JSValue *this_ptr, int argc, JSValue **argv_ptr);

/*
 * Imported from the host environment. Called periodically during JS execution
 * when an interrupt handler is enabled. Returns non-zero to interrupt execution.
 */
__attribute__((import_module("env"), import_name("host_interrupt")))
extern int host_interrupt(void);

/*
 * Interrupt handler trampoline: dispatches to the host_interrupt import.
 */
static int interrupt_handler_trampoline(JSRuntime *rt, void *opaque)
{
    (void)rt;
    (void)opaque;
    return host_interrupt();
}

/*
 * Trampoline: a JSCFunctionData callback that dispatches to the host.
 * The func_id is stored in func_data[0] as an integer.
 */
static JSValue host_callback_trampoline(JSContext *ctx, JSValueConst this_val,
                                         int argc, JSValueConst *argv,
                                         int magic, JSValueConst *func_data)
{
    (void)magic;

    /* Extract the func_id from func_data[0] */
    int func_id;
    JS_ToInt32(ctx, &func_id, func_data[0]);

    /* Heap-allocate this_val for the host */
    JSValue *this_ptr = jsvalue_to_heap(JS_DupValue(ctx, this_val));

    /* Heap-allocate each argument for the host */
    JSValue **argv_ptrs = NULL;
    if (argc > 0) {
        argv_ptrs = (JSValue **)malloc(sizeof(JSValue *) * argc);
        for (int i = 0; i < argc; i++) {
            argv_ptrs[i] = jsvalue_to_heap(JS_DupValue(ctx, argv[i]));
        }
    }

    /* Call into the host */
    JSValue *result_ptr = host_call(func_id, this_ptr, argc, argv_ptrs);

    /* Extract and dup the result, then free the pointer.
       NULL means the host threw an exception (via qjs_throw). */
    JSValue result;
    if (result_ptr) {
        result = JS_DupValue(ctx, *result_ptr);
        JS_FreeValue(ctx, *result_ptr);
        free(result_ptr);
    } else {
        result = JS_EXCEPTION;
    }

    /* Free the this_ptr (was dup'd for host) */
    JS_FreeValue(ctx, *this_ptr);
    free(this_ptr);

    /* Free the argv pointers (were dup'd for host) */
    if (argv_ptrs) {
        for (int i = 0; i < argc; i++) {
            JS_FreeValue(ctx, *argv_ptrs[i]);
            free(argv_ptrs[i]);
        }
        free(argv_ptrs);
    }

    return result;
}

/* ---- Lifecycle ---- */

__attribute__((export_name("qjs_init")))
int qjs_init(void) {
    if (rt) return -1; /* already initialized */

    rt = JS_NewRuntime();
    if (!rt) return -1;

    ctx = JS_NewContext(rt);
    if (!ctx) {
        JS_FreeRuntime(rt);
        rt = NULL;
        return -1;
    }

    return 0;
}

/* ---- Runtime Limits ---- */

__attribute__((export_name("qjs_set_interrupt_handler")))
void qjs_set_interrupt_handler(int enable) {
    if (rt) {
        if (enable) {
            JS_SetInterruptHandler(rt, interrupt_handler_trampoline, NULL);
        } else {
            JS_SetInterruptHandler(rt, NULL, NULL);
        }
    }
}

__attribute__((export_name("qjs_set_memory_limit")))
void qjs_set_memory_limit(size_t limit) {
    if (rt) JS_SetMemoryLimit(rt, limit);
}

__attribute__((export_name("qjs_set_max_stack_size")))
void qjs_set_max_stack_size(size_t size) {
    if (rt) JS_SetMaxStackSize(rt, size);
}

__attribute__((export_name("qjs_destroy")))
void qjs_destroy(void) {
    if (ctx) {
        /* Run GC to collect any cycles before freeing the context */
        if (rt) JS_RunGC(rt);
        JS_FreeContext(ctx);
        ctx = NULL;
    }
    if (rt) {
        JS_FreeRuntime(rt);
        rt = NULL;
    }
}

/* ---- Evaluation ---- */

__attribute__((export_name("qjs_eval")))
JSValue *qjs_eval(const char *code, size_t len, const char *filename, int eval_flags) {
    JSValue result = JS_Eval(ctx, code, len, filename, eval_flags);
    return jsvalue_to_heap(result);
}

/* ---- Value Creation ---- */

__attribute__((export_name("qjs_new_string")))
JSValue *qjs_new_string(const char *str, size_t len) {
    JSValue val = JS_NewStringLen(ctx, str, len);
    return jsvalue_to_heap(val);
}

__attribute__((export_name("qjs_new_number")))
JSValue *qjs_new_number(double num) {
    JSValue val = JS_NewFloat64(ctx, num);
    return jsvalue_to_heap(val);
}

__attribute__((export_name("qjs_new_object")))
JSValue *qjs_new_object(void) {
    JSValue val = JS_NewObject(ctx);
    return jsvalue_to_heap(val);
}

__attribute__((export_name("qjs_new_array")))
JSValue *qjs_new_array(void) {
    JSValue val = JS_NewArray(ctx);
    return jsvalue_to_heap(val);
}

__attribute__((export_name("qjs_get_undefined")))
JSValue *qjs_get_undefined(void) {
    return jsvalue_to_heap(JS_UNDEFINED);
}

__attribute__((export_name("qjs_get_null")))
JSValue *qjs_get_null(void) {
    return jsvalue_to_heap(JS_NULL);
}

__attribute__((export_name("qjs_get_true")))
JSValue *qjs_get_true(void) {
    return jsvalue_to_heap(JS_TRUE);
}

__attribute__((export_name("qjs_get_false")))
JSValue *qjs_get_false(void) {
    return jsvalue_to_heap(JS_FALSE);
}

__attribute__((export_name("qjs_new_symbol")))
JSValue *qjs_new_symbol(const char *description, size_t len, int is_global) {
    (void)len;
    return jsvalue_to_heap(JS_NewSymbol(ctx, description, is_global != 0));
}

/*
 * Get the description of a symbol. For global symbols (Symbol.for()),
 * returns the key via Symbol.keyFor(). For local symbols, returns
 * the description property.
 *
 * Returns:
 *   0 = not a symbol
 *   1 = global symbol (description written to out)
 *   2 = local symbol (description written to out)
 */
__attribute__((export_name("qjs_get_symbol_description")))
int qjs_get_symbol_description(JSValue *val, JSValue **desc_out) {
    if (!JS_IsSymbol(*val)) return 0;

    /* Try Symbol.keyFor(sym) to detect global symbols */
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue symbol_obj = JS_GetPropertyStr(ctx, global, "Symbol");
    JSValue key_for_fn = JS_GetPropertyStr(ctx, symbol_obj, "keyFor");
    JSValue key_for_result = JS_Call(ctx, key_for_fn, symbol_obj, 1, val);
    JS_FreeValue(ctx, key_for_fn);
    JS_FreeValue(ctx, symbol_obj);
    JS_FreeValue(ctx, global);

    if (!JS_IsUndefined(key_for_result)) {
        /* Global symbol — keyFor returned the description string */
        *desc_out = jsvalue_to_heap(key_for_result);
        return 1;
    }
    JS_FreeValue(ctx, key_for_result);

    /* Local symbol — get the .description property */
    JSValue desc = JS_GetPropertyStr(ctx, *val, "description");
    *desc_out = jsvalue_to_heap(desc);
    return 2;
}

/* ---- Value Extraction ---- */

__attribute__((export_name("qjs_get_float64")))
double qjs_get_float64(JSValue *val) {
    double d;
    JS_ToFloat64(ctx, &d, *val);
    return d;
}

__attribute__((export_name("qjs_get_string")))
const char *qjs_get_string(JSValue *val) {
    /* Returns a pointer into WASM memory. Caller must call qjs_free_cstring. */
    return JS_ToCString(ctx, *val);
}

__attribute__((export_name("qjs_free_cstring")))
void qjs_free_cstring(const char *str) {
    JS_FreeCString(ctx, str);
}

__attribute__((export_name("qjs_typeof")))
int qjs_typeof(JSValue *val) {
    /* Returns JS_TAG values: 0=int, 7=float64, -1=object, -7=string, etc. */
    return JS_VALUE_GET_TAG(*val);
}

__attribute__((export_name("qjs_is_exception")))
int qjs_is_exception(JSValue *val) {
    return JS_IsException(*val);
}

__attribute__((export_name("qjs_is_undefined")))
int qjs_is_undefined(JSValue *val) {
    return JS_IsUndefined(*val);
}

__attribute__((export_name("qjs_is_null")))
int qjs_is_null(JSValue *val) {
    return JS_IsNull(*val);
}

__attribute__((export_name("qjs_is_bool")))
int qjs_is_bool(JSValue *val) {
    return JS_IsBool(*val);
}

__attribute__((export_name("qjs_is_number")))
int qjs_is_number(JSValue *val) {
    return JS_IsNumber(*val);
}

__attribute__((export_name("qjs_is_string")))
int qjs_is_string(JSValue *val) {
    return JS_IsString(*val);
}

__attribute__((export_name("qjs_is_object")))
int qjs_is_object(JSValue *val) {
    return JS_IsObject(*val);
}

__attribute__((export_name("qjs_is_array")))
int qjs_is_array(JSValue *val) {
    return JS_IsArray(*val);
}

__attribute__((export_name("qjs_is_function")))
int qjs_is_function(JSValue *val) {
    return JS_IsFunction(ctx, *val);
}

__attribute__((export_name("qjs_is_error")))
int qjs_is_error(JSValue *val) {
    return JS_IsError(*val);
}

__attribute__((export_name("qjs_is_promise")))
int qjs_is_promise(JSValue *val) {
    return JS_IsPromise(*val);
}

__attribute__((export_name("qjs_is_symbol")))
int qjs_is_symbol(JSValue *val) {
    return JS_IsSymbol(*val);
}

__attribute__((export_name("qjs_is_big_int")))
int qjs_is_big_int(JSValue *val) {
    return JS_IsBigInt(*val);
}

__attribute__((export_name("qjs_get_bool")))
int qjs_get_bool(JSValue *val) {
    return JS_ToBool(ctx, *val);
}

/* ---- Value Management ---- */

__attribute__((export_name("qjs_dup_value")))
JSValue *qjs_dup_value(JSValue *val) {
    return jsvalue_to_heap(JS_DupValue(ctx, *val));
}

__attribute__((export_name("qjs_free_value")))
void qjs_free_value(JSValue *val) {
    JS_FreeValue(ctx, *val);
    free(val);
}

/* ---- Property Operations ---- */

__attribute__((export_name("qjs_get_global")))
JSValue *qjs_get_global(void) {
    return jsvalue_to_heap(JS_GetGlobalObject(ctx));
}

__attribute__((export_name("qjs_get_prop_string")))
JSValue *qjs_get_prop_string(JSValue *obj, const char *name) {
    JSValue val = JS_GetPropertyStr(ctx, *obj, name);
    return jsvalue_to_heap(val);
}

__attribute__((export_name("qjs_set_prop_string")))
int qjs_set_prop_string(JSValue *obj, const char *name, JSValue *val) {
    /* JS_SetPropertyStr takes ownership of val, so we dup it first since
       the caller still owns their handle */
    return JS_SetPropertyStr(ctx, *obj, name, JS_DupValue(ctx, *val));
}

/*
 * Get/set a property using a JSValue as the key (works for symbol keys).
 * The key is converted to an atom via JS_ValueToAtom.
 */
__attribute__((export_name("qjs_get_prop_value")))
JSValue *qjs_get_prop_value(JSValue *obj, JSValue *key) {
    JSAtom atom = JS_ValueToAtom(ctx, *key);
    if (atom == JS_ATOM_NULL) return jsvalue_to_heap(JS_EXCEPTION);
    JSValue val = JS_GetProperty(ctx, *obj, atom);
    JS_FreeAtom(ctx, atom);
    return jsvalue_to_heap(val);
}

__attribute__((export_name("qjs_set_prop_value")))
int qjs_set_prop_value(JSValue *obj, JSValue *key, JSValue *val) {
    JSAtom atom = JS_ValueToAtom(ctx, *key);
    if (atom == JS_ATOM_NULL) return -1;
    int ret = JS_SetProperty(ctx, *obj, atom, JS_DupValue(ctx, *val));
    JS_FreeAtom(ctx, atom);
    return ret;
}

__attribute__((export_name("qjs_get_prop_uint32")))
JSValue *qjs_get_prop_uint32(JSValue *obj, unsigned int idx) {
    JSValue val = JS_GetPropertyUint32(ctx, *obj, idx);
    return jsvalue_to_heap(val);
}

__attribute__((export_name("qjs_set_prop_uint32")))
int qjs_set_prop_uint32(JSValue *obj, unsigned int idx, JSValue *val) {
    return JS_SetPropertyUint32(ctx, *obj, idx, JS_DupValue(ctx, *val));
}

/* ---- Function Calls ---- */

__attribute__((export_name("qjs_call")))
JSValue *qjs_call(JSValue *func, JSValue *this_val, int argc, JSValue **argv) {
    /* Convert pointer-to-pointer argv to array of JSValues */
    JSValue *args = NULL;
    if (argc > 0) {
        args = (JSValue *)malloc(sizeof(JSValue) * argc);
        for (int i = 0; i < argc; i++) {
            args[i] = *argv[i];
        }
    }
    JSValue result = JS_Call(ctx, *func, *this_val, argc, args);
    free(args);
    return jsvalue_to_heap(result);
}

/* ---- Host Function Registration ---- */

/*
 * Create a new QuickJS function that dispatches to the host callback
 * identified by func_id. When called from QuickJS code, this function
 * will invoke the host_call import with the given func_id.
 */
__attribute__((export_name("qjs_new_host_function")))
JSValue *qjs_new_host_function(const char *name, int name_len, int func_id, int arg_count) {
    (void)name_len;
    JSValue func_id_val = JS_NewInt32(ctx, func_id);
    JSValue func = JS_NewCFunctionData2(ctx, host_callback_trampoline,
                                         name, arg_count, 0, 1, &func_id_val);
    JS_FreeValue(ctx, func_id_val);
    return jsvalue_to_heap(func);
}

/* ---- Promise Operations ---- */

__attribute__((export_name("qjs_new_promise")))
JSValue *qjs_new_promise(JSValue **resolve_out, JSValue **reject_out) {
    JSValue resolving_funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving_funcs);

    /* Heap-allocate the resolve and reject functions and write their
       pointers to the output locations */
    *resolve_out = jsvalue_to_heap(resolving_funcs[0]);
    *reject_out  = jsvalue_to_heap(resolving_funcs[1]);

    return jsvalue_to_heap(promise);
}

__attribute__((export_name("qjs_promise_state")))
int qjs_promise_state(JSValue *promise) {
    return (int)JS_PromiseState(ctx, *promise);
}

__attribute__((export_name("qjs_promise_result")))
JSValue *qjs_promise_result(JSValue *promise) {
    return jsvalue_to_heap(JS_PromiseResult(ctx, *promise));
}

/* ---- Job Queue ---- */

__attribute__((export_name("qjs_is_job_pending")))
int qjs_is_job_pending(void) {
    return JS_IsJobPending(rt);
}

__attribute__((export_name("qjs_execute_pending_job")))
int qjs_execute_pending_job(void) {
    JSContext *pctx;
    return JS_ExecutePendingJob(rt, &pctx);
}

/* ---- Error Handling ---- */

__attribute__((export_name("qjs_get_exception")))
JSValue *qjs_get_exception(void) {
    return jsvalue_to_heap(JS_GetException(ctx));
}

__attribute__((export_name("qjs_throw")))
JSValue *qjs_throw(JSValue *val) {
    return jsvalue_to_heap(JS_Throw(ctx, JS_DupValue(ctx, *val)));
}

__attribute__((export_name("qjs_new_error")))
JSValue *qjs_new_error(void) {
    return jsvalue_to_heap(JS_NewError(ctx));
}

/* ---- BigInt ---- */

/*
 * Create a BigInt from two 32-bit halves (lo, hi) representing a signed 64-bit integer.
 * This avoids the need to pass 64-bit values across the WASM boundary.
 */
__attribute__((export_name("qjs_new_big_int64")))
JSValue *qjs_new_big_int64(int lo, int hi) {
    int64_t val = ((int64_t)(unsigned int)hi << 32) | (int64_t)(unsigned int)lo;
    return jsvalue_to_heap(JS_NewBigInt64(ctx, val));
}

/*
 * Extract a BigInt as two 32-bit halves written to output pointers.
 * Returns 0 on success, -1 on failure.
 */
__attribute__((export_name("qjs_get_big_int64")))
int qjs_get_big_int64(JSValue *val, int *lo_out, int *hi_out) {
    int64_t result;
    int ret = JS_ToBigInt64(ctx, &result, *val);
    if (ret == 0) {
        *lo_out = (int)(unsigned int)(result & 0xFFFFFFFF);
        *hi_out = (int)(unsigned int)((result >> 32) & 0xFFFFFFFF);
    }
    return ret;
}

/*
 * Get the underlying object pointer from a JSValue.
 * Returns 0 for non-object/non-string values.
 * This is used for identity comparison (cycle detection in dump()).
 */
__attribute__((export_name("qjs_get_value_ptr")))
void *qjs_get_value_ptr(JSValue *val) {
    if (JS_VALUE_GET_TAG(*val) >= 0) return NULL; /* not a pointer type */
    return JS_VALUE_GET_PTR(*val);
}

/* ---- Property Enumeration ---- */

/*
 * Get the own enumerable string property names of an object as a QuickJS Array.
 * Returns a heap-allocated JSValue* pointing to the array, or NULL on failure.
 */
__attribute__((export_name("qjs_get_own_property_names")))
JSValue *qjs_get_own_property_names(JSValue *obj) {
    JSPropertyEnum *tab;
    uint32_t len;
    int flags = JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY;

    if (JS_GetOwnPropertyNames(ctx, &tab, &len, *obj, flags) < 0) {
        return jsvalue_to_heap(JS_EXCEPTION);
    }

    JSValue arr = JS_NewArray(ctx);
    for (uint32_t i = 0; i < len; i++) {
        JSValue key = JS_AtomToString(ctx, tab[i].atom);
        JS_SetPropertyUint32(ctx, arr, i, key);
    }

    JS_FreePropertyEnum(ctx, tab, len);
    return jsvalue_to_heap(arr);
}

/* ---- ArrayBuffer / TypedArray ---- */

/*
 * Create a new ArrayBuffer by copying data from the given pointer.
 */
__attribute__((export_name("qjs_new_array_buffer")))
JSValue *qjs_new_array_buffer(const uint8_t *data, size_t len) {
    return jsvalue_to_heap(JS_NewArrayBufferCopy(ctx, data, len));
}

/*
 * Get a pointer to the ArrayBuffer's data and its length.
 * Returns the data pointer (into WASM memory), writes length to *len_out.
 * Returns NULL if the value is not an ArrayBuffer.
 */
__attribute__((export_name("qjs_get_array_buffer")))
uint8_t *qjs_get_array_buffer(JSValue *val, size_t *len_out) {
    return JS_GetArrayBuffer(ctx, len_out, *val);
}

/*
 * Check if a value is an ArrayBuffer.
 */
__attribute__((export_name("qjs_is_array_buffer")))
int qjs_is_array_buffer(JSValue *val) {
    return JS_IsArrayBuffer(*val);
}

/*
 * Create a new Uint8Array by copying data from the given pointer.
 */
__attribute__((export_name("qjs_new_uint8_array")))
JSValue *qjs_new_uint8_array(const uint8_t *data, size_t len) {
    return jsvalue_to_heap(JS_NewUint8ArrayCopy(ctx, data, len));
}

/*
 * Get the underlying ArrayBuffer from a typed array, along with byte offset,
 * byte length, and bytes per element.
 * Returns a heap-allocated JSValue* for the ArrayBuffer.
 */
__attribute__((export_name("qjs_get_typed_array_buffer")))
JSValue *qjs_get_typed_array_buffer(JSValue *val, size_t *byte_offset_out,
                                     size_t *byte_length_out,
                                     size_t *bytes_per_element_out) {
    return jsvalue_to_heap(JS_GetTypedArrayBuffer(ctx, *val,
                                                   byte_offset_out,
                                                   byte_length_out,
                                                   bytes_per_element_out));
}

/* ---- Snapshot support helpers ---- */

/* Returns the pointer to the JSRuntime (for introspection only) */
__attribute__((export_name("qjs_get_runtime_ptr")))
void *qjs_get_runtime_ptr(void) {
    return (void *)rt;
}

/* Returns the pointer to the JSContext (for introspection only) */
__attribute__((export_name("qjs_get_context_ptr")))
void *qjs_get_context_ptr(void) {
    return (void *)ctx;
}

/* Sets the runtime and context pointers after a memory restore.
   This allows the host to bypass qjs_init() and directly set the
   pointers that were recovered from the snapshotted memory. */
__attribute__((export_name("qjs_set_runtime_and_context")))
void qjs_set_runtime_and_context(void *runtime_ptr, void *context_ptr) {
    rt = (JSRuntime *)runtime_ptr;
    ctx = (JSContext *)context_ptr;
}

/* ---- Memory management exports (for host to allocate in WASM memory) ---- */

__attribute__((export_name("wasm_malloc")))
void *wasm_malloc(size_t size) {
    return malloc(size);
}

__attribute__((export_name("wasm_free")))
void wasm_free(void *ptr) {
    free(ptr);
}


