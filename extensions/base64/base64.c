/*
 * QuickJS Extension: atob / btoa + Uint8Array base64/hex methods
 *
 * WHATWG HTML Standard compliant implementation of the Base64 utility methods,
 * plus TC39 proposal-arraybuffer-base64 Uint8Array methods:
 *   - Uint8Array.prototype.toBase64([options])
 *   - Uint8Array.prototype.toHex()
 *   - Uint8Array.fromBase64(string [, options])
 *   - Uint8Array.fromHex(string)
 *   - Uint8Array.prototype.setFromBase64(string [, options])
 *   - Uint8Array.prototype.setFromHex(string)
 *
 * References:
 *   - https://html.spec.whatwg.org/multipage/webappapis.html#atob
 *   - https://infra.spec.whatwg.org/#forgiving-base64
 *   - https://tc39.es/proposal-arraybuffer-base64/spec/
 *
 * NOTE: atob/btoa throw DOMException("InvalidCharacterError") per spec.
 * If DOMException is not available (extension not loaded), we throw a
 * regular Error with the same message as a reasonable fallback.
 */

#include "quickjs.h"
#include <string.h>

/* ---- Base64 alphabets ---- */

static const char b64_encode_table[64] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static const char b64url_encode_table[64] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

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

/* Decode for base64url: same but - maps to 62, _ maps to 63, + and / are invalid */
static int b64url_decode_value(uint8_t c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '-') return 62;
    if (c == '_') return 63;
    if (c == 0x09 || c == 0x0A || c == 0x0C || c == 0x0D || c == 0x20) return -2;
    if (c == '=') return -3;
    return -1;
}

/* Hex decode: returns 0-15 or -1 for invalid */
static int hex_decode_value(uint8_t c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static const char hex_encode_table[16] = "0123456789abcdef";

/* ---- Helper: is ASCII whitespace ---- */

static int is_ascii_whitespace(uint8_t c) {
    return c == 0x09 || c == 0x0A || c == 0x0C || c == 0x0D || c == 0x20;
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

/* ---- Helper: validate Uint8Array and get bytes ---- */

/* Validates that `val` is a Uint8Array (not detached/OOB) and returns
   a pointer to its data + length. Returns 0 on success, -1 on failure
   (with exception thrown). */
static int validate_uint8array(JSContext *ctx, JSValueConst val,
                                uint8_t **data_out, size_t *len_out) {
    int ta_type = JS_GetTypedArrayType(val);
    if (ta_type != JS_TYPED_ARRAY_UINT8) {
        JS_ThrowTypeError(ctx, "this is not a Uint8Array");
        return -1;
    }

    size_t byte_offset, byte_length, bpe;
    JSValue ab = JS_GetTypedArrayBuffer(ctx, val, &byte_offset, &byte_length, &bpe);
    if (JS_IsException(ab))
        return -1;

    size_t ab_size;
    uint8_t *ab_data = JS_GetArrayBuffer(ctx, &ab_size, ab);
    JS_FreeValue(ctx, ab);

    if (!ab_data && byte_length > 0) {
        JS_ThrowTypeError(ctx, "ArrayBuffer is detached");
        return -1;
    }

    *data_out = ab_data ? (ab_data + byte_offset) : NULL;
    *len_out = byte_length;
    return 0;
}

/* ---- Helper: parse base64 options (alphabet, lastChunkHandling, omitPadding) ---- */

typedef enum {
    ALPHABET_BASE64 = 0,
    ALPHABET_BASE64URL = 1,
} AlphabetType;

typedef enum {
    LAST_CHUNK_LOOSE = 0,
    LAST_CHUNK_STRICT = 1,
    LAST_CHUNK_STOP_BEFORE_PARTIAL = 2,
} LastChunkHandling;

static int parse_base64_options(JSContext *ctx, int argc, JSValueConst *argv,
                                 int opts_index,
                                 AlphabetType *alphabet_out,
                                 LastChunkHandling *last_chunk_out,
                                 int *omit_padding_out) {
    *alphabet_out = ALPHABET_BASE64;
    if (last_chunk_out) *last_chunk_out = LAST_CHUNK_LOOSE;
    if (omit_padding_out) *omit_padding_out = 0;

    if (opts_index >= argc) return 0;
    JSValue opts = argv[opts_index];
    if (JS_IsUndefined(opts)) return 0;

    if (!JS_IsObject(opts)) {
        JS_ThrowTypeError(ctx, "options must be an object");
        return -1;
    }

    /* alphabet */
    JSValue alpha_val = JS_GetPropertyStr(ctx, opts, "alphabet");
    if (JS_IsException(alpha_val)) return -1;
    if (!JS_IsUndefined(alpha_val)) {
        const char *alpha_str = JS_ToCString(ctx, alpha_val);
        JS_FreeValue(ctx, alpha_val);
        if (!alpha_str) return -1;
        if (strcmp(alpha_str, "base64") == 0) {
            *alphabet_out = ALPHABET_BASE64;
        } else if (strcmp(alpha_str, "base64url") == 0) {
            *alphabet_out = ALPHABET_BASE64URL;
        } else {
            JS_ThrowTypeError(ctx, "expected alphabet to be either \"base64\" or \"base64url\"");
            JS_FreeCString(ctx, alpha_str);
            return -1;
        }
        JS_FreeCString(ctx, alpha_str);
    } else {
        JS_FreeValue(ctx, alpha_val);
    }

    /* lastChunkHandling */
    if (last_chunk_out) {
        JSValue lch_val = JS_GetPropertyStr(ctx, opts, "lastChunkHandling");
        if (JS_IsException(lch_val)) return -1;
        if (!JS_IsUndefined(lch_val)) {
            const char *lch_str = JS_ToCString(ctx, lch_val);
            JS_FreeValue(ctx, lch_val);
            if (!lch_str) return -1;
            if (strcmp(lch_str, "loose") == 0) {
                *last_chunk_out = LAST_CHUNK_LOOSE;
            } else if (strcmp(lch_str, "strict") == 0) {
                *last_chunk_out = LAST_CHUNK_STRICT;
            } else if (strcmp(lch_str, "stop-before-partial") == 0) {
                *last_chunk_out = LAST_CHUNK_STOP_BEFORE_PARTIAL;
            } else {
                JS_ThrowTypeError(ctx, "expected lastChunkHandling to be either \"loose\", \"strict\", or \"stop-before-partial\"");
                JS_FreeCString(ctx, lch_str);
                return -1;
            }
            JS_FreeCString(ctx, lch_str);
        } else {
            JS_FreeValue(ctx, lch_val);
        }
    }

    /* omitPadding */
    if (omit_padding_out) {
        JSValue op_val = JS_GetPropertyStr(ctx, opts, "omitPadding");
        if (JS_IsException(op_val)) return -1;
        if (!JS_IsUndefined(op_val)) {
            *omit_padding_out = JS_ToBool(ctx, op_val);
        }
        JS_FreeValue(ctx, op_val);
    }

    return 0;
}

/* ---- Core: FromBase64 algorithm (spec 10.3) ----
 * Decodes a base64 string into bytes with the given options.
 * If max_length is provided (>= 0), limits output to that many bytes.
 * On success, returns 0 and writes results.
 * On error, returns -1. If the error should be thrown after writing partial
 * results (for setFromBase64), error_out is set to a JSValue exception.
 * The caller owns bytes_out and must free it. */
typedef struct {
    uint8_t *bytes;
    size_t bytes_len;
    size_t read;       /* number of input characters consumed (for "read" field) */
    JSValue error;     /* JS_UNDEFINED if no error, else a SyntaxError */
} FromBase64Result;

static void from_base64(JSContext *ctx, const char *str, size_t str_len,
                         AlphabetType alphabet, LastChunkHandling last_chunk,
                         size_t max_length, FromBase64Result *result) {
    /* Allocate output buffer (worst case: 3 bytes per 4 input chars) */
    size_t out_cap = (str_len / 4 + 1) * 3 + 4;
    if (max_length < (size_t)-1 - 4 && out_cap > max_length + 4)
        out_cap = max_length + 4;
    uint8_t *bytes = js_malloc(ctx, out_cap > 0 ? out_cap : 1);
    if (!bytes) {
        result->bytes = NULL;
        result->bytes_len = 0;
        result->read = 0;
        result->error = JS_EXCEPTION;
        return;
    }

    size_t bytes_len = 0;
    size_t read = 0;
    uint8_t chunk[4];
    int chunk_len = 0;
    size_t index = 0;

    result->error = JS_UNDEFINED;

    while (1) {
        /* Skip whitespace */
        while (index < str_len && is_ascii_whitespace((uint8_t)str[index]))
            index++;

        if (index == str_len) {
            /* End of input */
            if (chunk_len > 0) {
                if (last_chunk == LAST_CHUNK_STOP_BEFORE_PARTIAL) {
                    /* Return what we have without processing the partial chunk */
                    goto done;
                } else if (last_chunk == LAST_CHUNK_LOOSE) {
                    if (chunk_len == 1) {
                        result->error = JS_ThrowSyntaxError(ctx, "Invalid base64 string");
                        goto done;
                    }
                    /* Decode partial chunk (loose: no throw on extra bits) */
                    /* Pad chunk to 4 with 'A' (= 0) */
                    uint32_t n = 0;
                    for (int i = 0; i < chunk_len; i++)
                        n = (n << 6) | b64_decode_value(chunk[i]);
                    for (int i = chunk_len; i < 4; i++)
                        n <<= 6;

                    if (chunk_len >= 2 && bytes_len < max_length)
                        bytes[bytes_len++] = (uint8_t)(n >> 16);
                    if (chunk_len >= 3 && bytes_len < max_length)
                        bytes[bytes_len++] = (uint8_t)(n >> 8);
                } else {
                    /* strict: partial chunk is an error */
                    result->error = JS_ThrowSyntaxError(ctx, "Invalid base64 string");
                    goto done;
                }
            }
            read = str_len;
            goto done;
        }

        uint8_t c = (uint8_t)str[index];
        index++;

        if (c == '=') {
            /* Padding character */
            if (chunk_len < 2) {
                result->error = JS_ThrowSyntaxError(ctx, "Invalid base64 string");
                goto done;
            }

            /* Skip whitespace after first '=' */
            while (index < str_len && is_ascii_whitespace((uint8_t)str[index]))
                index++;

            if (chunk_len == 2) {
                /* Need a second '=' */
                if (index == str_len) {
                    if (last_chunk == LAST_CHUNK_STOP_BEFORE_PARTIAL) {
                        goto done;
                    }
                    result->error = JS_ThrowSyntaxError(ctx, "Invalid base64 string");
                    goto done;
                }
                if ((uint8_t)str[index] == '=') {
                    index++;
                    /* Skip whitespace after second '=' */
                    while (index < str_len && is_ascii_whitespace((uint8_t)str[index]))
                        index++;
                }
            }

            /* After padding, must be at end of string */
            if (index < str_len) {
                result->error = JS_ThrowSyntaxError(ctx, "Invalid base64 string");
                goto done;
            }

            /* Decode the chunk with extra bits check */
            int throw_on_extra = (last_chunk == LAST_CHUNK_STRICT);
            uint32_t n = 0;
            for (int i = 0; i < chunk_len; i++)
                n = (n << 6) | b64_decode_value(chunk[i]);
            for (int i = chunk_len; i < 4; i++)
                n <<= 6;

            if (chunk_len == 2) {
                if (throw_on_extra && ((n >> 16) & 0xFF) == (n >> 16) && (n & 0x00FFFF) != 0) {
                    result->error = JS_ThrowSyntaxError(ctx, "Invalid base64 string");
                    goto done;
                }
                /* Check overflow bits: the bottom 4 bits of the 12-bit value must be 0 */
                if (throw_on_extra) {
                    uint32_t val12 = ((uint32_t)b64_decode_value(chunk[0]) << 6)
                                   | (uint32_t)b64_decode_value(chunk[1]);
                    if (val12 & 0xF) {
                        result->error = JS_ThrowSyntaxError(ctx, "Invalid base64 string");
                        goto done;
                    }
                }
                if (bytes_len < max_length)
                    bytes[bytes_len++] = (uint8_t)(n >> 16);
            } else if (chunk_len == 3) {
                if (throw_on_extra) {
                    uint32_t val18 = ((uint32_t)b64_decode_value(chunk[0]) << 12)
                                   | ((uint32_t)b64_decode_value(chunk[1]) << 6)
                                   | (uint32_t)b64_decode_value(chunk[2]);
                    if (val18 & 0x3) {
                        result->error = JS_ThrowSyntaxError(ctx, "Invalid base64 string");
                        goto done;
                    }
                }
                if (bytes_len < max_length)
                    bytes[bytes_len++] = (uint8_t)(n >> 16);
                if (bytes_len < max_length)
                    bytes[bytes_len++] = (uint8_t)(n >> 8);
            }

            read = str_len;
            goto done;
        }

        /* Regular character - validate for the alphabet */
        int val;
        if (alphabet == ALPHABET_BASE64URL) {
            if (c == '+' || c == '/') {
                result->error = JS_ThrowSyntaxError(ctx, "Invalid character in base64url string");
                goto done;
            }
            val = b64url_decode_value(c);
        } else {
            val = b64_decode_value(c);
        }

        if (val < 0) {
            result->error = JS_ThrowSyntaxError(ctx, "Invalid character in base64 string");
            goto done;
        }

        /* Check if adding this char would exceed maxLength on decode */
        size_t remaining = max_length - bytes_len;
        if ((remaining == 1 && chunk_len == 2) ||
            (remaining == 2 && chunk_len == 3)) {
            /* Would produce more bytes than we can store */
            /* Back up: don't consume this character */
            goto done;
        }

        /* Use the standard alphabet value for decoding */
        chunk[chunk_len++] = (uint8_t)c;

        if (chunk_len == 4) {
            /* Decode a full 4-character chunk */
            int v0, v1, v2, v3;
            if (alphabet == ALPHABET_BASE64URL) {
                v0 = b64url_decode_value(chunk[0]);
                v1 = b64url_decode_value(chunk[1]);
                v2 = b64url_decode_value(chunk[2]);
                v3 = b64url_decode_value(chunk[3]);
            } else {
                v0 = b64_decode_value(chunk[0]);
                v1 = b64_decode_value(chunk[1]);
                v2 = b64_decode_value(chunk[2]);
                v3 = b64_decode_value(chunk[3]);
            }
            uint32_t n = ((uint32_t)v0 << 18) | ((uint32_t)v1 << 12)
                       | ((uint32_t)v2 << 6) | (uint32_t)v3;
            bytes[bytes_len++] = (uint8_t)(n >> 16);
            bytes[bytes_len++] = (uint8_t)(n >> 8);
            bytes[bytes_len++] = (uint8_t)(n);
            chunk_len = 0;
            read = index;

            if (bytes_len >= max_length) {
                goto done;
            }
        }
    }

done:
    result->bytes = bytes;
    result->bytes_len = bytes_len;
    result->read = read;
}

/* ---- Core: FromHex algorithm (spec 10.4) ---- */

typedef struct {
    uint8_t *bytes;
    size_t bytes_len;
    size_t read;
    JSValue error;
} FromHexResult;

static void from_hex(JSContext *ctx, const char *str, size_t str_len,
                      size_t max_length, FromHexResult *result) {
    result->error = JS_UNDEFINED;

    if (str_len % 2 != 0) {
        result->bytes = NULL;
        result->bytes_len = 0;
        result->read = 0;
        result->error = JS_ThrowSyntaxError(ctx, "Invalid hex string length");
        return;
    }

    size_t out_cap = str_len / 2;
    if (out_cap > max_length) out_cap = max_length;
    uint8_t *bytes = js_malloc(ctx, out_cap > 0 ? out_cap : 1);
    if (!bytes) {
        result->bytes = NULL;
        result->bytes_len = 0;
        result->read = 0;
        result->error = JS_EXCEPTION;
        return;
    }

    size_t bytes_len = 0;
    size_t read = 0;

    while (read < str_len && bytes_len < max_length) {
        int hi = hex_decode_value((uint8_t)str[read]);
        int lo = hex_decode_value((uint8_t)str[read + 1]);
        if (hi < 0 || lo < 0) {
            result->bytes = bytes;
            result->bytes_len = bytes_len;
            result->read = read;
            result->error = JS_ThrowSyntaxError(ctx, "Invalid character in hex string");
            return;
        }
        bytes[bytes_len++] = (uint8_t)((hi << 4) | lo);
        read += 2;
    }

    result->bytes = bytes;
    result->bytes_len = bytes_len;
    result->read = read;
}

/* ==================================================================
 *  btoa(data) - WHATWG HTML Standard
 * ================================================================== */

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

/* ==================================================================
 *  atob(data) - WHATWG HTML Standard
 * ================================================================== */

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

/* ==================================================================
 *  Uint8Array.prototype.toBase64([options])
 * ================================================================== */

static JSValue js_uint8array_toBase64(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv)
{
    uint8_t *data;
    size_t len;
    if (validate_uint8array(ctx, this_val, &data, &len) < 0)
        return JS_EXCEPTION;

    AlphabetType alphabet;
    int omit_padding;
    if (parse_base64_options(ctx, argc, argv, 0, &alphabet, NULL, &omit_padding) < 0)
        return JS_EXCEPTION;

    const char *table = (alphabet == ALPHABET_BASE64URL)
        ? b64url_encode_table : b64_encode_table;

    /* Compute output length */
    size_t full_groups = len / 3;
    size_t remainder = len % 3;
    size_t out_len;
    if (omit_padding) {
        out_len = full_groups * 4;
        if (remainder == 1) out_len += 2;
        else if (remainder == 2) out_len += 3;
    } else {
        out_len = ((len + 2) / 3) * 4;
    }

    char *out = js_malloc(ctx, out_len + 1);
    if (!out) return JS_EXCEPTION;

    size_t j = 0;
    size_t i;
    for (i = 0; i + 2 < len; i += 3) {
        uint32_t n = ((uint32_t)data[i] << 16)
                   | ((uint32_t)data[i + 1] << 8)
                   | (uint32_t)data[i + 2];
        out[j++] = table[(n >> 18) & 0x3F];
        out[j++] = table[(n >> 12) & 0x3F];
        out[j++] = table[(n >> 6) & 0x3F];
        out[j++] = table[n & 0x3F];
    }

    if (remainder == 1) {
        uint32_t n = (uint32_t)data[i] << 16;
        out[j++] = table[(n >> 18) & 0x3F];
        out[j++] = table[(n >> 12) & 0x3F];
        if (!omit_padding) {
            out[j++] = '=';
            out[j++] = '=';
        }
    } else if (remainder == 2) {
        uint32_t n = ((uint32_t)data[i] << 16) | ((uint32_t)data[i + 1] << 8);
        out[j++] = table[(n >> 18) & 0x3F];
        out[j++] = table[(n >> 12) & 0x3F];
        out[j++] = table[(n >> 6) & 0x3F];
        if (!omit_padding) {
            out[j++] = '=';
        }
    }

    JSValue result = JS_NewStringLen(ctx, out, j);
    js_free(ctx, out);
    return result;
}

/* ==================================================================
 *  Uint8Array.prototype.toHex()
 * ================================================================== */

static JSValue js_uint8array_toHex(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    uint8_t *data;
    size_t len;
    if (validate_uint8array(ctx, this_val, &data, &len) < 0)
        return JS_EXCEPTION;

    size_t out_len = len * 2;
    char *out = js_malloc(ctx, out_len + 1);
    if (!out) return JS_EXCEPTION;

    for (size_t i = 0; i < len; i++) {
        out[i * 2]     = hex_encode_table[(data[i] >> 4) & 0x0F];
        out[i * 2 + 1] = hex_encode_table[data[i] & 0x0F];
    }

    JSValue result = JS_NewStringLen(ctx, out, out_len);
    js_free(ctx, out);
    return result;
}

/* ==================================================================
 *  Uint8Array.fromBase64(string [, options])
 * ================================================================== */

static JSValue js_uint8array_fromBase64(JSContext *ctx, JSValueConst this_val,
                                         int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "Uint8Array.fromBase64 requires a string argument");

    size_t str_len;
    const char *str = JS_ToCStringLen(ctx, &str_len, argv[0]);
    if (!str) return JS_EXCEPTION;

    AlphabetType alphabet;
    LastChunkHandling last_chunk;
    if (parse_base64_options(ctx, argc, argv, 1, &alphabet, &last_chunk, NULL) < 0) {
        JS_FreeCString(ctx, str);
        return JS_EXCEPTION;
    }

    FromBase64Result res;
    from_base64(ctx, str, str_len, alphabet, last_chunk, (size_t)-1, &res);
    JS_FreeCString(ctx, str);

    if (JS_IsException(res.error)) {
        if (res.bytes) js_free(ctx, res.bytes);
        return JS_EXCEPTION;
    }

    if (!JS_IsUndefined(res.error)) {
        /* Error after partial decode -- for fromBase64, just throw it */
        if (res.bytes) js_free(ctx, res.bytes);
        return JS_EXCEPTION; /* error already thrown */
    }

    JSValue result = JS_NewUint8ArrayCopy(ctx, res.bytes, res.bytes_len);
    js_free(ctx, res.bytes);
    return result;
}

/* ==================================================================
 *  Uint8Array.fromHex(string)
 * ================================================================== */

static JSValue js_uint8array_fromHex(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "Uint8Array.fromHex requires a string argument");

    size_t str_len;
    const char *str = JS_ToCStringLen(ctx, &str_len, argv[0]);
    if (!str) return JS_EXCEPTION;

    FromHexResult res;
    from_hex(ctx, str, str_len, (size_t)-1, &res);
    JS_FreeCString(ctx, str);

    if (JS_IsException(res.error)) {
        if (res.bytes) js_free(ctx, res.bytes);
        return JS_EXCEPTION;
    }

    if (!JS_IsUndefined(res.error)) {
        if (res.bytes) js_free(ctx, res.bytes);
        return JS_EXCEPTION;
    }

    JSValue result = JS_NewUint8ArrayCopy(ctx, res.bytes, res.bytes_len);
    js_free(ctx, res.bytes);
    return result;
}

/* ==================================================================
 *  Uint8Array.prototype.setFromBase64(string [, options])
 * ================================================================== */

static JSValue js_uint8array_setFromBase64(JSContext *ctx, JSValueConst this_val,
                                            int argc, JSValueConst *argv)
{
    uint8_t *data;
    size_t data_len;
    if (validate_uint8array(ctx, this_val, &data, &data_len) < 0)
        return JS_EXCEPTION;

    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "setFromBase64 requires a string argument");

    size_t str_len;
    const char *str = JS_ToCStringLen(ctx, &str_len, argv[0]);
    if (!str) return JS_EXCEPTION;

    AlphabetType alphabet;
    LastChunkHandling last_chunk;
    if (parse_base64_options(ctx, argc, argv, 1, &alphabet, &last_chunk, NULL) < 0) {
        JS_FreeCString(ctx, str);
        return JS_EXCEPTION;
    }

    FromBase64Result res;
    from_base64(ctx, str, str_len, alphabet, last_chunk, data_len, &res);
    JS_FreeCString(ctx, str);

    if (JS_IsException(res.error)) {
        if (res.bytes) js_free(ctx, res.bytes);
        return JS_EXCEPTION;
    }

    /* Copy decoded bytes into the Uint8Array */
    size_t written = res.bytes_len;
    if (written > data_len) written = data_len;
    if (data && written > 0)
        memcpy(data, res.bytes, written);

    size_t read = res.read;
    int has_error = !JS_IsUndefined(res.error);
    JSValue error = res.error;

    js_free(ctx, res.bytes);

    /* Throw error after writing (per spec for setFromBase64) */
    if (has_error) {
        /* error is already thrown on the context */
        return JS_EXCEPTION;
    }

    JSValue result = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, result, "read", JS_NewInt64(ctx, (int64_t)read));
    JS_SetPropertyStr(ctx, result, "written", JS_NewInt64(ctx, (int64_t)written));
    return result;
}

/* ==================================================================
 *  Uint8Array.prototype.setFromHex(string)
 * ================================================================== */

static JSValue js_uint8array_setFromHex(JSContext *ctx, JSValueConst this_val,
                                         int argc, JSValueConst *argv)
{
    uint8_t *data;
    size_t data_len;
    if (validate_uint8array(ctx, this_val, &data, &data_len) < 0)
        return JS_EXCEPTION;

    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "setFromHex requires a string argument");

    size_t str_len;
    const char *str = JS_ToCStringLen(ctx, &str_len, argv[0]);
    if (!str) return JS_EXCEPTION;

    FromHexResult res;
    from_hex(ctx, str, str_len, data_len, &res);
    JS_FreeCString(ctx, str);

    if (JS_IsException(res.error)) {
        if (res.bytes) js_free(ctx, res.bytes);
        return JS_EXCEPTION;
    }

    /* Copy decoded bytes into the Uint8Array */
    size_t written = res.bytes_len;
    if (written > data_len) written = data_len;
    if (data && written > 0)
        memcpy(data, res.bytes, written);

    size_t read = res.read;
    int has_error = !JS_IsUndefined(res.error);

    js_free(ctx, res.bytes);

    /* Throw error after writing (per spec for setFromHex) */
    if (has_error) {
        return JS_EXCEPTION;
    }

    JSValue result = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, result, "read", JS_NewInt64(ctx, (int64_t)read));
    JS_SetPropertyStr(ctx, result, "written", JS_NewInt64(ctx, (int64_t)written));
    return result;
}

/* ---- Extension entry point ---- */

__attribute__((visibility("default")))
int qjs_ext_base64_init(JSContext *ctx, JSRuntime *rt) {
    JSValue global = JS_GetGlobalObject(ctx);

    /* ---- atob / btoa globals ---- */
    JS_SetPropertyStr(ctx, global, "btoa",
        JS_NewCFunction(ctx, js_btoa, "btoa", 1));
    JS_SetPropertyStr(ctx, global, "atob",
        JS_NewCFunction(ctx, js_atob, "atob", 1));

    /* ---- Uint8Array.prototype methods ---- */
    JSValue uint8array_ctor = JS_GetPropertyStr(ctx, global, "Uint8Array");
    JSValue uint8array_proto = JS_GetPropertyStr(ctx, uint8array_ctor, "prototype");

    /* toBase64([options]) */
    JS_SetPropertyStr(ctx, uint8array_proto, "toBase64",
        JS_NewCFunction(ctx, js_uint8array_toBase64, "toBase64", 0));

    /* toHex() */
    JS_SetPropertyStr(ctx, uint8array_proto, "toHex",
        JS_NewCFunction(ctx, js_uint8array_toHex, "toHex", 0));

    /* setFromBase64(string [, options]) */
    JS_SetPropertyStr(ctx, uint8array_proto, "setFromBase64",
        JS_NewCFunction(ctx, js_uint8array_setFromBase64, "setFromBase64", 1));

    /* setFromHex(string) */
    JS_SetPropertyStr(ctx, uint8array_proto, "setFromHex",
        JS_NewCFunction(ctx, js_uint8array_setFromHex, "setFromHex", 1));

    JS_FreeValue(ctx, uint8array_proto);

    /* ---- Uint8Array static methods ---- */

    /* fromBase64(string [, options]) */
    JS_SetPropertyStr(ctx, uint8array_ctor, "fromBase64",
        JS_NewCFunction(ctx, js_uint8array_fromBase64, "fromBase64", 1));

    /* fromHex(string) */
    JS_SetPropertyStr(ctx, uint8array_ctor, "fromHex",
        JS_NewCFunction(ctx, js_uint8array_fromHex, "fromHex", 1));

    JS_FreeValue(ctx, uint8array_ctor);
    JS_FreeValue(ctx, global);
    return 0;
}
