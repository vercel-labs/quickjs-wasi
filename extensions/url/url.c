/*
 * QuickJS Extension: URL and URLSearchParams
 *
 * A minimal implementation of the WHATWG URL API as a native QuickJS extension.
 * This is compiled as a WASM shared library (.so) that links against the
 * QuickJS C API exported by the main quickjs.wasm module.
 *
 * The extension provides:
 *   - URL class (constructor, properties, toString)
 *   - URLSearchParams class (constructor, get, set, has, delete, toString, entries)
 */

#include "quickjs.h"
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

/* ---- Simple URL parser ---- */

typedef struct {
    char *href;
    char *protocol;
    char *username;
    char *password;
    char *hostname;
    char *port;
    char *pathname;
    char *search;
    char *hash;
} ParsedURL;

static void parsed_url_free(ParsedURL *url) {
    if (url->href) free(url->href);
    if (url->protocol) free(url->protocol);
    if (url->username) free(url->username);
    if (url->password) free(url->password);
    if (url->hostname) free(url->hostname);
    if (url->port) free(url->port);
    if (url->pathname) free(url->pathname);
    if (url->search) free(url->search);
    if (url->hash) free(url->hash);
}

static char *my_strndup(const char *s, size_t n) {
    char *r = (char *)malloc(n + 1);
    if (r) {
        memcpy(r, s, n);
        r[n] = '\0';
    }
    return r;
}

static char *my_strdup(const char *s) {
    return my_strndup(s, strlen(s));
}

/*
 * Simple URL parser. Not fully WHATWG compliant but handles common cases:
 *   protocol://username:password@hostname:port/pathname?search#hash
 */
static int parse_url(const char *input, ParsedURL *out) {
    memset(out, 0, sizeof(*out));

    const char *p = input;

    /* Protocol */
    const char *colon = strchr(p, ':');
    if (!colon || colon == p) return -1;

    /* Verify protocol is [a-zA-Z][a-zA-Z0-9+.-]* */
    for (const char *c = p; c < colon; c++) {
        if (c == p) {
            if (!isalpha((unsigned char)*c)) return -1;
        } else {
            if (!isalnum((unsigned char)*c) && *c != '+' && *c != '-' && *c != '.') return -1;
        }
    }

    out->protocol = my_strndup(p, colon - p + 1); /* include the ':' */
    p = colon + 1;

    /* Authority: // */
    int has_authority = 0;
    if (p[0] == '/' && p[1] == '/') {
        has_authority = 1;
        p += 2;
    }

    if (has_authority) {
        /* Find end of authority (before /, ?, #) */
        const char *auth_end = p;
        while (*auth_end && *auth_end != '/' && *auth_end != '?' && *auth_end != '#') {
            auth_end++;
        }

        /* Check for userinfo@ */
        const char *at = NULL;
        for (const char *c = p; c < auth_end; c++) {
            if (*c == '@') { at = c; break; }
        }

        const char *host_start = p;
        if (at) {
            /* Parse username:password */
            const char *userinfo_colon = NULL;
            for (const char *c = p; c < at; c++) {
                if (*c == ':') { userinfo_colon = c; break; }
            }
            if (userinfo_colon) {
                out->username = my_strndup(p, userinfo_colon - p);
                out->password = my_strndup(userinfo_colon + 1, at - userinfo_colon - 1);
            } else {
                out->username = my_strndup(p, at - p);
                out->password = my_strdup("");
            }
            host_start = at + 1;
        } else {
            out->username = my_strdup("");
            out->password = my_strdup("");
        }

        /* Parse hostname:port */
        const char *port_colon = NULL;
        /* Handle IPv6 addresses [::1] */
        if (*host_start == '[') {
            const char *bracket = strchr(host_start, ']');
            if (bracket && bracket < auth_end) {
                if (bracket + 1 < auth_end && *(bracket + 1) == ':') {
                    port_colon = bracket + 1;
                }
                out->hostname = my_strndup(host_start, (port_colon ? port_colon : auth_end) - host_start);
            } else {
                out->hostname = my_strndup(host_start, auth_end - host_start);
            }
        } else {
            for (const char *c = host_start; c < auth_end; c++) {
                if (*c == ':') { port_colon = c; break; }
            }
            out->hostname = my_strndup(host_start, (port_colon ? port_colon : auth_end) - host_start);
        }

        if (port_colon) {
            out->port = my_strndup(port_colon + 1, auth_end - port_colon - 1);
        } else {
            out->port = my_strdup("");
        }

        p = auth_end;
    } else {
        out->username = my_strdup("");
        out->password = my_strdup("");
        out->hostname = my_strdup("");
        out->port = my_strdup("");
    }

    /* Pathname */
    const char *path_end = p;
    while (*path_end && *path_end != '?' && *path_end != '#') path_end++;
    if (path_end > p) {
        out->pathname = my_strndup(p, path_end - p);
    } else {
        out->pathname = has_authority ? my_strdup("/") : my_strdup("");
    }
    p = path_end;

    /* Search */
    if (*p == '?') {
        const char *search_end = p;
        while (*search_end && *search_end != '#') search_end++;
        out->search = my_strndup(p, search_end - p);
        p = search_end;
    } else {
        out->search = my_strdup("");
    }

    /* Hash */
    if (*p == '#') {
        out->hash = my_strndup(p, strlen(p));
    } else {
        out->hash = my_strdup("");
    }

    /* Reconstruct href */
    size_t href_len = strlen(out->protocol) + 2 /* // */ +
        strlen(out->hostname) + strlen(out->pathname) +
        strlen(out->search) + strlen(out->hash) + 32;
    out->href = (char *)malloc(href_len);
    if (out->href) {
        char *w = out->href;
        w += sprintf(w, "%s//", out->protocol);
        if (out->username[0]) {
            w += sprintf(w, "%s", out->username);
            if (out->password[0]) {
                w += sprintf(w, ":%s", out->password);
            }
            w += sprintf(w, "@");
        }
        w += sprintf(w, "%s", out->hostname);
        if (out->port[0]) {
            w += sprintf(w, ":%s", out->port);
        }
        w += sprintf(w, "%s%s%s", out->pathname, out->search, out->hash);
    }

    return 0;
}

/* ---- URL Class ---- */

static JSClassID js_url_class_id;

static void js_url_finalizer(JSRuntime *rt, JSValue val) {
    ParsedURL *url = (ParsedURL *)JS_GetOpaque(val, js_url_class_id);
    if (url) {
        parsed_url_free(url);
        free(url);
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

    const char *input = JS_ToCString(ctx, argv[0]);
    if (!input) return JS_EXCEPTION;

    /* TODO: handle base URL (argv[1]) */

    ParsedURL *url = (ParsedURL *)malloc(sizeof(ParsedURL));
    if (!url) {
        JS_FreeCString(ctx, input);
        return JS_ThrowOutOfMemory(ctx);
    }

    if (parse_url(input, url) != 0) {
        free(url);
        JS_FreeCString(ctx, input);
        return JS_ThrowTypeError(ctx, "Invalid URL");
    }
    JS_FreeCString(ctx, input);

    JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
    if (JS_IsException(proto)) {
        parsed_url_free(url);
        free(url);
        return JS_EXCEPTION;
    }

    JSValue obj = JS_NewObjectProtoClass(ctx, proto, js_url_class_id);
    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj)) {
        parsed_url_free(url);
        free(url);
        return JS_EXCEPTION;
    }

    JS_SetOpaque(obj, url);
    return obj;
}

/* Property getters */
#define URL_GETTER(name, field) \
static JSValue js_url_get_##name(JSContext *ctx, JSValueConst this_val) { \
    ParsedURL *url = (ParsedURL *)JS_GetOpaque(this_val, js_url_class_id); \
    if (!url) return JS_EXCEPTION; \
    return JS_NewString(ctx, url->field ? url->field : ""); \
}

URL_GETTER(href, href)
URL_GETTER(protocol, protocol)
URL_GETTER(username, username)
URL_GETTER(password, password)
URL_GETTER(hostname, hostname)
URL_GETTER(port, port)
URL_GETTER(pathname, pathname)
URL_GETTER(search, search)
URL_GETTER(hash, hash)

static JSValue js_url_get_host(JSContext *ctx, JSValueConst this_val) {
    ParsedURL *url = (ParsedURL *)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;
    if (url->port && url->port[0]) {
        size_t len = strlen(url->hostname) + 1 + strlen(url->port) + 1;
        char *buf = (char *)malloc(len);
        snprintf(buf, len, "%s:%s", url->hostname, url->port);
        JSValue result = JS_NewString(ctx, buf);
        free(buf);
        return result;
    }
    return JS_NewString(ctx, url->hostname ? url->hostname : "");
}

static JSValue js_url_get_origin(JSContext *ctx, JSValueConst this_val) {
    ParsedURL *url = (ParsedURL *)JS_GetOpaque(this_val, js_url_class_id);
    if (!url) return JS_EXCEPTION;

    /* origin = protocol + "//" + host */
    const char *host = url->hostname ? url->hostname : "";
    const char *port = url->port ? url->port : "";
    size_t len = strlen(url->protocol) + 2 + strlen(host) + 1 + strlen(port) + 1;
    char *buf = (char *)malloc(len);
    if (port[0]) {
        snprintf(buf, len, "%s//%s:%s", url->protocol, host, port);
    } else {
        snprintf(buf, len, "%s//%s", url->protocol, host);
    }
    JSValue result = JS_NewString(ctx, buf);
    free(buf);
    return result;
}

static JSValue js_url_toString(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    return js_url_get_href(ctx, this_val);
}

static JSValue js_url_toJSON(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    return js_url_get_href(ctx, this_val);
}

static const JSCFunctionListEntry js_url_proto_funcs[] = {
    JS_CGETSET_DEF("href", js_url_get_href, NULL),
    JS_CGETSET_DEF("protocol", js_url_get_protocol, NULL),
    JS_CGETSET_DEF("username", js_url_get_username, NULL),
    JS_CGETSET_DEF("password", js_url_get_password, NULL),
    JS_CGETSET_DEF("host", js_url_get_host, NULL),
    JS_CGETSET_DEF("hostname", js_url_get_hostname, NULL),
    JS_CGETSET_DEF("port", js_url_get_port, NULL),
    JS_CGETSET_DEF("pathname", js_url_get_pathname, NULL),
    JS_CGETSET_DEF("search", js_url_get_search, NULL),
    JS_CGETSET_DEF("hash", js_url_get_hash, NULL),
    JS_CGETSET_DEF("origin", js_url_get_origin, NULL),
    JS_CFUNC_DEF("toString", 0, js_url_toString),
    JS_CFUNC_DEF("toJSON", 0, js_url_toJSON),
};

/* ---- URLSearchParams Class ---- */

typedef struct {
    char **keys;
    char **values;
    int count;
    int capacity;
} SearchParams;

static JSClassID js_search_params_class_id;

static void search_params_free(SearchParams *sp) {
    for (int i = 0; i < sp->count; i++) {
        free(sp->keys[i]);
        free(sp->values[i]);
    }
    free(sp->keys);
    free(sp->values);
}

static void js_search_params_finalizer(JSRuntime *rt, JSValue val) {
    SearchParams *sp = (SearchParams *)JS_GetOpaque(val, js_search_params_class_id);
    if (sp) {
        search_params_free(sp);
        free(sp);
    }
}

static JSClassDef js_search_params_class = {
    "URLSearchParams",
    .finalizer = js_search_params_finalizer,
};

static void search_params_append(SearchParams *sp, const char *key, const char *value) {
    if (sp->count >= sp->capacity) {
        int new_cap = sp->capacity ? sp->capacity * 2 : 8;
        sp->keys = (char **)realloc(sp->keys, sizeof(char *) * new_cap);
        sp->values = (char **)realloc(sp->values, sizeof(char *) * new_cap);
        sp->capacity = new_cap;
    }
    sp->keys[sp->count] = my_strdup(key);
    sp->values[sp->count] = my_strdup(value);
    sp->count++;
}

/* Parse "key1=value1&key2=value2" into SearchParams */
static void search_params_parse(SearchParams *sp, const char *input) {
    if (!input || !*input) return;
    /* Skip leading '?' */
    if (*input == '?') input++;

    while (*input) {
        const char *amp = strchr(input, '&');
        const char *pair_end = amp ? amp : input + strlen(input);

        const char *eq = NULL;
        for (const char *c = input; c < pair_end; c++) {
            if (*c == '=') { eq = c; break; }
        }

        if (eq) {
            char *key = my_strndup(input, eq - input);
            char *val = my_strndup(eq + 1, pair_end - eq - 1);
            search_params_append(sp, key, val);
            free(key);
            free(val);
        } else {
            char *key = my_strndup(input, pair_end - input);
            search_params_append(sp, key, "");
            free(key);
        }

        if (!amp) break;
        input = amp + 1;
    }
}

static JSValue js_search_params_constructor(JSContext *ctx, JSValueConst new_target,
                                             int argc, JSValueConst *argv)
{
    SearchParams *sp = (SearchParams *)calloc(1, sizeof(SearchParams));
    if (!sp) return JS_ThrowOutOfMemory(ctx);

    if (argc >= 1 && JS_IsString(argv[0])) {
        const char *str = JS_ToCString(ctx, argv[0]);
        if (str) {
            search_params_parse(sp, str);
            JS_FreeCString(ctx, str);
        }
    }

    JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
    if (JS_IsException(proto)) {
        search_params_free(sp);
        free(sp);
        return JS_EXCEPTION;
    }

    JSValue obj = JS_NewObjectProtoClass(ctx, proto, js_search_params_class_id);
    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj)) {
        search_params_free(sp);
        free(sp);
        return JS_EXCEPTION;
    }

    JS_SetOpaque(obj, sp);
    return obj;
}

static JSValue js_search_params_get(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    SearchParams *sp = (SearchParams *)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp || argc < 1) return JS_NULL;

    const char *key = JS_ToCString(ctx, argv[0]);
    if (!key) return JS_EXCEPTION;

    for (int i = 0; i < sp->count; i++) {
        if (strcmp(sp->keys[i], key) == 0) {
            JS_FreeCString(ctx, key);
            return JS_NewString(ctx, sp->values[i]);
        }
    }
    JS_FreeCString(ctx, key);
    return JS_NULL;
}

static JSValue js_search_params_set(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    SearchParams *sp = (SearchParams *)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp || argc < 2) return JS_UNDEFINED;

    const char *key = JS_ToCString(ctx, argv[0]);
    const char *value = JS_ToCString(ctx, argv[1]);
    if (!key || !value) {
        if (key) JS_FreeCString(ctx, key);
        if (value) JS_FreeCString(ctx, value);
        return JS_EXCEPTION;
    }

    /* Find and replace first occurrence, remove subsequent ones */
    int found = 0;
    for (int i = 0; i < sp->count; i++) {
        if (strcmp(sp->keys[i], key) == 0) {
            if (!found) {
                free(sp->values[i]);
                sp->values[i] = my_strdup(value);
                found = 1;
            } else {
                /* Remove duplicate */
                free(sp->keys[i]);
                free(sp->values[i]);
                memmove(&sp->keys[i], &sp->keys[i+1], sizeof(char *) * (sp->count - i - 1));
                memmove(&sp->values[i], &sp->values[i+1], sizeof(char *) * (sp->count - i - 1));
                sp->count--;
                i--;
            }
        }
    }

    if (!found) {
        search_params_append(sp, key, value);
    }

    JS_FreeCString(ctx, key);
    JS_FreeCString(ctx, value);
    return JS_UNDEFINED;
}

static JSValue js_search_params_has(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    SearchParams *sp = (SearchParams *)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp || argc < 1) return JS_FALSE;

    const char *key = JS_ToCString(ctx, argv[0]);
    if (!key) return JS_EXCEPTION;

    for (int i = 0; i < sp->count; i++) {
        if (strcmp(sp->keys[i], key) == 0) {
            JS_FreeCString(ctx, key);
            return JS_TRUE;
        }
    }
    JS_FreeCString(ctx, key);
    return JS_FALSE;
}

static JSValue js_search_params_delete(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    SearchParams *sp = (SearchParams *)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp || argc < 1) return JS_UNDEFINED;

    const char *key = JS_ToCString(ctx, argv[0]);
    if (!key) return JS_EXCEPTION;

    for (int i = 0; i < sp->count; i++) {
        if (strcmp(sp->keys[i], key) == 0) {
            free(sp->keys[i]);
            free(sp->values[i]);
            memmove(&sp->keys[i], &sp->keys[i+1], sizeof(char *) * (sp->count - i - 1));
            memmove(&sp->values[i], &sp->values[i+1], sizeof(char *) * (sp->count - i - 1));
            sp->count--;
            i--;
        }
    }

    JS_FreeCString(ctx, key);
    return JS_UNDEFINED;
}

static JSValue js_search_params_append(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    SearchParams *sp = (SearchParams *)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp || argc < 2) return JS_UNDEFINED;

    const char *key = JS_ToCString(ctx, argv[0]);
    const char *value = JS_ToCString(ctx, argv[1]);
    if (!key || !value) {
        if (key) JS_FreeCString(ctx, key);
        if (value) JS_FreeCString(ctx, value);
        return JS_EXCEPTION;
    }

    search_params_append(sp, key, value);

    JS_FreeCString(ctx, key);
    JS_FreeCString(ctx, value);
    return JS_UNDEFINED;
}

static JSValue js_search_params_toString(JSContext *ctx, JSValueConst this_val,
                                          int argc, JSValueConst *argv)
{
    SearchParams *sp = (SearchParams *)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp) return JS_NewString(ctx, "");

    /* Calculate total length */
    size_t total = 0;
    for (int i = 0; i < sp->count; i++) {
        if (i > 0) total++; /* & */
        total += strlen(sp->keys[i]) + 1 + strlen(sp->values[i]); /* key=value */
    }

    char *buf = (char *)malloc(total + 1);
    if (!buf) return JS_ThrowOutOfMemory(ctx);

    char *w = buf;
    for (int i = 0; i < sp->count; i++) {
        if (i > 0) *w++ = '&';
        w += sprintf(w, "%s=%s", sp->keys[i], sp->values[i]);
    }
    *w = '\0';

    JSValue result = JS_NewString(ctx, buf);
    free(buf);
    return result;
}

static JSValue js_search_params_get_size(JSContext *ctx, JSValueConst this_val)
{
    SearchParams *sp = (SearchParams *)JS_GetOpaque(this_val, js_search_params_class_id);
    if (!sp) return JS_NewInt32(ctx, 0);
    return JS_NewInt32(ctx, sp->count);
}

static const JSCFunctionListEntry js_search_params_proto_funcs[] = {
    JS_CFUNC_DEF("get", 1, js_search_params_get),
    JS_CFUNC_DEF("set", 2, js_search_params_set),
    JS_CFUNC_DEF("has", 1, js_search_params_has),
    JS_CFUNC_DEF("delete", 1, js_search_params_delete),
    JS_CFUNC_DEF("append", 2, js_search_params_append),
    JS_CFUNC_DEF("toString", 0, js_search_params_toString),
    JS_CGETSET_DEF("size", js_search_params_get_size, NULL),
};

/* ---- Extension entry point ---- */

/*
 * Initialize the URL extension. Called by the host after the extension
 * is dynamically loaded and linked.
 *
 * Registers URL and URLSearchParams classes on the global object.
 *
 * This function is exported from the shared library so the loader can find it.
 */
__attribute__((visibility("default")))
int qjs_ext_url_init(JSContext *ctx, JSRuntime *rt) {
    /* Register URL class */
    JS_NewClassID(rt, &js_url_class_id);
    JS_NewClass(rt, js_url_class_id, &js_url_class);

    JSValue url_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, url_proto, js_url_proto_funcs,
                               sizeof(js_url_proto_funcs) / sizeof(js_url_proto_funcs[0]));
    JS_SetClassProto(ctx, js_url_class_id, url_proto);

    JSValue url_ctor = JS_NewCFunction2(ctx, js_url_constructor, "URL", 1,
                                         JS_CFUNC_constructor, 0);
    /* Set constructor.prototype = url_proto (JS_SetClassProto consumed it, so get it back) */
    JSValue url_proto_ref = JS_GetClassProto(ctx, js_url_class_id);
    JS_SetPropertyStr(ctx, url_ctor, "prototype", url_proto_ref);

    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "URL", url_ctor);

    /* Register URLSearchParams class */
    JS_NewClassID(rt, &js_search_params_class_id);
    JS_NewClass(rt, js_search_params_class_id, &js_search_params_class);

    JSValue sp_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, sp_proto, js_search_params_proto_funcs,
                               sizeof(js_search_params_proto_funcs) / sizeof(js_search_params_proto_funcs[0]));
    JS_SetClassProto(ctx, js_search_params_class_id, sp_proto);

    JSValue sp_ctor = JS_NewCFunction2(ctx, js_search_params_constructor, "URLSearchParams", 0,
                                        JS_CFUNC_constructor, 0);
    /* Set constructor.prototype = sp_proto */
    JSValue sp_proto_ref = JS_GetClassProto(ctx, js_search_params_class_id);
    JS_SetPropertyStr(ctx, sp_ctor, "prototype", sp_proto_ref);

    JS_SetPropertyStr(ctx, global, "URLSearchParams", sp_ctor);

    JS_FreeValue(ctx, global);

    return 0;
}
