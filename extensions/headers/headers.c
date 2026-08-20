/*
 * QuickJS Extension: Headers
 *
 * A WHATWG Fetch Standard compliant implementation of the Headers Web API.
 * Compiled as a WASM shared library (.so) that links against the QuickJS C API
 * exported by the main quickjs.wasm module.
 *
 * Implements the full Headers interface:
 *   - Constructor: new Headers(), new Headers(init)
 *   - Methods: append, delete, get, getSetCookie, has, set
 *   - Iteration: entries, keys, values, forEach, Symbol.iterator
 *
 * Key spec behaviors:
 *   - Header names are case-insensitive
 *   - Names are validated against the HTTP field-name token production
 *   - Values are validated (no NUL, no CR, no LF) and normalized
 *     (leading/trailing HTTP whitespace stripped)
 *   - Iteration order is sorted lexicographically by lowercase name
 *   - Non-Set-Cookie headers with the same name are combined with ", "
 *   - Set-Cookie headers are kept separate in iteration
 *   - Guard is always "none" (standalone Headers, not tied to Request/Response)
 *
 * References:
 *   - https://fetch.spec.whatwg.org/#headers-class
 *   - https://developer.mozilla.org/en-US/docs/Web/API/Headers
 */

#include "quickjs.h"
#include <stdlib.h>
#include <string.h>

/* ---- Header entry ---- */

typedef struct {
    char *name;   /* original-cased name */
    char *value;  /* normalized value */
} HeaderEntry;

/* ---- Headers opaque data ---- */

typedef struct {
    HeaderEntry *entries;
    size_t count;
    size_t capacity;
} HeadersData;

static JSClassID js_headers_class_id;

/* ---- Helpers ---- */

static char ascii_lower(char c) {
    if (c >= 'A' && c <= 'Z') return c + ('a' - 'A');
    return c;
}

/* Case-insensitive comparison of two strings */
static int name_eq(const char *a, const char *b) {
    while (*a && *b) {
        if (ascii_lower(*a) != ascii_lower(*b)) return 0;
        a++;
        b++;
    }
    return *a == *b;
}

/* Comparison for sorting: byte-lowercased lexicographic order */
static int name_cmp_lower(const char *a, const char *b) {
    while (*a && *b) {
        char la = ascii_lower(*a);
        char lb = ascii_lower(*b);
        if (la != lb) return (unsigned char)la < (unsigned char)lb ? -1 : 1;
        a++;
        b++;
    }
    if (*a) return 1;
    if (*b) return -1;
    return 0;
}

/* Validate a header name per RFC 9110 field-name production:
 *   field-name = token
 *   token = 1*tchar
 *   tchar = "!" / "#" / "$" / "%" / "&" / "'" / "*" / "+" / "-" / "." /
 *           "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
 */
static int is_valid_name(const char *name, size_t len) {
    if (len == 0) return 0;
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)name[i];
        if (c < 0x21 || c > 0x7E) return 0;
        /* Forbidden characters in token: ( ) , / : ; < = > ? @ [ \ ] { } " */
        switch (c) {
        case '(': case ')': case ',': case '/': case ':':
        case ';': case '<': case '=': case '>': case '?':
        case '@': case '[': case '\\': case ']': case '{':
        case '}': case '"':
            return 0;
        }
    }
    return 1;
}

/* Validate a header value per spec:
 *   - No 0x00 (NUL)
 *   - No 0x0A (LF)
 *   - No 0x0D (CR)
 */
static int is_valid_value(const char *value, size_t len) {
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)value[i];
        if (c == 0x00 || c == 0x0A || c == 0x0D) return 0;
    }
    return 1;
}

/* Normalize a header value: strip leading/trailing HTTP whitespace
 * HTTP whitespace bytes: 0x09 (HT), 0x0A (LF), 0x0D (CR), 0x20 (SP)
 */
static void normalize_value(const char *input, size_t input_len,
                            const char **out, size_t *out_len) {
    const char *start = input;
    const char *end = input + input_len;

    while (start < end) {
        unsigned char c = (unsigned char)*start;
        if (c == 0x09 || c == 0x0A || c == 0x0D || c == 0x20) {
            start++;
        } else {
            break;
        }
    }

    while (end > start) {
        unsigned char c = (unsigned char)*(end - 1);
        if (c == 0x09 || c == 0x0A || c == 0x0D || c == 0x20) {
            end--;
        } else {
            break;
        }
    }

    *out = start;
    *out_len = end - start;
}

/* ---- HeadersData operations ---- */

static HeadersData *headers_new(JSContext *ctx) {
    HeadersData *h = js_mallocz(ctx, sizeof(HeadersData));
    if (!h) return NULL;
    h->entries = NULL;
    h->count = 0;
    h->capacity = 0;
    return h;
}

static int headers_grow(JSContext *ctx, HeadersData *h) {
    if (h->count >= h->capacity) {
        size_t new_cap = h->capacity == 0 ? 8 : h->capacity * 2;
        HeaderEntry *new_entries = js_realloc(ctx, h->entries,
                                              new_cap * sizeof(HeaderEntry));
        if (!new_entries) return -1;
        h->entries = new_entries;
        h->capacity = new_cap;
    }
    return 0;
}

static char *dup_str(JSContext *ctx, const char *s, size_t len) {
    char *d = js_malloc(ctx, len + 1);
    if (!d) return NULL;
    memcpy(d, s, len);
    d[len] = '\0';
    return d;
}

/* Spec: "If list contains name, then set name to the first such header's name."
 * Then append (name, value) to list. */
static int headers_append(JSContext *ctx, HeadersData *h,
                          const char *name, size_t name_len,
                          const char *value, size_t value_len) {
    /* Find existing name to reuse casing */
    const char *use_name = name;
    size_t use_name_len = name_len;
    for (size_t i = 0; i < h->count; i++) {
        if (name_eq(h->entries[i].name, name)) {
            use_name = h->entries[i].name;
            use_name_len = strlen(h->entries[i].name);
            break;
        }
    }

    if (headers_grow(ctx, h) < 0) return -1;

    char *n = dup_str(ctx, use_name, use_name_len);
    if (!n) return -1;
    char *v = dup_str(ctx, value, value_len);
    if (!v) { js_free(ctx, n); return -1; }

    h->entries[h->count].name = n;
    h->entries[h->count].value = v;
    h->count++;
    return 0;
}

/* Spec: "If list contains name, then set the value of the first such header
 * to value and remove the others. Otherwise, append (name, value) to list." */
static int headers_set(JSContext *ctx, HeadersData *h,
                       const char *name, size_t name_len,
                       const char *value, size_t value_len) {
    int found = 0;
    size_t first_idx = 0;

    /* Find first match */
    for (size_t i = 0; i < h->count; i++) {
        if (name_eq(h->entries[i].name, name)) {
            if (!found) {
                first_idx = i;
                found = 1;
                /* Update value of first match */
                char *v = dup_str(ctx, value, value_len);
                if (!v) return -1;
                js_free(ctx, h->entries[i].value);
                h->entries[i].value = v;
            } else {
                /* Remove subsequent matches */
                js_free(ctx, h->entries[i].name);
                js_free(ctx, h->entries[i].value);
                memmove(&h->entries[i], &h->entries[i + 1],
                        (h->count - i - 1) * sizeof(HeaderEntry));
                h->count--;
                i--;
            }
        }
    }

    if (!found) {
        return headers_append(ctx, h, name, name_len, value, value_len);
    }

    return 0;
}

/* Spec: "Remove all headers whose name is a byte-case-insensitive match for name." */
static void headers_delete(JSContext *ctx, HeadersData *h, const char *name) {
    for (size_t i = 0; i < h->count; i++) {
        if (name_eq(h->entries[i].name, name)) {
            js_free(ctx, h->entries[i].name);
            js_free(ctx, h->entries[i].value);
            memmove(&h->entries[i], &h->entries[i + 1],
                    (h->count - i - 1) * sizeof(HeaderEntry));
            h->count--;
            i--;
        }
    }
}

/* Spec: "Return the values of all headers in list whose name is a
 * byte-case-insensitive match for name, separated by 0x2C 0x20." */
static char *headers_get(JSContext *ctx, HeadersData *h, const char *name,
                         size_t *out_len) {
    /* Calculate total length */
    size_t total = 0;
    int found = 0;
    for (size_t i = 0; i < h->count; i++) {
        if (name_eq(h->entries[i].name, name)) {
            if (found) total += 2; /* ", " */
            total += strlen(h->entries[i].value);
            found++;
        }
    }

    if (!found) {
        *out_len = 0;
        return NULL;
    }

    char *result = js_malloc(ctx, total + 1);
    if (!result) {
        *out_len = 0;
        return NULL;
    }

    char *p = result;
    int first = 1;
    for (size_t i = 0; i < h->count; i++) {
        if (name_eq(h->entries[i].name, name)) {
            if (!first) {
                *p++ = ',';
                *p++ = ' ';
            }
            size_t vlen = strlen(h->entries[i].value);
            memcpy(p, h->entries[i].value, vlen);
            p += vlen;
            first = 0;
        }
    }
    *p = '\0';
    *out_len = total;
    return result;
}

static int headers_has(HeadersData *h, const char *name) {
    for (size_t i = 0; i < h->count; i++) {
        if (name_eq(h->entries[i].name, name)) return 1;
    }
    return 0;
}

static void headers_free(JSContext *ctx, HeadersData *h) {
    for (size_t i = 0; i < h->count; i++) {
        js_free(ctx, h->entries[i].name);
        js_free(ctx, h->entries[i].value);
    }
    if (h->entries) js_free(ctx, h->entries);
    js_free(ctx, h);
}

static void headers_free_rt(JSRuntime *rt, HeadersData *h) {
    for (size_t i = 0; i < h->count; i++) {
        js_free_rt(rt, h->entries[i].name);
        js_free_rt(rt, h->entries[i].value);
    }
    if (h->entries) js_free_rt(rt, h->entries);
    js_free_rt(rt, h);
}

/* ---- Finalizer ---- */

static void js_headers_finalizer(JSRuntime *rt, JSValue val) {
    HeadersData *h = (HeadersData *)JS_GetOpaque(val, js_headers_class_id);
    if (h) {
        headers_free_rt(rt, h);
    }
}

static JSClassDef js_headers_class = {
    "Headers",
    .finalizer = js_headers_finalizer,
};

/* ---- Validate + normalize helper for append/set ---- */

/* Returns 0 on success, throws TypeError and returns -1 on failure.
 * On success, *norm_value and *norm_value_len are set to the normalized value. */
static int validate_and_normalize(JSContext *ctx,
                                  const char *name, size_t name_len,
                                  const char *value, size_t value_len,
                                  const char **norm_value, size_t *norm_value_len) {
    /* Normalize value first (strip leading/trailing HTTP whitespace) */
    normalize_value(value, value_len, norm_value, norm_value_len);

    /* Validate name */
    if (!is_valid_name(name, name_len)) {
        JS_ThrowTypeError(ctx, "Invalid header name");
        return -1;
    }

    /* Validate normalized value */
    if (!is_valid_value(*norm_value, *norm_value_len)) {
        JS_ThrowTypeError(ctx, "Invalid header value");
        return -1;
    }

    return 0;
}

/* ---- Constructor ---- */

/* Fill headers from a JS init value (sequence<sequence<ByteString>> or record) */
static int fill_headers(JSContext *ctx, HeadersData *h, JSValueConst init) {
    /* Check if it's a Headers instance first */
    HeadersData *src = (HeadersData *)JS_GetOpaque(init, js_headers_class_id);
    if (src) {
        for (size_t i = 0; i < src->count; i++) {
            const char *nv;
            size_t nv_len;
            normalize_value(src->entries[i].value, strlen(src->entries[i].value),
                           &nv, &nv_len);
            if (headers_append(ctx, h, src->entries[i].name,
                              strlen(src->entries[i].name), nv, nv_len) < 0)
                return -1;
        }
        return 0;
    }

    /* Check if it's iterable (sequence<sequence<ByteString>>) */
    int is_array = JS_IsArray(init);
    if (is_array) {
        /* Sequence: each element must be a 2-element sequence [name, value] */
        JSValue length_val = JS_GetPropertyStr(ctx, init, "length");
        if (JS_IsException(length_val)) return -1;
        uint32_t length;
        if (JS_ToUint32(ctx, &length, length_val)) {
            JS_FreeValue(ctx, length_val);
            return -1;
        }
        JS_FreeValue(ctx, length_val);

        for (uint32_t i = 0; i < length; i++) {
            JSValue entry = JS_GetPropertyUint32(ctx, init, i);
            if (JS_IsException(entry)) return -1;

            /* Each entry must be a 2-element sequence */
            JSValue entry_len_val = JS_GetPropertyStr(ctx, entry, "length");
            if (JS_IsException(entry_len_val)) {
                JS_FreeValue(ctx, entry);
                return -1;
            }
            uint32_t entry_len;
            JS_ToUint32(ctx, &entry_len, entry_len_val);
            JS_FreeValue(ctx, entry_len_val);

            if (entry_len != 2) {
                JS_FreeValue(ctx, entry);
                JS_ThrowTypeError(ctx, "Failed to construct 'Headers': Invalid value");
                return -1;
            }

            JSValue key_val = JS_GetPropertyUint32(ctx, entry, 0);
            JSValue val_val = JS_GetPropertyUint32(ctx, entry, 1);
            JS_FreeValue(ctx, entry);

            if (JS_IsException(key_val) || JS_IsException(val_val)) {
                JS_FreeValue(ctx, key_val);
                JS_FreeValue(ctx, val_val);
                return -1;
            }

            size_t key_len, val_len;
            const char *key = JS_ToCStringLen(ctx, &key_len, key_val);
            const char *val = JS_ToCStringLen(ctx, &val_len, val_val);
            JS_FreeValue(ctx, key_val);
            JS_FreeValue(ctx, val_val);

            if (!key || !val) {
                if (key) JS_FreeCString(ctx, key);
                if (val) JS_FreeCString(ctx, val);
                return -1;
            }

            const char *nv;
            size_t nv_len;
            if (validate_and_normalize(ctx, key, key_len, val, val_len,
                                       &nv, &nv_len) < 0) {
                JS_FreeCString(ctx, key);
                JS_FreeCString(ctx, val);
                return -1;
            }

            int rc = headers_append(ctx, h, key, key_len, nv, nv_len);
            JS_FreeCString(ctx, key);
            JS_FreeCString(ctx, val);
            if (rc < 0) return -1;
        }
        return 0;
    }

    /* Otherwise, treat as record<ByteString, ByteString> */
    /* Get own property names */
    JSPropertyEnum *tab;
    uint32_t tab_len;
    if (JS_GetOwnPropertyNames(ctx, &tab, &tab_len, init,
                                JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
        return -1;

    for (uint32_t i = 0; i < tab_len; i++) {
        JSValue key_val = JS_AtomToString(ctx, tab[i].atom);
        JSValue val_val = JS_GetProperty(ctx, init, tab[i].atom);

        if (JS_IsException(key_val) || JS_IsException(val_val)) {
            JS_FreeValue(ctx, key_val);
            JS_FreeValue(ctx, val_val);
            js_free(ctx, tab);
            return -1;
        }

        size_t key_len, val_len;
        const char *key = JS_ToCStringLen(ctx, &key_len, key_val);
        const char *val = JS_ToCStringLen(ctx, &val_len, val_val);
        JS_FreeValue(ctx, key_val);
        JS_FreeValue(ctx, val_val);

        if (!key || !val) {
            if (key) JS_FreeCString(ctx, key);
            if (val) JS_FreeCString(ctx, val);
            js_free(ctx, tab);
            return -1;
        }

        const char *nv;
        size_t nv_len;
        if (validate_and_normalize(ctx, key, key_len, val, val_len,
                                   &nv, &nv_len) < 0) {
            JS_FreeCString(ctx, key);
            JS_FreeCString(ctx, val);
            js_free(ctx, tab);
            return -1;
        }

        int rc = headers_append(ctx, h, key, key_len, nv, nv_len);
        JS_FreeCString(ctx, key);
        JS_FreeCString(ctx, val);
        if (rc < 0) {
            js_free(ctx, tab);
            return -1;
        }
    }

    for (uint32_t i = 0; i < tab_len; i++)
        JS_FreeAtom(ctx, tab[i].atom);
    js_free(ctx, tab);
    return 0;
}

static JSValue js_headers_constructor(JSContext *ctx, JSValueConst new_target,
                                       int argc, JSValueConst *argv) {
    HeadersData *h = headers_new(ctx);
    if (!h) return JS_EXCEPTION;

    /* Fill from init if provided */
    if (argc >= 1 && !JS_IsUndefined(argv[0]) && !JS_IsNull(argv[0])) {
        if (fill_headers(ctx, h, argv[0]) < 0) {
            headers_free(ctx, h);
            return JS_EXCEPTION;
        }
    }

    JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
    if (JS_IsException(proto)) {
        headers_free(ctx, h);
        return JS_EXCEPTION;
    }

    JSValue obj = JS_NewObjectProtoClass(ctx, proto, js_headers_class_id);
    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj)) {
        headers_free(ctx, h);
        return JS_EXCEPTION;
    }

    JS_SetOpaque(obj, h);
    return obj;
}

/* ---- Instance methods ---- */

static JSValue js_headers_append(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    HeadersData *h = (HeadersData *)JS_GetOpaque(this_val, js_headers_class_id);
    if (!h) return JS_EXCEPTION;
    if (argc < 2) return JS_ThrowTypeError(ctx, "append requires 2 arguments");

    size_t name_len, value_len;
    const char *name = JS_ToCStringLen(ctx, &name_len, argv[0]);
    if (!name) return JS_EXCEPTION;
    const char *value = JS_ToCStringLen(ctx, &value_len, argv[1]);
    if (!value) { JS_FreeCString(ctx, name); return JS_EXCEPTION; }

    const char *nv;
    size_t nv_len;
    if (validate_and_normalize(ctx, name, name_len, value, value_len,
                               &nv, &nv_len) < 0) {
        JS_FreeCString(ctx, name);
        JS_FreeCString(ctx, value);
        return JS_EXCEPTION;
    }

    int rc = headers_append(ctx, h, name, name_len, nv, nv_len);
    JS_FreeCString(ctx, name);
    JS_FreeCString(ctx, value);
    if (rc < 0) return JS_EXCEPTION;
    return JS_UNDEFINED;
}

static JSValue js_headers_delete(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    HeadersData *h = (HeadersData *)JS_GetOpaque(this_val, js_headers_class_id);
    if (!h) return JS_EXCEPTION;
    if (argc < 1) return JS_ThrowTypeError(ctx, "delete requires 1 argument");

    size_t name_len;
    const char *name = JS_ToCStringLen(ctx, &name_len, argv[0]);
    if (!name) return JS_EXCEPTION;

    if (!is_valid_name(name, name_len)) {
        JS_FreeCString(ctx, name);
        return JS_ThrowTypeError(ctx, "Invalid header name");
    }

    headers_delete(ctx, h, name);
    JS_FreeCString(ctx, name);
    return JS_UNDEFINED;
}

static JSValue js_headers_get(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    HeadersData *h = (HeadersData *)JS_GetOpaque(this_val, js_headers_class_id);
    if (!h) return JS_EXCEPTION;
    if (argc < 1) return JS_ThrowTypeError(ctx, "get requires 1 argument");

    size_t name_len;
    const char *name = JS_ToCStringLen(ctx, &name_len, argv[0]);
    if (!name) return JS_EXCEPTION;

    if (!is_valid_name(name, name_len)) {
        JS_FreeCString(ctx, name);
        return JS_ThrowTypeError(ctx, "Invalid header name");
    }

    size_t result_len;
    char *result = headers_get(ctx, h, name, &result_len);
    JS_FreeCString(ctx, name);

    if (!result) return JS_NULL;

    JSValue str = JS_NewStringLen(ctx, result, result_len);
    js_free(ctx, result);
    return str;
}

static JSValue js_headers_getSetCookie(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv) {
    HeadersData *h = (HeadersData *)JS_GetOpaque(this_val, js_headers_class_id);
    if (!h) return JS_EXCEPTION;

    JSValue arr = JS_NewArray(ctx);
    uint32_t idx = 0;
    for (size_t i = 0; i < h->count; i++) {
        if (name_eq(h->entries[i].name, "set-cookie")) {
            JS_SetPropertyUint32(ctx, arr, idx++,
                JS_NewString(ctx, h->entries[i].value));
        }
    }
    return arr;
}

static JSValue js_headers_has(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    HeadersData *h = (HeadersData *)JS_GetOpaque(this_val, js_headers_class_id);
    if (!h) return JS_EXCEPTION;
    if (argc < 1) return JS_ThrowTypeError(ctx, "has requires 1 argument");

    size_t name_len;
    const char *name = JS_ToCStringLen(ctx, &name_len, argv[0]);
    if (!name) return JS_EXCEPTION;

    if (!is_valid_name(name, name_len)) {
        JS_FreeCString(ctx, name);
        return JS_ThrowTypeError(ctx, "Invalid header name");
    }

    int result = headers_has(h, name);
    JS_FreeCString(ctx, name);
    return JS_NewBool(ctx, result);
}

static JSValue js_headers_set(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    HeadersData *h = (HeadersData *)JS_GetOpaque(this_val, js_headers_class_id);
    if (!h) return JS_EXCEPTION;
    if (argc < 2) return JS_ThrowTypeError(ctx, "set requires 2 arguments");

    size_t name_len, value_len;
    const char *name = JS_ToCStringLen(ctx, &name_len, argv[0]);
    if (!name) return JS_EXCEPTION;
    const char *value = JS_ToCStringLen(ctx, &value_len, argv[1]);
    if (!value) { JS_FreeCString(ctx, name); return JS_EXCEPTION; }

    const char *nv;
    size_t nv_len;
    if (validate_and_normalize(ctx, name, name_len, value, value_len,
                               &nv, &nv_len) < 0) {
        JS_FreeCString(ctx, name);
        JS_FreeCString(ctx, value);
        return JS_EXCEPTION;
    }

    int rc = headers_set(ctx, h, name, name_len, nv, nv_len);
    JS_FreeCString(ctx, name);
    JS_FreeCString(ctx, value);
    if (rc < 0) return JS_EXCEPTION;
    return JS_UNDEFINED;
}

/* ---- Iteration: sort and combine ---- */

/* Entry for sorted iteration result */
typedef struct {
    char *name;   /* lowercased name (owned) */
    char *value;  /* combined or individual value (owned) */
} SortedEntry;

static int sorted_entry_cmp(const void *a, const void *b) {
    const SortedEntry *ea = (const SortedEntry *)a;
    const SortedEntry *eb = (const SortedEntry *)b;
    int nc = strcmp(ea->name, eb->name);
    if (nc != 0) return nc;
    /* For set-cookie, preserve original order via stable sort.
       Since qsort isn't guaranteed stable, we rely on the fact
       that values are appended in order. For same-name non-set-cookie
       entries this doesn't matter since they get combined. */
    return strcmp(ea->value, eb->value);
}

/* Build the "sort and combine" result per spec.
 * Returns a newly allocated array of SortedEntry. Caller must free. */
static SortedEntry *headers_sort_and_combine(JSContext *ctx, HeadersData *h,
                                              size_t *out_count) {
    if (h->count == 0) {
        *out_count = 0;
        return NULL;
    }

    /* Step 1: Collect unique lowercased names, sorted */
    /* We'll allocate a temporary array of lowercased names */
    char **lower_names = js_malloc(ctx, h->count * sizeof(char *));
    if (!lower_names) {
        *out_count = 0;
        return NULL;
    }

    for (size_t i = 0; i < h->count; i++) {
        size_t nlen = strlen(h->entries[i].name);
        lower_names[i] = js_malloc(ctx, nlen + 1);
        if (!lower_names[i]) {
            for (size_t j = 0; j < i; j++) js_free(ctx, lower_names[j]);
            js_free(ctx, lower_names);
            *out_count = 0;
            return NULL;
        }
        for (size_t k = 0; k < nlen; k++)
            lower_names[i][k] = ascii_lower(h->entries[i].name[k]);
        lower_names[i][nlen] = '\0';
    }

    /* Sort the lowercased names */
    /* We need to sort indices by their lowercased names */
    size_t *indices = js_malloc(ctx, h->count * sizeof(size_t));
    if (!indices) {
        for (size_t i = 0; i < h->count; i++) js_free(ctx, lower_names[i]);
        js_free(ctx, lower_names);
        *out_count = 0;
        return NULL;
    }
    for (size_t i = 0; i < h->count; i++) indices[i] = i;

    /* Insertion sort: stable, which set-cookie ordering requires */
    for (size_t i = 1; i < h->count; i++) {
        size_t key = indices[i];
        size_t j = i;
        while (j > 0 && strcmp(lower_names[indices[j - 1]], lower_names[key]) > 0) {
            indices[j] = indices[j - 1];
            j--;
        }
        indices[j] = key;
    }

    /* Step 2: Build sorted+combined entries */
    /* Worst case: every entry is a separate set-cookie */
    SortedEntry *result = js_malloc(ctx, h->count * sizeof(SortedEntry));
    if (!result) {
        for (size_t i = 0; i < h->count; i++) js_free(ctx, lower_names[i]);
        js_free(ctx, lower_names);
        js_free(ctx, indices);
        *out_count = 0;
        return NULL;
    }
    size_t result_count = 0;

    size_t i = 0;
    while (i < h->count) {
        size_t idx = indices[i];
        const char *lname = lower_names[idx];

        if (strcmp(lname, "set-cookie") == 0) {
            /* Set-Cookie: each value is a separate entry */
            char *n = dup_str(ctx, lname, strlen(lname));
            char *v = dup_str(ctx, h->entries[idx].value,
                             strlen(h->entries[idx].value));
            if (!n || !v) {
                if (n) js_free(ctx, n);
                if (v) js_free(ctx, v);
                goto cleanup_error;
            }
            result[result_count].name = n;
            result[result_count].value = v;
            result_count++;
            i++;
        } else {
            /* Non-set-cookie: combine all values with ", " */
            /* First, collect all entries with this name */
            size_t total_len = 0;
            size_t group_start = i;
            while (i < h->count && strcmp(lower_names[indices[i]], lname) == 0) {
                if (i > group_start) total_len += 2; /* ", " */
                total_len += strlen(h->entries[indices[i]].value);
                i++;
            }

            char *combined = js_malloc(ctx, total_len + 1);
            if (!combined) goto cleanup_error;
            char *p = combined;
            for (size_t j = group_start; j < i; j++) {
                if (j > group_start) {
                    *p++ = ',';
                    *p++ = ' ';
                }
                const char *val = h->entries[indices[j]].value;
                size_t vlen = strlen(val);
                memcpy(p, val, vlen);
                p += vlen;
            }
            *p = '\0';

            char *n = dup_str(ctx, lname, strlen(lname));
            if (!n) {
                js_free(ctx, combined);
                goto cleanup_error;
            }

            result[result_count].name = n;
            result[result_count].value = combined;
            result_count++;
        }
    }

    for (size_t j = 0; j < h->count; j++) js_free(ctx, lower_names[j]);
    js_free(ctx, lower_names);
    js_free(ctx, indices);

    *out_count = result_count;
    return result;

cleanup_error:
    for (size_t j = 0; j < result_count; j++) {
        js_free(ctx, result[j].name);
        js_free(ctx, result[j].value);
    }
    js_free(ctx, result);
    for (size_t j = 0; j < h->count; j++) js_free(ctx, lower_names[j]);
    js_free(ctx, lower_names);
    js_free(ctx, indices);
    *out_count = 0;
    return NULL;
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
    JSAtom atom = JS_ValueToAtom(ctx, iter_sym);
    JS_FreeValue(ctx, iter_sym);
    if (atom == JS_ATOM_NULL) {
        JS_FreeValue(ctx, arr);
        return JS_EXCEPTION;
    }
    JSValue iter_fn = JS_GetProperty(ctx, arr, atom);
    JS_FreeAtom(ctx, atom);
    if (JS_IsException(iter_fn)) {
        JS_FreeValue(ctx, arr);
        return JS_EXCEPTION;
    }
    JSValue result = JS_Call(ctx, iter_fn, arr, 0, NULL);
    JS_FreeValue(ctx, iter_fn);
    JS_FreeValue(ctx, arr);
    return result;
}

static JSValue js_headers_entries(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    HeadersData *h = (HeadersData *)JS_GetOpaque(this_val, js_headers_class_id);
    if (!h) return JS_EXCEPTION;

    size_t count;
    SortedEntry *sorted = headers_sort_and_combine(ctx, h, &count);

    JSValue arr = JS_NewArray(ctx);
    for (size_t i = 0; i < count; i++) {
        JSValue pair = JS_NewArray(ctx);
        JS_SetPropertyUint32(ctx, pair, 0, JS_NewString(ctx, sorted[i].name));
        JS_SetPropertyUint32(ctx, pair, 1, JS_NewString(ctx, sorted[i].value));
        JS_SetPropertyUint32(ctx, arr, i, pair);
        js_free(ctx, sorted[i].name);
        js_free(ctx, sorted[i].value);
    }
    if (sorted) js_free(ctx, sorted);

    return js_call_array_iterator(ctx, arr);
}

static JSValue js_headers_keys(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    HeadersData *h = (HeadersData *)JS_GetOpaque(this_val, js_headers_class_id);
    if (!h) return JS_EXCEPTION;

    size_t count;
    SortedEntry *sorted = headers_sort_and_combine(ctx, h, &count);

    JSValue arr = JS_NewArray(ctx);
    for (size_t i = 0; i < count; i++) {
        JS_SetPropertyUint32(ctx, arr, i, JS_NewString(ctx, sorted[i].name));
        js_free(ctx, sorted[i].name);
        js_free(ctx, sorted[i].value);
    }
    if (sorted) js_free(ctx, sorted);

    return js_call_array_iterator(ctx, arr);
}

static JSValue js_headers_values(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    HeadersData *h = (HeadersData *)JS_GetOpaque(this_val, js_headers_class_id);
    if (!h) return JS_EXCEPTION;

    size_t count;
    SortedEntry *sorted = headers_sort_and_combine(ctx, h, &count);

    JSValue arr = JS_NewArray(ctx);
    for (size_t i = 0; i < count; i++) {
        JS_SetPropertyUint32(ctx, arr, i, JS_NewString(ctx, sorted[i].value));
        js_free(ctx, sorted[i].name);
        js_free(ctx, sorted[i].value);
    }
    if (sorted) js_free(ctx, sorted);

    return js_call_array_iterator(ctx, arr);
}

static JSValue js_headers_forEach(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    HeadersData *h = (HeadersData *)JS_GetOpaque(this_val, js_headers_class_id);
    if (!h) return JS_EXCEPTION;
    if (argc < 1 || !JS_IsFunction(ctx, argv[0]))
        return JS_ThrowTypeError(ctx, "forEach requires a callable argument");

    JSValue callback = argv[0];
    JSValue this_arg = argc >= 2 ? argv[1] : JS_UNDEFINED;

    size_t count;
    SortedEntry *sorted = headers_sort_and_combine(ctx, h, &count);

    for (size_t i = 0; i < count; i++) {
        JSValue args[3];
        args[0] = JS_NewString(ctx, sorted[i].value);
        args[1] = JS_NewString(ctx, sorted[i].name);
        args[2] = JS_DupValue(ctx, this_val);

        JSValue result = JS_Call(ctx, callback, this_arg, 3, args);

        JS_FreeValue(ctx, args[0]);
        JS_FreeValue(ctx, args[1]);
        JS_FreeValue(ctx, args[2]);

        if (JS_IsException(result)) {
            /* Clean up remaining entries */
            for (size_t j = i; j < count; j++) {
                js_free(ctx, sorted[j].name);
                js_free(ctx, sorted[j].value);
            }
            js_free(ctx, sorted);
            return JS_EXCEPTION;
        }
        JS_FreeValue(ctx, result);

        js_free(ctx, sorted[i].name);
        js_free(ctx, sorted[i].value);
    }
    if (sorted) js_free(ctx, sorted);

    return JS_UNDEFINED;
}

/* ---- Prototype function list ---- */

static const JSCFunctionListEntry js_headers_proto_funcs[] = {
    JS_CFUNC_DEF("append", 2, js_headers_append),
    JS_CFUNC_DEF("delete", 1, js_headers_delete),
    JS_CFUNC_DEF("get", 1, js_headers_get),
    JS_CFUNC_DEF("getSetCookie", 0, js_headers_getSetCookie),
    JS_CFUNC_DEF("has", 1, js_headers_has),
    JS_CFUNC_DEF("set", 2, js_headers_set),
    JS_CFUNC_DEF("entries", 0, js_headers_entries),
    JS_CFUNC_DEF("keys", 0, js_headers_keys),
    JS_CFUNC_DEF("values", 0, js_headers_values),
    JS_CFUNC_DEF("forEach", 1, js_headers_forEach),
};

/* ---- Extension entry point ---- */

#define countof(x) (sizeof(x) / sizeof((x)[0]))

__attribute__((visibility("default")))
int qjs_ext_headers_init(JSContext *ctx, JSRuntime *rt) {
    JSValue global = JS_GetGlobalObject(ctx);

    /* Register Headers class */
    JS_NewClassID(rt, &js_headers_class_id);
    JS_NewClass(rt, js_headers_class_id, &js_headers_class);

    JSValue ctor = JS_NewCFunction2(ctx, js_headers_constructor,
                                     "Headers", 0,
                                     JS_CFUNC_constructor, 0);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, js_headers_proto_funcs,
                               countof(js_headers_proto_funcs));
    JS_DefinePropertyValueStr(ctx, proto, "constructor", JS_DupValue(ctx, ctor),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);

    /* Set Symbol.iterator = entries */
    {
        JSValue symbol = JS_GetPropertyStr(ctx, global, "Symbol");
        JSValue iter_sym = JS_GetPropertyStr(ctx, symbol, "iterator");
        JSAtom atom = JS_ValueToAtom(ctx, iter_sym);
        JS_FreeValue(ctx, iter_sym);
        JS_FreeValue(ctx, symbol);

        JSValue entries_fn = JS_GetPropertyStr(ctx, proto, "entries");
        JS_SetProperty(ctx, proto, atom, entries_fn);
        JS_FreeAtom(ctx, atom);
    }

    JS_SetClassProto(ctx, js_headers_class_id, proto);

    JSValue proto_ref = JS_GetClassProto(ctx, js_headers_class_id);
    JS_DefinePropertyValueStr(ctx, ctor, "prototype", proto_ref, 0);

    JS_DefinePropertyValueStr(ctx, global, "Headers", ctor,
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);

    JS_FreeValue(ctx, global);
    return 0;
}
