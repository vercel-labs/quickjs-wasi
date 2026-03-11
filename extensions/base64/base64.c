/*
 * QuickJS Extension: atob / btoa
 *
 * WHATWG HTML Standard compliant implementation of the Base64 utility methods.
 * Uses the "forgiving-base64" decode algorithm per the Infra Standard.
 *
 * References:
 *   - https://html.spec.whatwg.org/multipage/webappapis.html#atob
 *   - https://infra.spec.whatwg.org/#forgiving-base64
 *
 * NOTE: atob/btoa throw DOMException("InvalidCharacterError") per spec.
 * If DOMException is not available (extension not loaded), we throw a
 * regular Error with the same message as a reasonable fallback.
 */

#include "quickjs.h"
#include <string.h>

/* ---- Base64 alphabet ---- */

static const char b64_encode_table[64] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* Decode table: maps ASCII byte -> 0-63 value, or -1 for invalid, -2 for whitespace */
static int b64_decode_value(uint8_t c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    /* ASCII whitespace per Infra spec: TAB, LF, FF, CR, SPACE */
    if (c == 0x09 || c == 0x0A || c == 0x0C || c == 0x0D || c == 0x20) return -2;
    if (c == '=') return -3; /* padding */
    return -1; /* invalid */
}

/* ---- Helper: throw InvalidCharacterError ---- */

static JSValue throw_invalid_character(JSContext *ctx, const char *func_name) {
    /* Try to throw a DOMException if available */
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue dom_exc_ctor = JS_GetPropertyStr(ctx, global, "DOMException");
    JS_FreeValue(ctx, global);

    if (JS_IsFunction(ctx, dom_exc_ctor)) {
        JSValue msg = JS_NewString(ctx, func_name[0] == 'b'
            ? "The string to be encoded contains characters outside of the Latin1 range."
            : "The string to be decoded is not correctly encoded.");
        JSValue name = JS_NewString(ctx, "InvalidCharacterError");
        JSValue args[2] = { msg, name };
        JSValue exc = JS_CallConstructor(ctx, dom_exc_ctor, 2, args);
        JS_FreeValue(ctx, msg);
        JS_FreeValue(ctx, name);
        JS_FreeValue(ctx, dom_exc_ctor);
        if (!JS_IsException(exc)) {
            JS_Throw(ctx, exc); /* takes ownership */
            return JS_EXCEPTION;
        }
        JS_FreeValue(ctx, exc);
    } else {
        JS_FreeValue(ctx, dom_exc_ctor);
    }

    /* Fallback: throw regular Error */
    if (func_name[0] == 'b')
        return JS_ThrowRangeError(ctx, "Invalid character in btoa input");
    else
        return JS_ThrowRangeError(ctx, "Invalid character in atob input");
}

/* ---- btoa(data) ---- */

static JSValue js_btoa(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_NewString(ctx, "");

    /* Get the string. btoa treats the string as a Latin-1 byte sequence:
       each code point must be in range U+0000..U+00FF */
    size_t str_len;
    const char *str = JS_ToCStringLen(ctx, &str_len, argv[0]);
    if (!str) return JS_EXCEPTION;

    /* JS_ToCStringLen returns UTF-8. We need to decode UTF-8 back to code points
       and verify each is <= 0xFF. Also, collect the raw byte values. */
    uint8_t *bytes = js_malloc(ctx, str_len + 1); /* worst case: all ASCII */
    if (!bytes) {
        JS_FreeCString(ctx, str);
        return JS_EXCEPTION;
    }

    size_t byte_count = 0;
    size_t i = 0;
    while (i < str_len) {
        uint8_t b = (uint8_t)str[i];
        uint32_t cp;

        if (b < 0x80) {
            cp = b;
            i++;
        } else if ((b & 0xE0) == 0xC0) {
            if (i + 1 >= str_len) { cp = 0x100; i++; } /* invalid */
            else {
                cp = ((b & 0x1F) << 6) | ((uint8_t)str[i+1] & 0x3F);
                i += 2;
            }
        } else if ((b & 0xF0) == 0xE0) {
            if (i + 2 >= str_len) { cp = 0x100; i++; }
            else {
                cp = ((b & 0x0F) << 12) | (((uint8_t)str[i+1] & 0x3F) << 6)
                     | ((uint8_t)str[i+2] & 0x3F);
                i += 3;
            }
        } else if ((b & 0xF8) == 0xF0) {
            /* Any 4-byte sequence is > U+00FF */
            cp = 0x100;
            i += 4;
        } else {
            cp = 0x100;
            i++;
        }

        if (cp > 0xFF) {
            js_free(ctx, bytes);
            JS_FreeCString(ctx, str);
            return throw_invalid_character(ctx, "btoa");
        }

        bytes[byte_count++] = (uint8_t)cp;
    }
    JS_FreeCString(ctx, str);

    /* Base64 encode */
    size_t out_len = ((byte_count + 2) / 3) * 4;
    char *out = js_malloc(ctx, out_len + 1);
    if (!out) {
        js_free(ctx, bytes);
        return JS_EXCEPTION;
    }

    size_t j = 0;
    for (i = 0; i < byte_count; i += 3) {
        uint32_t n = (uint32_t)bytes[i] << 16;
        if (i + 1 < byte_count) n |= (uint32_t)bytes[i + 1] << 8;
        if (i + 2 < byte_count) n |= (uint32_t)bytes[i + 2];

        out[j++] = b64_encode_table[(n >> 18) & 0x3F];
        out[j++] = b64_encode_table[(n >> 12) & 0x3F];
        out[j++] = (i + 1 < byte_count) ? b64_encode_table[(n >> 6) & 0x3F] : '=';
        out[j++] = (i + 2 < byte_count) ? b64_encode_table[n & 0x3F] : '=';
    }

    JSValue result = JS_NewStringLen(ctx, out, out_len);
    js_free(ctx, out);
    js_free(ctx, bytes);
    return result;
}

/* ---- atob(data) ---- */

static JSValue js_atob(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    if (argc < 1)
        return throw_invalid_character(ctx, "atob");

    size_t str_len;
    const char *str = JS_ToCStringLen(ctx, &str_len, argv[0]);
    if (!str) return JS_EXCEPTION;

    /* Step 1: Remove ASCII whitespace and collect valid characters */
    uint8_t *cleaned = js_malloc(ctx, str_len + 1);
    if (!cleaned) {
        JS_FreeCString(ctx, str);
        return JS_EXCEPTION;
    }

    size_t cleaned_len = 0;
    for (size_t i = 0; i < str_len; i++) {
        int v = b64_decode_value((uint8_t)str[i]);
        if (v == -2) continue; /* whitespace — skip */
        if (v == -3) {
            cleaned[cleaned_len++] = '=';
        } else if (v >= 0) {
            cleaned[cleaned_len++] = (uint8_t)str[i];
        } else {
            /* Invalid character */
            js_free(ctx, cleaned);
            JS_FreeCString(ctx, str);
            return throw_invalid_character(ctx, "atob");
        }
    }
    JS_FreeCString(ctx, str);

    /* Step 2: If length divisible by 4, remove trailing = (at most 2) */
    size_t data_len = cleaned_len;
    if (data_len > 0 && data_len % 4 == 0) {
        if (cleaned[data_len - 1] == '=') data_len--;
        if (data_len > 0 && cleaned[data_len - 1] == '=') data_len--;
    }

    /* Step 3: If length % 4 == 1, failure */
    if (data_len % 4 == 1) {
        js_free(ctx, cleaned);
        return throw_invalid_character(ctx, "atob");
    }

    /* Step 4: Check remaining chars are all valid base64 (no = allowed now) */
    for (size_t i = 0; i < data_len; i++) {
        if (cleaned[i] == '=' || b64_decode_value(cleaned[i]) < 0) {
            js_free(ctx, cleaned);
            return throw_invalid_character(ctx, "atob");
        }
    }

    /* Steps 5-9: Decode */
    size_t out_max = (data_len * 3) / 4 + 4;
    uint8_t *output = js_malloc(ctx, out_max);
    if (!output) {
        js_free(ctx, cleaned);
        return JS_EXCEPTION;
    }

    size_t out_len = 0;
    uint32_t buffer = 0;
    int bits = 0;

    for (size_t i = 0; i < data_len; i++) {
        int v = b64_decode_value(cleaned[i]);
        buffer = (buffer << 6) | (uint32_t)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            output[out_len++] = (uint8_t)(buffer >> bits);
            buffer &= (1u << bits) - 1;
        }
    }
    /* Discard remaining bits (4 or 2 bits of padding) */

    js_free(ctx, cleaned);

    /* The output is a byte string (Latin-1): each byte becomes a code point U+0000..U+00FF.
       Build a JS string where each char is the byte value. */
    /* Use JS_NewStringLen which expects UTF-8. We need to encode bytes > 0x7F as 2-byte UTF-8. */
    size_t utf8_len = 0;
    for (size_t i = 0; i < out_len; i++) {
        utf8_len += output[i] < 0x80 ? 1 : 2;
    }

    char *utf8 = js_malloc(ctx, utf8_len + 1);
    if (!utf8) {
        js_free(ctx, output);
        return JS_EXCEPTION;
    }

    size_t k = 0;
    for (size_t i = 0; i < out_len; i++) {
        uint8_t c = output[i];
        if (c < 0x80) {
            utf8[k++] = (char)c;
        } else {
            utf8[k++] = (char)(0xC0 | (c >> 6));
            utf8[k++] = (char)(0x80 | (c & 0x3F));
        }
    }

    js_free(ctx, output);

    JSValue result = JS_NewStringLen(ctx, utf8, utf8_len);
    js_free(ctx, utf8);
    return result;
}

/* ---- Extension entry point ---- */

__attribute__((visibility("default")))
int qjs_ext_base64_init(JSContext *ctx, JSRuntime *rt) {
    JSValue global = JS_GetGlobalObject(ctx);

    JS_SetPropertyStr(ctx, global, "btoa",
        JS_NewCFunction(ctx, js_btoa, "btoa", 1));
    JS_SetPropertyStr(ctx, global, "atob",
        JS_NewCFunction(ctx, js_atob, "atob", 1));

    JS_FreeValue(ctx, global);
    return 0;
}
