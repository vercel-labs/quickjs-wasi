/*
 * QuickJS Extension: DOMException
 *
 * WebIDL spec compliant DOMException class with all legacy error code
 * constants. The prototype chain is DOMException -> Error -> Object.
 *
 * References:
 *   - https://webidl.spec.whatwg.org/#idl-DOMException
 *   - https://webidl.spec.whatwg.org/#dfn-error-names-table
 */

#include "quickjs.h"
#include <string.h>

/* ---- Legacy error codes ---- */

typedef struct {
    const char *name;
    int code;
} DOMExceptionName;

static const DOMExceptionName error_names[] = {
    { "IndexSizeError",             1 },
    { "HierarchyRequestError",      3 },
    { "WrongDocumentError",         4 },
    { "InvalidCharacterError",      5 },
    { "NoModificationAllowedError", 7 },
    { "NotFoundError",              8 },
    { "NotSupportedError",          9 },
    { "InUseAttributeError",       10 },
    { "InvalidStateError",         11 },
    { "SyntaxError",               12 },
    { "InvalidModificationError",  13 },
    { "NamespaceError",            14 },
    { "InvalidAccessError",        15 },
    { "TypeMismatchError",         17 },
    { "SecurityError",             18 },
    { "NetworkError",              19 },
    { "AbortError",                20 },
    { "URLMismatchError",          21 },
    { "QuotaExceededError",        22 },
    { "TimeoutError",              23 },
    { "InvalidNodeTypeError",      24 },
    { "DataCloneError",            25 },
    { NULL, 0 }
};

static int legacy_code_for_name(const char *name, size_t name_len) {
    for (const DOMExceptionName *e = error_names; e->name; e++) {
        if (strlen(e->name) == name_len && memcmp(e->name, name, name_len) == 0) {
            return e->code;
        }
    }
    return 0;
}

/* ---- DOMException class ---- */

static JSClassID js_dom_exception_class_id;

typedef struct {
    char *name;
    size_t name_len;
    char *message;
    size_t message_len;
} DOMExceptionData;

static void js_dom_exception_finalizer(JSRuntime *rt, JSValue val) {
    DOMExceptionData *d = (DOMExceptionData *)JS_GetOpaque(val, js_dom_exception_class_id);
    if (d) {
        if (d->name) js_free_rt(rt, d->name);
        if (d->message) js_free_rt(rt, d->message);
        js_free_rt(rt, d);
    }
}

static JSClassDef js_dom_exception_class = {
    "DOMException",
    .finalizer = js_dom_exception_finalizer,
};

static JSValue js_dom_exception_constructor(JSContext *ctx, JSValueConst new_target,
                                             int argc, JSValueConst *argv)
{
    /* Parse message (default "") */
    const char *message = "";
    size_t message_len = 0;
    const char *message_str = NULL;
    if (argc >= 1 && !JS_IsUndefined(argv[0])) {
        message_str = JS_ToCStringLen(ctx, &message_len, argv[0]);
        if (!message_str) return JS_EXCEPTION;
        message = message_str;
    }

    /* Parse name (default "Error") */
    const char *name = "Error";
    size_t name_len = 5;
    const char *name_str = NULL;
    if (argc >= 2 && !JS_IsUndefined(argv[1])) {
        name_str = JS_ToCStringLen(ctx, &name_len, argv[1]);
        if (!name_str) {
            if (message_str) JS_FreeCString(ctx, message_str);
            return JS_EXCEPTION;
        }
        name = name_str;
    }

    /* Allocate opaque data */
    DOMExceptionData *d = js_mallocz(ctx, sizeof(DOMExceptionData));
    if (!d) {
        if (message_str) JS_FreeCString(ctx, message_str);
        if (name_str) JS_FreeCString(ctx, name_str);
        return JS_EXCEPTION;
    }

    d->name = js_malloc(ctx, name_len + 1);
    if (!d->name) {
        js_free(ctx, d);
        if (message_str) JS_FreeCString(ctx, message_str);
        if (name_str) JS_FreeCString(ctx, name_str);
        return JS_EXCEPTION;
    }
    memcpy(d->name, name, name_len);
    d->name[name_len] = '\0';
    d->name_len = name_len;

    d->message = js_malloc(ctx, message_len + 1);
    if (!d->message) {
        js_free(ctx, d->name);
        js_free(ctx, d);
        if (message_str) JS_FreeCString(ctx, message_str);
        if (name_str) JS_FreeCString(ctx, name_str);
        return JS_EXCEPTION;
    }
    memcpy(d->message, message, message_len);
    d->message[message_len] = '\0';
    d->message_len = message_len;

    if (message_str) JS_FreeCString(ctx, message_str);
    if (name_str) JS_FreeCString(ctx, name_str);

    /* Create object */
    JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
    if (JS_IsException(proto)) {
        js_free(ctx, d->name);
        js_free(ctx, d->message);
        js_free(ctx, d);
        return JS_EXCEPTION;
    }

    JSValue obj = JS_NewObjectProtoClass(ctx, proto, js_dom_exception_class_id);
    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj)) {
        js_free(ctx, d->name);
        js_free(ctx, d->message);
        js_free(ctx, d);
        return JS_EXCEPTION;
    }

    JS_SetOpaque(obj, d);

    /* Set the "stack" property like a real Error would.
       We build a minimal stack trace string. */
    JSValue stack_str = JS_NewString(ctx, "");
    JS_SetPropertyStr(ctx, obj, "stack", stack_str);

    return obj;
}

/* ---- Property getters ---- */

static JSValue js_dom_exception_get_name(JSContext *ctx, JSValueConst this_val) {
    DOMExceptionData *d = (DOMExceptionData *)JS_GetOpaque(this_val, js_dom_exception_class_id);
    if (!d) return JS_EXCEPTION;
    return JS_NewStringLen(ctx, d->name, d->name_len);
}

static JSValue js_dom_exception_get_message(JSContext *ctx, JSValueConst this_val) {
    DOMExceptionData *d = (DOMExceptionData *)JS_GetOpaque(this_val, js_dom_exception_class_id);
    if (!d) return JS_EXCEPTION;
    return JS_NewStringLen(ctx, d->message, d->message_len);
}

static JSValue js_dom_exception_get_code(JSContext *ctx, JSValueConst this_val) {
    DOMExceptionData *d = (DOMExceptionData *)JS_GetOpaque(this_val, js_dom_exception_class_id);
    if (!d) return JS_EXCEPTION;
    return JS_NewInt32(ctx, legacy_code_for_name(d->name, d->name_len));
}

/* ---- toString() ---- */

static JSValue js_dom_exception_toString(JSContext *ctx, JSValueConst this_val,
                                          int argc, JSValueConst *argv)
{
    DOMExceptionData *d = (DOMExceptionData *)JS_GetOpaque(this_val, js_dom_exception_class_id);
    if (!d) return JS_EXCEPTION;

    if (d->message_len == 0) {
        return JS_NewStringLen(ctx, d->name, d->name_len);
    }

    /* "Name: message" */
    size_t total = d->name_len + 2 + d->message_len;
    char *buf = js_malloc(ctx, total + 1);
    if (!buf) return JS_EXCEPTION;
    memcpy(buf, d->name, d->name_len);
    buf[d->name_len] = ':';
    buf[d->name_len + 1] = ' ';
    memcpy(buf + d->name_len + 2, d->message, d->message_len);
    buf[total] = '\0';

    JSValue result = JS_NewStringLen(ctx, buf, total);
    js_free(ctx, buf);
    return result;
}

static const JSCFunctionListEntry js_dom_exception_proto_funcs[] = {
    JS_CGETSET_DEF("name", js_dom_exception_get_name, NULL),
    JS_CGETSET_DEF("message", js_dom_exception_get_message, NULL),
    JS_CGETSET_DEF("code", js_dom_exception_get_code, NULL),
    JS_CFUNC_DEF("toString", 0, js_dom_exception_toString),
};

/* ---- Legacy constants (on both prototype and constructor) ---- */

typedef struct {
    const char *name;
    int value;
} ConstEntry;

static const ConstEntry legacy_constants[] = {
    { "INDEX_SIZE_ERR",               1 },
    { "DOMSTRING_SIZE_ERR",           2 },
    { "HIERARCHY_REQUEST_ERR",        3 },
    { "WRONG_DOCUMENT_ERR",           4 },
    { "INVALID_CHARACTER_ERR",        5 },
    { "NO_DATA_ALLOWED_ERR",          6 },
    { "NO_MODIFICATION_ALLOWED_ERR",  7 },
    { "NOT_FOUND_ERR",                8 },
    { "NOT_SUPPORTED_ERR",            9 },
    { "INUSE_ATTRIBUTE_ERR",         10 },
    { "INVALID_STATE_ERR",           11 },
    { "SYNTAX_ERR",                  12 },
    { "INVALID_MODIFICATION_ERR",    13 },
    { "NAMESPACE_ERR",               14 },
    { "INVALID_ACCESS_ERR",          15 },
    { "VALIDATION_ERR",              16 },
    { "TYPE_MISMATCH_ERR",           17 },
    { "SECURITY_ERR",                18 },
    { "NETWORK_ERR",                 19 },
    { "ABORT_ERR",                   20 },
    { "URL_MISMATCH_ERR",            21 },
    { "QUOTA_EXCEEDED_ERR",          22 },
    { "TIMEOUT_ERR",                 23 },
    { "INVALID_NODE_TYPE_ERR",       24 },
    { "DATA_CLONE_ERR",              25 },
    { NULL, 0 }
};

static void set_legacy_constants(JSContext *ctx, JSValue obj) {
    for (const ConstEntry *c = legacy_constants; c->name; c++) {
        JS_SetPropertyStr(ctx, obj, c->name, JS_NewInt32(ctx, c->value));
    }
}

/* ---- Extension entry point ---- */

#define countof(x) (sizeof(x) / sizeof((x)[0]))

__attribute__((visibility("default")))
int qjs_ext_dom_exception_init(JSContext *ctx, JSRuntime *rt) {
    JSValue global = JS_GetGlobalObject(ctx);

    /* Register class */
    JS_NewClassID(rt, &js_dom_exception_class_id);
    JS_NewClass(rt, js_dom_exception_class_id, &js_dom_exception_class);

    JSValue ctor = JS_NewCFunction2(ctx, js_dom_exception_constructor,
                                     "DOMException", 0,
                                     JS_CFUNC_constructor, 0);

    /* Prototype chain: DOMException.prototype -> Error.prototype */
    JSValue error_ctor = JS_GetPropertyStr(ctx, global, "Error");
    JSValue error_proto = JS_GetPropertyStr(ctx, error_ctor, "prototype");
    JS_FreeValue(ctx, error_ctor);

    JSValue proto = JS_NewObjectProto(ctx, error_proto);
    JS_FreeValue(ctx, error_proto);

    JS_SetPropertyFunctionList(ctx, proto, js_dom_exception_proto_funcs,
                               countof(js_dom_exception_proto_funcs));
    JS_SetPropertyStr(ctx, proto, "constructor", JS_DupValue(ctx, ctor));

    /* Set legacy constants on both prototype and constructor */
    set_legacy_constants(ctx, proto);
    set_legacy_constants(ctx, ctor);

    JS_SetClassProto(ctx, js_dom_exception_class_id, proto);

    JSValue proto_ref = JS_GetClassProto(ctx, js_dom_exception_class_id);
    JS_SetPropertyStr(ctx, ctor, "prototype", proto_ref);

    JS_SetPropertyStr(ctx, global, "DOMException", ctor);
    JS_FreeValue(ctx, global);

    return 0;
}
