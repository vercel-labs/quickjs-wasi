/*
 * QuickJS Extension: URL and URLSearchParams
 *
 * A WHATWG URL Standard compliant implementation backed by the ada-url library
 * (https://github.com/ada-url/ada). Compiled as a WASM shared library (.so)
 * that links against the QuickJS C API exported by the main quickjs.wasm module.
 *
 * The extension provides:
 *   - URL class (constructor with base URL support, property getters/setters,
 *     toString, toJSON, canParse static method)
 *   - URLSearchParams class (constructor, get, getAll, set, has, delete,
 *     append, sort, toString, size, entries, keys, values, forEach)
 *
 * NOTE: All string conversions use JS_ToCStringLen() (not JS_ToCString())
 * to correctly handle JavaScript strings containing embedded null bytes (\u0000).
 * The ada C API accepts explicit length parameters for this reason.
 */

#include "quickjs.h"
#include "ada/ada_c.h"
#include <stdlib.h>
#include <string.h>

/* ---- Helper: create a JS string from an ada_string (non-owning view) ---- */

static JSValue js_new_string_from_ada(JSContext *ctx, ada_string s) {
    if (s.data == NULL || s.length == 0)
        return JS_NewString(ctx, "");
    return JS_NewStringLen(ctx, s.data, s.length);
}

/* ---- URL Class ---- */

static JSClassID js_url_class_id;

static void js_url_finalizer(JSRuntime *rt, JSValue val) {
    ada_url url = (ada_url)JS_GetOpaque(val, js_url_class_id);
    if (url) {
        ada_free(url);
    }
}

static JSClassDef js_url_class = {
    "URL",
    .finalizer = js_url_finalizer,
};

static JSValue js_url_constructor(JSContext *ctx, JSValueConst new_target,
                                   int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "URL constructor requires at least 1 argument");

    size_t input_len;
    const char *input = JS_ToCStringLen(ctx, &input_len, argv[0]);
    if (!input) return JS_EXCEPTION;

    ada_url url;
    if (argc >= 2 && !JS_IsUndefined(argv[1])) {
        size_t base_len;
        const char *base = JS_ToCStringLen(ctx, &base_len, argv[1]);
        if (!base) {
            JS_FreeCString(ctx, input);
            return JS_EXCEPTION;
        }
        url = ada_parse_with_base(input, input_len, base, base_len);
        JS_FreeCString(ctx, base);
    } else {
        url = ada_parse(input, input_len);
    }
    JS_FreeCString(ctx, input);

    if (!ada_is_valid(url)) {
        ada_free(url);
        return JS_ThrowTypeError(ctx, "Invalid URL");
    }

    JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
    if (JS_IsException(proto)) {
        ada_free(url);
        return JS_EXCEPTION;
    }

    JSValue obj = JS_NewObjectProtoClass(ctx, proto, js_url_class_id);
    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj)) {
        ada_free(url);
        return JS_EXCEPTION;
    }

    JS_SetOpaque(obj, url);
    return obj;
}

/* Property getters */

static JSValue js_url_get_href(JSContext *ctx, JSValueConst this_val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    return js_new_string_from_ada(ctx, ada_get_href(url));
}

static JSValue js_url_get_protocol(JSContext *ctx, JSValueConst this_val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    return js_new_string_from_ada(ctx, ada_get_protocol(url));
}

static JSValue js_url_get_username(JSContext *ctx, JSValueConst this_val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    return js_new_string_from_ada(ctx, ada_get_username(url));
}

static JSValue js_url_get_password(JSContext *ctx, JSValueConst this_val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    return js_new_string_from_ada(ctx, ada_get_password(url));
}

static JSValue js_url_get_host(JSContext *ctx, JSValueConst this_val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    return js_new_string_from_ada(ctx, ada_get_host(url));
}

static JSValue js_url_get_hostname(JSContext *ctx, JSValueConst this_val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    return js_new_string_from_ada(ctx, ada_get_hostname(url));
}

static JSValue js_url_get_port(JSContext *ctx, JSValueConst this_val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    return js_new_string_from_ada(ctx, ada_get_port(url));
}

static JSValue js_url_get_pathname(JSContext *ctx, JSValueConst this_val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    return js_new_string_from_ada(ctx, ada_get_pathname(url));
}

static JSValue js_url_get_search(JSContext *ctx, JSValueConst this_val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    return js_new_string_from_ada(ctx, ada_get_search(url));
}

static JSValue js_url_get_hash(JSContext *ctx, JSValueConst this_val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    return js_new_string_from_ada(ctx, ada_get_hash(url));
}

static JSValue js_url_get_origin(JSContext *ctx, JSValueConst this_val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    ada_owned_string origin = ada_get_origin(url);
    JSValue result;
    if (origin.data == NULL) {
        result = JS_NewString(ctx, "");
    } else {
        result = JS_NewStringLen(ctx, origin.data, origin.length);
    }
    ada_free_owned_string(origin);
    return result;
}

/* Property setters */

static JSValue js_url_set_href(JSContext *ctx, JSValueConst this_val, JSValueConst val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    size_t len;
    const char *str = JS_ToCStringLen(ctx, &len, val);
    if (!str) return JS_EXCEPTION;
    if (!ada_set_href(url, str, len)) {
        JS_FreeCString(ctx, str);
        return JS_ThrowTypeError(ctx, "Invalid URL");
    }
    JS_FreeCString(ctx, str);
    return JS_UNDEFINED;
}

static JSValue js_url_set_protocol(JSContext *ctx, JSValueConst this_val, JSValueConst val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    size_t len;
    const char *str = JS_ToCStringLen(ctx, &len, val);
    if (!str) return JS_EXCEPTION;
    ada_set_protocol(url, str, len);
    JS_FreeCString(ctx, str);
    return JS_UNDEFINED;
}

static JSValue js_url_set_username(JSContext *ctx, JSValueConst this_val, JSValueConst val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    size_t len;
    const char *str = JS_ToCStringLen(ctx, &len, val);
    if (!str) return JS_EXCEPTION;
    ada_set_username(url, str, len);
    JS_FreeCString(ctx, str);
    return JS_UNDEFINED;
}

static JSValue js_url_set_password(JSContext *ctx, JSValueConst this_val, JSValueConst val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    size_t len;
    const char *str = JS_ToCStringLen(ctx, &len, val);
    if (!str) return JS_EXCEPTION;
    ada_set_password(url, str, len);
    JS_FreeCString(ctx, str);
    return JS_UNDEFINED;
}

static JSValue js_url_set_host(JSContext *ctx, JSValueConst this_val, JSValueConst val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    size_t len;
    const char *str = JS_ToCStringLen(ctx, &len, val);
    if (!str) return JS_EXCEPTION;
    ada_set_host(url, str, len);
    JS_FreeCString(ctx, str);
    return JS_UNDEFINED;
}

static JSValue js_url_set_hostname(JSContext *ctx, JSValueConst this_val, JSValueConst val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    size_t len;
    const char *str = JS_ToCStringLen(ctx, &len, val);
    if (!str) return JS_EXCEPTION;
    ada_set_hostname(url, str, len);
    JS_FreeCString(ctx, str);
    return JS_UNDEFINED;
}

static JSValue js_url_set_port(JSContext *ctx, JSValueConst this_val, JSValueConst val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    size_t len;
    const char *str = JS_ToCStringLen(ctx, &len, val);
    if (!str) return JS_EXCEPTION;
    ada_set_port(url, str, len);
    JS_FreeCString(ctx, str);
    return JS_UNDEFINED;
}

static JSValue js_url_set_pathname(JSContext *ctx, JSValueConst this_val, JSValueConst val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    size_t len;
    const char *str = JS_ToCStringLen(ctx, &len, val);
    if (!str) return JS_EXCEPTION;
    ada_set_pathname(url, str, len);
    JS_FreeCString(ctx, str);
    return JS_UNDEFINED;
}

static JSValue js_url_set_search(JSContext *ctx, JSValueConst this_val, JSValueConst val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    size_t len;
    const char *str = JS_ToCStringLen(ctx, &len, val);
    if (!str) return JS_EXCEPTION;
    ada_set_search(url, str, len);
    JS_FreeCString(ctx, str);
    return JS_UNDEFINED;
}

static JSValue js_url_set_hash(JSContext *ctx, JSValueConst this_val, JSValueConst val) {
    ada_url url = (ada_url)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    size_t len;
    const char *str = JS_ToCStringLen(ctx, &len, val);
    if (!str) return JS_EXCEPTION;
    ada_set_hash(url, str, len);
    JS_FreeCString(ctx, str);
    return JS_UNDEFINED;
}

/* Methods */

static JSValue js_url_toString(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    return js_url_get_href(ctx, this_val);
}

static JSValue js_url_toJSON(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    return js_url_get_href(ctx, this_val);
}

/* Static method: URL.canParse(url [, base]) */
static JSValue js_url_canParse(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    if (argc < 1)
        return JS_FALSE;

    size_t input_len;
    const char *input = JS_ToCStringLen(ctx, &input_len, argv[0]);
    if (!input) return JS_EXCEPTION;

    int result;
    if (argc >= 2 && !JS_IsUndefined(argv[1])) {
        size_t base_len;
        const char *base = JS_ToCStringLen(ctx, &base_len, argv[1]);
        if (!base) {
            JS_FreeCString(ctx, input);
            return JS_EXCEPTION;
        }
        result = ada_can_parse_with_base(input, input_len, base, base_len);
        JS_FreeCString(ctx, base);
    } else {
        result = ada_can_parse(input, input_len);
    }
    JS_FreeCString(ctx, input);
    return result ? JS_TRUE : JS_FALSE;
}

static const JSCFunctionListEntry js_url_proto_funcs[] = {
    JS_CGETSET_DEF("href", js_url_get_href, js_url_set_href),
    JS_CGETSET_DEF("protocol", js_url_get_protocol, js_url_set_protocol),
    JS_CGETSET_DEF("username", js_url_get_username, js_url_set_username),
    JS_CGETSET_DEF("password", js_url_get_password, js_url_set_password),
    JS_CGETSET_DEF("host", js_url_get_host, js_url_set_host),
    JS_CGETSET_DEF("hostname", js_url_get_hostname, js_url_set_hostname),
    JS_CGETSET_DEF("port", js_url_get_port, js_url_set_port),
    JS_CGETSET_DEF("pathname", js_url_get_pathname, js_url_set_pathname),
    JS_CGETSET_DEF("search", js_url_get_search, js_url_set_search),
    JS_CGETSET_DEF("hash", js_url_get_hash, js_url_set_hash),
    JS_CGETSET_DEF("origin", js_url_get_origin, NULL),
    JS_CFUNC_DEF("toString", 0, js_url_toString),
    JS_CFUNC_DEF("toJSON", 0, js_url_toJSON),
};

/* ---- URLSearchParams Class ---- */

static JSClassID js_search_params_class_id;

static void js_search_params_finalizer(JSRuntime *rt, JSValue val) {
    ada_url_search_params sp = (ada_url_search_params)JS_GetOpaque(val, js_search_params_class_id);
    if (sp) {
        ada_free_search_params(sp);
    }
}

static JSClassDef js_search_params_class = {
    "URLSearchParams",
    .finalizer = js_search_params_finalizer,
};

static JSValue js_search_params_constructor(JSContext *ctx, JSValueConst new_target,
                                             int argc, JSValueConst *argv)
{
    ada_url_search_params sp;

    if (argc >= 1 && JS_IsString(argv[0])) {
        size_t str_len;
        const char *str = JS_ToCStringLen(ctx, &str_len, argv[0]);
        if (!str) return JS_EXCEPTION;
        /* Skip leading '?' if present */
        const char *input = str;
        size_t input_len = str_len;
        if (input_len > 0 && *input == '?') {
            input++;
            input_len--;
        }
        sp = ada_parse_search_params(input, input_len);
        JS_FreeCString(ctx, str);
    } else {
        sp = ada_parse_search_params("", 0);
    }

    if (!sp) return JS_ThrowOutOfMemory(ctx);

    JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
    if (JS_IsException(proto)) {
        ada_free_search_params(sp);
        return JS_EXCEPTION;
    }

    JSValue obj = JS_NewObjectProtoClass(ctx, proto, js_search_params_class_id);
    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj)) {
        ada_free_search_params(sp);
        return JS_EXCEPTION;
    }

    JS_SetOpaque(obj, sp);
    return obj;
}

static JSValue js_search_params_get(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    ada_url_search_params sp = (ada_url_search_params)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp || argc < 1) return JS_NULL;

    size_t key_len;
    const char *key = JS_ToCStringLen(ctx, &key_len, argv[0]);
    if (!key) return JS_EXCEPTION;

    if (!ada_search_params_has(sp, key, key_len)) {
        JS_FreeCString(ctx, key);
        return JS_NULL;
    }

    ada_string val = ada_search_params_get(sp, key, key_len);
    JS_FreeCString(ctx, key);
    return js_new_string_from_ada(ctx, val);
}

static JSValue js_search_params_getAll(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    ada_url_search_params sp = (ada_url_search_params)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp || argc < 1) return JS_NewArray(ctx);

    size_t key_len;
    const char *key = JS_ToCStringLen(ctx, &key_len, argv[0]);
    if (!key) return JS_EXCEPTION;

    ada_strings strings = ada_search_params_get_all(sp, key, key_len);
    JS_FreeCString(ctx, key);

    size_t count = ada_strings_size(strings);
    JSValue arr = JS_NewArray(ctx);
    for (size_t i = 0; i < count; i++) {
        ada_string s = ada_strings_get(strings, i);
        JS_SetPropertyUint32(ctx, arr, i, js_new_string_from_ada(ctx, s));
    }
    ada_free_strings(strings);
    return arr;
}

static JSValue js_search_params_set(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    ada_url_search_params sp = (ada_url_search_params)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp || argc < 2) return JS_UNDEFINED;

    size_t key_len, value_len;
    const char *key = JS_ToCStringLen(ctx, &key_len, argv[0]);
    const char *value = JS_ToCStringLen(ctx, &value_len, argv[1]);
    if (!key || !value) {
        if (key) JS_FreeCString(ctx, key);
        if (value) JS_FreeCString(ctx, value);
        return JS_EXCEPTION;
    }

    ada_search_params_set(sp, key, key_len, value, value_len);
    JS_FreeCString(ctx, key);
    JS_FreeCString(ctx, value);
    return JS_UNDEFINED;
}

static JSValue js_search_params_has(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    ada_url_search_params sp = (ada_url_search_params)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp || argc < 1) return JS_FALSE;

    size_t key_len;
    const char *key = JS_ToCStringLen(ctx, &key_len, argv[0]);
    if (!key) return JS_EXCEPTION;

    int result;
    if (argc >= 2 && !JS_IsUndefined(argv[1])) {
        size_t value_len;
        const char *value = JS_ToCStringLen(ctx, &value_len, argv[1]);
        if (!value) {
            JS_FreeCString(ctx, key);
            return JS_EXCEPTION;
        }
        result = ada_search_params_has_value(sp, key, key_len, value, value_len);
        JS_FreeCString(ctx, value);
    } else {
        result = ada_search_params_has(sp, key, key_len);
    }
    JS_FreeCString(ctx, key);
    return result ? JS_TRUE : JS_FALSE;
}

static JSValue js_search_params_delete(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    ada_url_search_params sp = (ada_url_search_params)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp || argc < 1) return JS_UNDEFINED;

    size_t key_len;
    const char *key = JS_ToCStringLen(ctx, &key_len, argv[0]);
    if (!key) return JS_EXCEPTION;

    if (argc >= 2 && !JS_IsUndefined(argv[1])) {
        size_t value_len;
        const char *value = JS_ToCStringLen(ctx, &value_len, argv[1]);
        if (!value) {
            JS_FreeCString(ctx, key);
            return JS_EXCEPTION;
        }
        ada_search_params_remove_value(sp, key, key_len, value, value_len);
        JS_FreeCString(ctx, value);
    } else {
        ada_search_params_remove(sp, key, key_len);
    }
    JS_FreeCString(ctx, key);
    return JS_UNDEFINED;
}

static JSValue js_search_params_append(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    ada_url_search_params sp = (ada_url_search_params)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp || argc < 2) return JS_UNDEFINED;

    size_t key_len, value_len;
    const char *key = JS_ToCStringLen(ctx, &key_len, argv[0]);
    const char *value = JS_ToCStringLen(ctx, &value_len, argv[1]);
    if (!key || !value) {
        if (key) JS_FreeCString(ctx, key);
        if (value) JS_FreeCString(ctx, value);
        return JS_EXCEPTION;
    }

    ada_search_params_append(sp, key, key_len, value, value_len);
    JS_FreeCString(ctx, key);
    JS_FreeCString(ctx, value);
    return JS_UNDEFINED;
}

static JSValue js_search_params_sort(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    ada_url_search_params sp = (ada_url_search_params)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp) return JS_UNDEFINED;
    ada_search_params_sort(sp);
    return JS_UNDEFINED;
}

static JSValue js_search_params_toString(JSContext *ctx, JSValueConst this_val,
                                          int argc, JSValueConst *argv)
{
    ada_url_search_params sp = (ada_url_search_params)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp) return JS_NewString(ctx, "");

    ada_owned_string str = ada_search_params_to_string(sp);
    JSValue result;
    if (str.data == NULL) {
        result = JS_NewString(ctx, "");
    } else {
        result = JS_NewStringLen(ctx, str.data, str.length);
    }
    ada_free_owned_string(str);
    return result;
}

static JSValue js_search_params_get_size(JSContext *ctx, JSValueConst this_val)
{
    ada_url_search_params sp = (ada_url_search_params)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp) return JS_NewInt32(ctx, 0);
    return JS_NewInt32(ctx, (int)ada_search_params_size(sp));
}

static JSValue js_search_params_forEach(JSContext *ctx, JSValueConst this_val,
                                         int argc, JSValueConst *argv)
{
    ada_url_search_params sp = (ada_url_search_params)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp || argc < 1) return JS_UNDEFINED;

    JSValueConst callback = argv[0];
    JSValue this_arg = argc >= 2 ? JS_DupValue(ctx, argv[1]) : JS_UNDEFINED;

    ada_url_search_params_entries_iter iter = ada_search_params_get_entries(sp);
    while (ada_search_params_entries_iter_has_next(iter)) {
        ada_string_pair pair = ada_search_params_entries_iter_next(iter);
        JSValue key = js_new_string_from_ada(ctx, pair.key);
        JSValue value = js_new_string_from_ada(ctx, pair.value);

        JSValue args[3] = { value, key, this_val };
        JSValue ret = JS_Call(ctx, callback, this_arg, 3, args);
        JS_FreeValue(ctx, key);
        JS_FreeValue(ctx, value);
        if (JS_IsException(ret)) {
            ada_free_search_params_entries_iter(iter);
            JS_FreeValue(ctx, this_arg);
            return JS_EXCEPTION;
        }
        JS_FreeValue(ctx, ret);
    }
    ada_free_search_params_entries_iter(iter);
    JS_FreeValue(ctx, this_arg);
    return JS_UNDEFINED;
}

/* Helper: call arr[Symbol.iterator]() and return the iterator */
static JSValue js_call_array_iterator(JSContext *ctx, JSValue arr) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue symbol = JS_GetPropertyStr(ctx, global, "Symbol");
    JS_FreeValue(ctx, global);
    if (JS_IsException(symbol)) {
        JS_FreeValue(ctx, arr);
        return JS_EXCEPTION;
    }
    JSValue iter_sym = JS_GetPropertyStr(ctx, symbol, "iterator");
    JS_FreeValue(ctx, symbol);
    if (JS_IsException(iter_sym)) {
        JS_FreeValue(ctx, arr);
        return JS_EXCEPTION;
    }
    JSValue iter_fn = JS_GetProperty(ctx, arr, JS_ValueToAtom(ctx, iter_sym));
    JS_FreeValue(ctx, iter_sym);
    if (JS_IsException(iter_fn)) {
        JS_FreeValue(ctx, arr);
        return JS_EXCEPTION;
    }
    JSValue result = JS_Call(ctx, iter_fn, arr, 0, NULL);
    JS_FreeValue(ctx, iter_fn);
    JS_FreeValue(ctx, arr);
    return result;
}

static JSValue js_search_params_entries(JSContext *ctx, JSValueConst this_val,
                                         int argc, JSValueConst *argv)
{
    ada_url_search_params sp = (ada_url_search_params)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp) return JS_NewArray(ctx);

    ada_url_search_params_entries_iter iter = ada_search_params_get_entries(sp);
    JSValue arr = JS_NewArray(ctx);
    uint32_t idx = 0;
    while (ada_search_params_entries_iter_has_next(iter)) {
        ada_string_pair pair = ada_search_params_entries_iter_next(iter);
        JSValue entry = JS_NewArray(ctx);
        JS_SetPropertyUint32(ctx, entry, 0, js_new_string_from_ada(ctx, pair.key));
        JS_SetPropertyUint32(ctx, entry, 1, js_new_string_from_ada(ctx, pair.value));
        JS_SetPropertyUint32(ctx, arr, idx++, entry);
    }
    ada_free_search_params_entries_iter(iter);

    return js_call_array_iterator(ctx, arr);
}

static JSValue js_search_params_keys(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    ada_url_search_params sp = (ada_url_search_params)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp) return JS_NewArray(ctx);

    ada_url_search_params_keys_iter iter = ada_search_params_get_keys(sp);
    JSValue arr = JS_NewArray(ctx);
    uint32_t idx = 0;
    while (ada_search_params_keys_iter_has_next(iter)) {
        ada_string key = ada_search_params_keys_iter_next(iter);
        JS_SetPropertyUint32(ctx, arr, idx++, js_new_string_from_ada(ctx, key));
    }
    ada_free_search_params_keys_iter(iter);

    return js_call_array_iterator(ctx, arr);
}

static JSValue js_search_params_values(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    ada_url_search_params sp = (ada_url_search_params)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp) return JS_NewArray(ctx);

    ada_url_search_params_values_iter iter = ada_search_params_get_values(sp);
    JSValue arr = JS_NewArray(ctx);
    uint32_t idx = 0;
    while (ada_search_params_values_iter_has_next(iter)) {
        ada_string value = ada_search_params_values_iter_next(iter);
        JS_SetPropertyUint32(ctx, arr, idx++, js_new_string_from_ada(ctx, value));
    }
    ada_free_search_params_values_iter(iter);

    return js_call_array_iterator(ctx, arr);
}

static const JSCFunctionListEntry js_search_params_proto_funcs[] = {
    JS_CFUNC_DEF("get", 1, js_search_params_get),
    JS_CFUNC_DEF("getAll", 1, js_search_params_getAll),
    JS_CFUNC_DEF("set", 2, js_search_params_set),
    JS_CFUNC_DEF("has", 1, js_search_params_has),
    JS_CFUNC_DEF("delete", 1, js_search_params_delete),
    JS_CFUNC_DEF("append", 2, js_search_params_append),
    JS_CFUNC_DEF("sort", 0, js_search_params_sort),
    JS_CFUNC_DEF("toString", 0, js_search_params_toString),
    JS_CFUNC_DEF("forEach", 1, js_search_params_forEach),
    JS_CFUNC_DEF("entries", 0, js_search_params_entries),
    JS_CFUNC_DEF("keys", 0, js_search_params_keys),
    JS_CFUNC_DEF("values", 0, js_search_params_values),
    JS_CGETSET_DEF("size", js_search_params_get_size, NULL),
};

/* ---- Extension entry point ---- */

__attribute__((visibility("default")))
int qjs_ext_url_init(JSContext *ctx, JSRuntime *rt) {
    /* Register URL class */
    JS_NewClassID(rt, &js_url_class_id);
    JS_NewClass(rt, js_url_class_id, &js_url_class);

    JSValue url_ctor = JS_NewCFunction2(ctx, js_url_constructor, "URL", 1,
                                         JS_CFUNC_constructor, 0);

    JSValue url_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, url_proto, js_url_proto_funcs,
                               sizeof(js_url_proto_funcs) / sizeof(js_url_proto_funcs[0]));
    /* Set prototype.constructor so that `new URL(...).constructor.name === "URL"` */
    JS_SetPropertyStr(ctx, url_proto, "constructor", JS_DupValue(ctx, url_ctor));
    JS_SetClassProto(ctx, js_url_class_id, url_proto);

    JSValue url_proto_ref = JS_GetClassProto(ctx, js_url_class_id);
    JS_DefinePropertyValueStr(ctx, url_ctor, "prototype", url_proto_ref, 0);

    JS_SetPropertyStr(ctx, url_ctor, "canParse",
        JS_NewCFunction(ctx, js_url_canParse, "canParse", 1));

    JSValue global = JS_GetGlobalObject(ctx);
    JS_DefinePropertyValueStr(ctx, global, "URL", url_ctor,
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);

    /* Register URLSearchParams class */
    JS_NewClassID(rt, &js_search_params_class_id);
    JS_NewClass(rt, js_search_params_class_id, &js_search_params_class);

    JSValue sp_ctor = JS_NewCFunction2(ctx, js_search_params_constructor, "URLSearchParams", 0,
                                        JS_CFUNC_constructor, 0);

    JSValue sp_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, sp_proto, js_search_params_proto_funcs,
                               sizeof(js_search_params_proto_funcs) / sizeof(js_search_params_proto_funcs[0]));
    JS_SetPropertyStr(ctx, sp_proto, "constructor", JS_DupValue(ctx, sp_ctor));

    /* Set Symbol.iterator = entries (per WHATWG URL spec) */
    {
        JSValue symbol = JS_GetPropertyStr(ctx, global, "Symbol");
        JSValue iter_sym = JS_GetPropertyStr(ctx, symbol, "iterator");
        JSAtom atom = JS_ValueToAtom(ctx, iter_sym);
        JS_FreeValue(ctx, iter_sym);
        JS_FreeValue(ctx, symbol);

        JSValue entries_fn = JS_GetPropertyStr(ctx, sp_proto, "entries");
        JS_SetProperty(ctx, sp_proto, atom, entries_fn);
        JS_FreeAtom(ctx, atom);
    }

    JS_SetClassProto(ctx, js_search_params_class_id, sp_proto);

    JSValue sp_proto_ref = JS_GetClassProto(ctx, js_search_params_class_id);
    JS_DefinePropertyValueStr(ctx, sp_ctor, "prototype", sp_proto_ref, 0);

    JS_DefinePropertyValueStr(ctx, global, "URLSearchParams", sp_ctor,
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);

    JS_FreeValue(ctx, global);

    return 0;
}
