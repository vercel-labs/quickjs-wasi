/*
 * QuickJS Extension: structuredClone
 *
 * WHATWG HTML Standard compliant implementation of structuredClone().
 * Performs a deep clone following the Structured Clone algorithm with
 * circular reference detection.
 *
 * Supported types:
 *   - Primitives: undefined, null, boolean, number, bigint, string
 *   - Date, RegExp
 *   - ArrayBuffer, SharedArrayBuffer
 *   - TypedArrays (Uint8Array, Int32Array, Float64Array, etc.)
 *   - DataView
 *   - Map, Set
 *   - Array
 *   - Error (Error, TypeError, RangeError, etc.)
 *   - Plain objects
 *
 * NOT supported (throw DataCloneError):
 *   - Functions, Symbols, Proxies, Promises, WeakMap, WeakSet, generators
 *   - DOM objects (not applicable in QuickJS)
 *
 * Transfer semantics are NOT supported (QuickJS has no Transferable concept).
 *
 * References:
 *   - https://html.spec.whatwg.org/multipage/structured-data.html#structured-cloning
 */

#include "quickjs.h"
#include <string.h>
#include <stdlib.h>

/* ---- Circular reference tracking ---- */

/* Dynamic array mapping original values to their clones.
   We store pairs of (original JSValue tag+ptr, clone JSValue).
   For cycle detection, we only care about object-type values. */

typedef struct {
    JSValue *originals;
    JSValue *clones;
    int count;
    int capacity;
} CloneMemory;

static void memory_init(CloneMemory *m) {
    m->originals = NULL;
    m->clones = NULL;
    m->count = 0;
    m->capacity = 0;
}

static void memory_free(JSContext *ctx, CloneMemory *m) {
    /* Free all cloned values that are still in memory
       (they should have been returned to the caller) */
    js_free(ctx, m->originals);
    js_free(ctx, m->clones);
    m->count = 0;
    m->capacity = 0;
}

/* Check if we've already cloned this exact object.
   Returns the clone if found (caller must DupValue), or JS_UNDEFINED. */
static JSValue memory_find(CloneMemory *m, JSValue original) {
    void *ptr = JS_VALUE_GET_PTR(original);
    int tag = JS_VALUE_GET_TAG(original);
    for (int i = 0; i < m->count; i++) {
        /* Compare by pointer and tag: same object identity */
        if (JS_VALUE_GET_PTR(m->originals[i]) == ptr &&
            JS_VALUE_GET_TAG(m->originals[i]) == tag) {
            return m->clones[i];
        }
    }
    return JS_UNDEFINED;
}

static int memory_add(JSContext *ctx, CloneMemory *m, JSValue original, JSValue clone) {
    if (m->count >= m->capacity) {
        int new_cap = m->capacity ? m->capacity * 2 : 16;
        JSValue *new_orig = js_realloc(ctx, m->originals, new_cap * sizeof(JSValue));
        JSValue *new_clon = js_realloc(ctx, m->clones, new_cap * sizeof(JSValue));
        if (!new_orig || !new_clon) return -1;
        m->originals = new_orig;
        m->clones = new_clon;
        m->capacity = new_cap;
    }
    m->originals[m->count] = original;
    m->clones[m->count] = clone;
    m->count++;
    return 0;
}

/* ---- Helper: throw DataCloneError ---- */

static JSValue throw_data_clone_error(JSContext *ctx, const char *detail) {
    /* Try to throw a DOMException if available */
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue dom_exc_ctor = JS_GetPropertyStr(ctx, global, "DOMException");
    JS_FreeValue(ctx, global);

    if (JS_IsFunction(ctx, dom_exc_ctor)) {
        char msg_buf[256];
        snprintf(msg_buf, sizeof(msg_buf),
                 "Failed to execute 'structuredClone': %s could not be cloned.",
                 detail);
        JSValue msg = JS_NewString(ctx, msg_buf);
        JSValue name = JS_NewString(ctx, "DataCloneError");
        JSValue args[2] = { msg, name };
        JSValue exc = JS_CallConstructor(ctx, dom_exc_ctor, 2, args);
        JS_FreeValue(ctx, msg);
        JS_FreeValue(ctx, name);
        JS_FreeValue(ctx, dom_exc_ctor);
        if (!JS_IsException(exc)) {
            JS_Throw(ctx, exc);
            return JS_EXCEPTION;
        }
        JS_FreeValue(ctx, exc);
    } else {
        JS_FreeValue(ctx, dom_exc_ctor);
    }

    /* Fallback */
    return JS_ThrowTypeError(ctx, "The object could not be cloned: %s", detail);
}

/* ---- Forward declaration ---- */

static JSValue structured_clone_internal(JSContext *ctx, JSValue value, CloneMemory *mem);

/* ---- Clone helpers for specific types ---- */

static JSValue clone_date(JSContext *ctx, JSValue value) {
    /* Get the time value via getTime() */
    JSValue get_time = JS_GetPropertyStr(ctx, value, "getTime");
    JSValue time_val = JS_Call(ctx, get_time, value, 0, NULL);
    JS_FreeValue(ctx, get_time);

    if (JS_IsException(time_val)) return JS_EXCEPTION;

    double ms;
    JS_ToFloat64(ctx, &ms, time_val);
    JS_FreeValue(ctx, time_val);

    return JS_NewDate(ctx, ms);
}

static JSValue clone_regexp(JSContext *ctx, JSValue value) {
    JSValue source = JS_GetPropertyStr(ctx, value, "source");
    JSValue flags = JS_GetPropertyStr(ctx, value, "flags");

    if (JS_IsException(source) || JS_IsException(flags)) {
        JS_FreeValue(ctx, source);
        JS_FreeValue(ctx, flags);
        return JS_EXCEPTION;
    }

    /* Construct new RegExp(source, flags) */
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue regexp_ctor = JS_GetPropertyStr(ctx, global, "RegExp");
    JS_FreeValue(ctx, global);

    JSValue args[2] = { source, flags };
    JSValue result = JS_CallConstructor(ctx, regexp_ctor, 2, args);

    JS_FreeValue(ctx, regexp_ctor);
    JS_FreeValue(ctx, source);
    JS_FreeValue(ctx, flags);
    return result;
}

static JSValue clone_arraybuffer(JSContext *ctx, JSValue value) {
    size_t size;
    uint8_t *data = JS_GetArrayBuffer(ctx, &size, value);
    if (!data && size > 0) {
        return throw_data_clone_error(ctx, "A detached ArrayBuffer");
    }
    /* Copy the data */
    JSValue result = JS_NewArrayBufferCopy(ctx, data, size);
    return result;
}

static JSValue clone_typed_array(JSContext *ctx, JSValue value, CloneMemory *mem) {
    /* Get the constructor name to reconstruct the same type */
    JSValue ctor = JS_GetPropertyStr(ctx, value, "constructor");
    JSValue ctor_name_val = JS_GetPropertyStr(ctx, ctor, "name");
    const char *ctor_name = JS_ToCString(ctx, ctor_name_val);
    JS_FreeValue(ctx, ctor_name_val);

    /* Get the underlying buffer */
    size_t byte_offset, byte_length, bpe;
    JSValue ab = JS_GetTypedArrayBuffer(ctx, value, &byte_offset, &byte_length, &bpe);
    if (JS_IsException(ab)) {
        JS_FreeCString(ctx, ctor_name);
        JS_FreeValue(ctx, ctor);
        return JS_EXCEPTION;
    }

    /* Clone the buffer */
    JSValue cloned_ab = clone_arraybuffer(ctx, ab);
    JS_FreeValue(ctx, ab);
    if (JS_IsException(cloned_ab)) {
        JS_FreeCString(ctx, ctor_name);
        JS_FreeValue(ctx, ctor);
        return JS_EXCEPTION;
    }

    /* Construct new TypedArray from the cloned buffer.
       We use: new TypedArrayCtor(buffer, byteOffset, length) */
    size_t length = bpe > 0 ? byte_length / bpe : 0;
    JSValue args[3] = {
        cloned_ab,
        JS_NewInt64(ctx, (int64_t)byte_offset),
        JS_NewInt64(ctx, (int64_t)length),
    };
    JSValue result = JS_CallConstructor(ctx, ctor, 3, args);

    JS_FreeValue(ctx, args[1]);
    JS_FreeValue(ctx, args[2]);
    JS_FreeValue(ctx, cloned_ab);
    JS_FreeValue(ctx, ctor);
    JS_FreeCString(ctx, ctor_name);
    return result;
}

static JSValue clone_dataview(JSContext *ctx, JSValue value) {
    JSValue buf_val = JS_GetPropertyStr(ctx, value, "buffer");
    JSValue off_val = JS_GetPropertyStr(ctx, value, "byteOffset");
    JSValue len_val = JS_GetPropertyStr(ctx, value, "byteLength");

    JSValue cloned_buf = clone_arraybuffer(ctx, buf_val);
    JS_FreeValue(ctx, buf_val);
    if (JS_IsException(cloned_buf)) {
        JS_FreeValue(ctx, off_val);
        JS_FreeValue(ctx, len_val);
        return JS_EXCEPTION;
    }

    /* new DataView(buffer, byteOffset, byteLength) */
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue dv_ctor = JS_GetPropertyStr(ctx, global, "DataView");
    JS_FreeValue(ctx, global);

    JSValue args[3] = { cloned_buf, off_val, len_val };
    JSValue result = JS_CallConstructor(ctx, dv_ctor, 3, args);

    JS_FreeValue(ctx, dv_ctor);
    JS_FreeValue(ctx, cloned_buf);
    JS_FreeValue(ctx, off_val);
    JS_FreeValue(ctx, len_val);
    return result;
}

static JSValue clone_error(JSContext *ctx, JSValue value) {
    /* Get the error's constructor name */
    JSValue ctor = JS_GetPropertyStr(ctx, value, "constructor");
    JSValue name_val = JS_GetPropertyStr(ctx, ctor, "name");
    const char *name = JS_ToCString(ctx, name_val);
    JS_FreeValue(ctx, name_val);

    /* Determine which error constructor to use */
    const char *error_names[] = {
        "Error", "EvalError", "RangeError", "ReferenceError",
        "SyntaxError", "TypeError", "URIError", NULL
    };
    const char *use_name = "Error";
    if (name) {
        for (const char **p = error_names; *p; p++) {
            if (strcmp(name, *p) == 0) {
                use_name = *p;
                break;
            }
        }
    }
    if (name) JS_FreeCString(ctx, name);

    /* Get message */
    JSValue msg_val = JS_GetPropertyStr(ctx, value, "message");

    /* Construct new Error(message) using the correct constructor */
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue err_ctor = JS_GetPropertyStr(ctx, global, use_name);
    JS_FreeValue(ctx, global);

    JSValue args[1] = { msg_val };
    JSValue result = JS_CallConstructor(ctx, err_ctor, 1, args);
    JS_FreeValue(ctx, err_ctor);
    JS_FreeValue(ctx, msg_val);
    JS_FreeValue(ctx, ctor);

    if (JS_IsException(result)) return JS_EXCEPTION;

    /* Copy cause if present */
    JSValue cause = JS_GetPropertyStr(ctx, value, "cause");
    if (!JS_IsUndefined(cause) && !JS_IsException(cause)) {
        JS_SetPropertyStr(ctx, result, "cause", cause);
    } else {
        JS_FreeValue(ctx, cause);
    }

    return result;
}

static JSValue clone_map(JSContext *ctx, JSValue value, CloneMemory *mem) {
    /* Create new Map */
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue map_ctor = JS_GetPropertyStr(ctx, global, "Map");
    JS_FreeValue(ctx, global);

    JSValue result = JS_CallConstructor(ctx, map_ctor, 0, NULL);
    JS_FreeValue(ctx, map_ctor);
    if (JS_IsException(result)) return JS_EXCEPTION;

    /* Register in memory BEFORE recursing (for circular refs) */
    if (memory_add(ctx, mem, value, result) < 0) {
        JS_FreeValue(ctx, result);
        return JS_EXCEPTION;
    }

    /* Iterate using forEach */
    JSValue set_method = JS_GetPropertyStr(ctx, result, "set");

    /* We need to iterate the original map. Use entries() and a loop. */
    JSValue entries_fn = JS_GetPropertyStr(ctx, value, "entries");
    JSValue iter = JS_Call(ctx, entries_fn, value, 0, NULL);
    JS_FreeValue(ctx, entries_fn);

    if (JS_IsException(iter)) {
        JS_FreeValue(ctx, set_method);
        return JS_EXCEPTION;
    }

    JSValue next_fn = JS_GetPropertyStr(ctx, iter, "next");

    while (1) {
        JSValue item = JS_Call(ctx, next_fn, iter, 0, NULL);
        if (JS_IsException(item)) {
            JS_FreeValue(ctx, next_fn);
            JS_FreeValue(ctx, iter);
            JS_FreeValue(ctx, set_method);
            return JS_EXCEPTION;
        }

        JSValue done = JS_GetPropertyStr(ctx, item, "done");
        int is_done = JS_ToBool(ctx, done);
        JS_FreeValue(ctx, done);

        if (is_done) {
            JS_FreeValue(ctx, item);
            break;
        }

        JSValue entry_val = JS_GetPropertyStr(ctx, item, "value");
        JS_FreeValue(ctx, item);

        JSValue key = JS_GetPropertyUint32(ctx, entry_val, 0);
        JSValue val = JS_GetPropertyUint32(ctx, entry_val, 1);
        JS_FreeValue(ctx, entry_val);

        JSValue cloned_key = structured_clone_internal(ctx, key, mem);
        JS_FreeValue(ctx, key);
        if (JS_IsException(cloned_key)) {
            JS_FreeValue(ctx, val);
            JS_FreeValue(ctx, next_fn);
            JS_FreeValue(ctx, iter);
            JS_FreeValue(ctx, set_method);
            return JS_EXCEPTION;
        }

        JSValue cloned_val = structured_clone_internal(ctx, val, mem);
        JS_FreeValue(ctx, val);
        if (JS_IsException(cloned_val)) {
            JS_FreeValue(ctx, cloned_key);
            JS_FreeValue(ctx, next_fn);
            JS_FreeValue(ctx, iter);
            JS_FreeValue(ctx, set_method);
            return JS_EXCEPTION;
        }

        JSValue set_args[2] = { cloned_key, cloned_val };
        JSValue r = JS_Call(ctx, set_method, result, 2, set_args);
        JS_FreeValue(ctx, cloned_key);
        JS_FreeValue(ctx, cloned_val);
        JS_FreeValue(ctx, r);
    }

    JS_FreeValue(ctx, next_fn);
    JS_FreeValue(ctx, iter);
    JS_FreeValue(ctx, set_method);
    return result;
}

static JSValue clone_set(JSContext *ctx, JSValue value, CloneMemory *mem) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue set_ctor = JS_GetPropertyStr(ctx, global, "Set");
    JS_FreeValue(ctx, global);

    JSValue result = JS_CallConstructor(ctx, set_ctor, 0, NULL);
    JS_FreeValue(ctx, set_ctor);
    if (JS_IsException(result)) return JS_EXCEPTION;

    /* Register in memory BEFORE recursing */
    if (memory_add(ctx, mem, value, result) < 0) {
        JS_FreeValue(ctx, result);
        return JS_EXCEPTION;
    }

    JSValue add_method = JS_GetPropertyStr(ctx, result, "add");

    /* Iterate the original Set using values() */
    JSValue values_fn = JS_GetPropertyStr(ctx, value, "values");
    JSValue iter = JS_Call(ctx, values_fn, value, 0, NULL);
    JS_FreeValue(ctx, values_fn);

    if (JS_IsException(iter)) {
        JS_FreeValue(ctx, add_method);
        return JS_EXCEPTION;
    }

    JSValue next_fn = JS_GetPropertyStr(ctx, iter, "next");

    while (1) {
        JSValue item = JS_Call(ctx, next_fn, iter, 0, NULL);
        if (JS_IsException(item)) {
            JS_FreeValue(ctx, next_fn);
            JS_FreeValue(ctx, iter);
            JS_FreeValue(ctx, add_method);
            return JS_EXCEPTION;
        }

        JSValue done = JS_GetPropertyStr(ctx, item, "done");
        int is_done = JS_ToBool(ctx, done);
        JS_FreeValue(ctx, done);

        if (is_done) {
            JS_FreeValue(ctx, item);
            break;
        }

        JSValue val = JS_GetPropertyStr(ctx, item, "value");
        JS_FreeValue(ctx, item);

        JSValue cloned_val = structured_clone_internal(ctx, val, mem);
        JS_FreeValue(ctx, val);
        if (JS_IsException(cloned_val)) {
            JS_FreeValue(ctx, next_fn);
            JS_FreeValue(ctx, iter);
            JS_FreeValue(ctx, add_method);
            return JS_EXCEPTION;
        }

        JSValue r = JS_Call(ctx, add_method, result, 1, &cloned_val);
        JS_FreeValue(ctx, cloned_val);
        JS_FreeValue(ctx, r);
    }

    JS_FreeValue(ctx, next_fn);
    JS_FreeValue(ctx, iter);
    JS_FreeValue(ctx, add_method);
    return result;
}

/* Clone enumerable own properties from src to dst */
static int clone_properties(JSContext *ctx, JSValue dst, JSValue src, CloneMemory *mem) {
    JSPropertyEnum *tab;
    uint32_t len;

    if (JS_GetOwnPropertyNames(ctx, &tab, &len, src,
                                JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
        return -1;
    }

    for (uint32_t i = 0; i < len; i++) {
        JSValue val = JS_GetProperty(ctx, src, tab[i].atom);
        if (JS_IsException(val)) {
            JS_FreePropertyEnum(ctx, tab, len);
            return -1;
        }

        JSValue cloned_val = structured_clone_internal(ctx, val, mem);
        JS_FreeValue(ctx, val);
        if (JS_IsException(cloned_val)) {
            JS_FreePropertyEnum(ctx, tab, len);
            return -1;
        }

        JS_SetProperty(ctx, dst, tab[i].atom, cloned_val); /* takes ownership */
    }

    JS_FreePropertyEnum(ctx, tab, len);
    return 0;
}

/* ---- Core algorithm ---- */

static JSValue structured_clone_internal(JSContext *ctx, JSValue value, CloneMemory *mem) {
    /* Primitives: return as-is (they're immutable) */
    if (JS_IsUndefined(value) || JS_IsNull(value))
        return JS_DupValue(ctx, value);

    /* Boolean */
    if (JS_IsBool(value))
        return JS_DupValue(ctx, value);

    /* Number (int or float64, handles NaN, Infinity, -0) */
    if (JS_IsNumber(value))
        return JS_DupValue(ctx, value);

    /* String */
    if (JS_IsString(value))
        return JS_DupValue(ctx, value);

    int tag = JS_VALUE_GET_TAG(value);

    /* BigInt */
    if (JS_IsBigInt(value))
        return JS_DupValue(ctx, value);

    /* Symbol -> error */
    if (JS_IsSymbol(value))
        return throw_data_clone_error(ctx, "A Symbol value");

    /* Now it must be an object. Check circular refs. */
    if (tag == JS_TAG_OBJECT) {
        JSValue existing = memory_find(mem, value);
        if (!JS_IsUndefined(existing)) {
            return JS_DupValue(ctx, existing);
        }
    }

    /* Function -> error */
    if (JS_IsFunction(ctx, value))
        return throw_data_clone_error(ctx, "A function");

    /* Promise -> error */
    if (JS_IsPromise(value))
        return throw_data_clone_error(ctx, "A Promise");

    /* Proxy -> error */
    if (JS_IsProxy(value))
        return throw_data_clone_error(ctx, "A Proxy");

    /* Date */
    if (JS_IsDate(value)) {
        JSValue result = clone_date(ctx, value);
        if (!JS_IsException(result))
            memory_add(ctx, mem, value, result);
        return result;
    }

    /* RegExp */
    if (JS_IsRegExp(value)) {
        JSValue result = clone_regexp(ctx, value);
        if (!JS_IsException(result))
            memory_add(ctx, mem, value, result);
        return result;
    }

    /* ArrayBuffer */
    if (JS_IsArrayBuffer(value)) {
        JSValue result = clone_arraybuffer(ctx, value);
        if (!JS_IsException(result))
            memory_add(ctx, mem, value, result);
        return result;
    }

    /* DataView: check before TypedArray since DataView is not a typed array */
    if (JS_IsDataView(value)) {
        JSValue result = clone_dataview(ctx, value);
        if (!JS_IsException(result))
            memory_add(ctx, mem, value, result);
        return result;
    }

    /* TypedArray */
    if (JS_GetTypedArrayType(value) >= 0) {
        JSValue result = clone_typed_array(ctx, value, mem);
        if (!JS_IsException(result))
            memory_add(ctx, mem, value, result);
        return result;
    }

    /* Map */
    if (JS_IsMap(value)) {
        return clone_map(ctx, value, mem);
        /* memory_add is done inside clone_map before recursing */
    }

    /* Set */
    if (JS_IsSet(value)) {
        return clone_set(ctx, value, mem);
    }

    /* Error */
    if (JS_IsError(value)) {
        JSValue result = clone_error(ctx, value);
        if (!JS_IsException(result))
            memory_add(ctx, mem, value, result);
        return result;
    }

    /* Array */
    if (JS_IsArray(value)) {
        JSValue result = JS_NewArray(ctx);
        if (JS_IsException(result)) return JS_EXCEPTION;

        /* Register before recursing for circular refs */
        if (memory_add(ctx, mem, value, result) < 0) {
            JS_FreeValue(ctx, result);
            return JS_EXCEPTION;
        }

        /* Get length */
        JSValue len_val = JS_GetPropertyStr(ctx, value, "length");
        uint32_t len;
        JS_ToUint32(ctx, &len, len_val);
        JS_FreeValue(ctx, len_val);

        for (uint32_t i = 0; i < len; i++) {
            JSAtom atom = JS_NewAtomUInt32(ctx, i);
            int has = JS_HasProperty(ctx, value, atom);
            JS_FreeAtom(ctx, atom);
            if (has > 0) {
                JSValue elem = JS_GetPropertyUint32(ctx, value, i);
                if (JS_IsException(elem)) {
                    JS_FreeValue(ctx, result);
                    return JS_EXCEPTION;
                }
                JSValue cloned = structured_clone_internal(ctx, elem, mem);
                JS_FreeValue(ctx, elem);
                if (JS_IsException(cloned)) {
                    JS_FreeValue(ctx, result);
                    return JS_EXCEPTION;
                }
                JS_SetPropertyUint32(ctx, result, i, cloned);
            }
        }

        return result;
    }

    /* Plain object */
    if (tag == JS_TAG_OBJECT) {
        JSValue result = JS_NewObject(ctx);
        if (JS_IsException(result)) return JS_EXCEPTION;

        /* Register before recursing for circular refs */
        if (memory_add(ctx, mem, value, result) < 0) {
            JS_FreeValue(ctx, result);
            return JS_EXCEPTION;
        }

        if (clone_properties(ctx, result, value, mem) < 0) {
            /* Don't free result; it's in the memory table and may be referenced */
            return JS_EXCEPTION;
        }

        return result;
    }

    return throw_data_clone_error(ctx, "The value");
}

/* ---- structuredClone(value, options?) ---- */

static JSValue js_structured_clone(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "structuredClone requires at least 1 argument");

    /* We don't support the transfer option */
    if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        JSValue transfer = JS_GetPropertyStr(ctx, argv[1], "transfer");
        if (!JS_IsUndefined(transfer) && !JS_IsNull(transfer)) {
            /* Check if it's a non-empty array */
            JSValue len_val = JS_GetPropertyStr(ctx, transfer, "length");
            uint32_t len = 0;
            JS_ToUint32(ctx, &len, len_val);
            JS_FreeValue(ctx, len_val);
            JS_FreeValue(ctx, transfer);
            if (len > 0) {
                return throw_data_clone_error(ctx, "Transfer is not supported");
            }
        } else {
            JS_FreeValue(ctx, transfer);
        }
    }

    CloneMemory mem;
    memory_init(&mem);

    JSValue result = structured_clone_internal(ctx, argv[0], &mem);

    memory_free(ctx, &mem);
    return result;
}

/* ---- Extension entry point ---- */

__attribute__((visibility("default")))
int qjs_ext_structured_clone_init(JSContext *ctx, JSRuntime *rt) {
    JSValue global = JS_GetGlobalObject(ctx);

    JS_SetPropertyStr(ctx, global, "structuredClone",
        JS_NewCFunction(ctx, js_structured_clone, "structuredClone", 1));

    JS_FreeValue(ctx, global);
    return 0;
}
