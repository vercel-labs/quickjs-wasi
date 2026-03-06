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

__attribute__((export_name("qjs_destroy")))
void qjs_destroy(void) {
    if (ctx) {
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
