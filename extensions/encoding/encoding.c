/*
 * QuickJS Extension: TextEncoder and TextDecoder
 *
 * A WHATWG Encoding Standard compliant implementation of the TextEncoder and
 * TextDecoder Web APIs. Compiled as a WASM shared library (.so) that links
 * against the QuickJS C API exported by the main quickjs.wasm module.
 *
 * Supported encodings:
 *   - UTF-8 (default, and the only encoding TextEncoder supports)
 *   - UTF-16LE
 *   - UTF-16BE
 *
 * Unsupported encoding labels cause the TextDecoder constructor to throw
 * a RangeError, per the spec.
 *
 * References:
 *   - https://encoding.spec.whatwg.org/
 *   - https://developer.mozilla.org/en-US/docs/Web/API/TextEncoder
 *   - https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder
 *
 * NOTE: All string conversions use JS_ToCStringLen() / JS_ToCStringLenUTF16()
 * to correctly handle JavaScript strings containing embedded null bytes.
 */

#include "quickjs.h"
#include <stdlib.h>
#include <string.h>

/* ---- Encoding enum ---- */

typedef enum {
    ENCODING_UTF8 = 0,
    ENCODING_UTF16LE = 1,
    ENCODING_UTF16BE = 2,
} EncodingType;

/* ---- Label lookup ---- */

/* Per the WHATWG Encoding spec, label matching is ASCII case-insensitive
   with leading/trailing ASCII whitespace stripped. */

static int is_ascii_ws(char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\f' || c == '\r';
}

static char ascii_lower(char c) {
    if (c >= 'A' && c <= 'Z') return c + ('a' - 'A');
    return c;
}

/* Compare a trimmed, lowercased input against a static label.
   Returns 1 if match, 0 otherwise. */
static int label_match(const char *input, size_t input_len, const char *label) {
    /* Strip leading ASCII whitespace */
    while (input_len > 0 && is_ascii_ws(input[0])) {
        input++;
        input_len--;
    }
    /* Strip trailing ASCII whitespace */
    while (input_len > 0 && is_ascii_ws(input[input_len - 1])) {
        input_len--;
    }

    size_t label_len = strlen(label);
    if (input_len != label_len) return 0;

    for (size_t i = 0; i < input_len; i++) {
        if (ascii_lower(input[i]) != label[i]) return 0;
    }
    return 1;
}

/* Try to match label to a supported encoding. Returns -1 on failure. */
static int get_encoding(const char *label, size_t label_len) {
    /* UTF-8 labels per spec */
    static const char *utf8_labels[] = {
        "unicode-1-1-utf-8",
        "unicode11utf8",
        "unicode20utf8",
        "utf-8",
        "utf8",
        "x-unicode20utf8",
        NULL
    };

    /* UTF-16LE labels per spec */
    static const char *utf16le_labels[] = {
        "csunicode",
        "iso-10646-ucs-2",
        "ucs-2",
        "unicode",
        "unicodefeff",
        "utf-16",
        "utf-16le",
        NULL
    };

    /* UTF-16BE labels per spec */
    static const char *utf16be_labels[] = {
        "unicodefffe",
        "utf-16be",
        NULL
    };

    for (const char **p = utf8_labels; *p; p++) {
        if (label_match(label, label_len, *p)) return ENCODING_UTF8;
    }
    for (const char **p = utf16le_labels; *p; p++) {
        if (label_match(label, label_len, *p)) return ENCODING_UTF16LE;
    }
    for (const char **p = utf16be_labels; *p; p++) {
        if (label_match(label, label_len, *p)) return ENCODING_UTF16BE;
    }

    return -1; /* failure */
}

/* Check if a label matches the "replacement" encoding.
   Per spec, these labels must cause a RangeError. */
static int is_replacement_encoding(const char *label, size_t label_len) {
    static const char *replacement_labels[] = {
        "csiso2022kr",
        "hz-gb-2312",
        "iso-2022-cn",
        "iso-2022-cn-ext",
        "iso-2022-kr",
        "replacement",
        NULL
    };
    for (const char **p = replacement_labels; *p; p++) {
        if (label_match(label, label_len, *p)) return 1;
    }
    return 0;
}

/* ---- Encoding names ---- */

static const char *encoding_name(EncodingType enc) {
    switch (enc) {
    case ENCODING_UTF8:    return "utf-8";
    case ENCODING_UTF16LE: return "utf-16le";
    case ENCODING_UTF16BE: return "utf-16be";
    }
    return "utf-8";
}

/* ======================================================================
 *  UTF-8 Encoder (for TextEncoder.encode / encodeInto)
 *
 *  Takes UTF-16 code units (from JS_ToCStringLenUTF16) and produces
 *  well-formed UTF-8. Lone surrogates are replaced with U+FFFD per the
 *  USVString conversion required by the spec.
 * ====================================================================== */

/* Encode a single code point to UTF-8, return number of bytes written. */
static int utf8_encode_cp(uint8_t *buf, uint32_t cp) {
    if (cp < 0x80) {
        buf[0] = (uint8_t)cp;
        return 1;
    } else if (cp < 0x800) {
        buf[0] = (uint8_t)(0xC0 | (cp >> 6));
        buf[1] = (uint8_t)(0x80 | (cp & 0x3F));
        return 2;
    } else if (cp < 0x10000) {
        buf[0] = (uint8_t)(0xE0 | (cp >> 12));
        buf[1] = (uint8_t)(0x80 | ((cp >> 6) & 0x3F));
        buf[2] = (uint8_t)(0x80 | (cp & 0x3F));
        return 3;
    } else {
        buf[0] = (uint8_t)(0xF0 | (cp >> 18));
        buf[1] = (uint8_t)(0x80 | ((cp >> 12) & 0x3F));
        buf[2] = (uint8_t)(0x80 | ((cp >> 6) & 0x3F));
        buf[3] = (uint8_t)(0x80 | (cp & 0x3F));
        return 4;
    }
}

/* Return the number of UTF-8 bytes needed for a code point. */
static int utf8_cp_len(uint32_t cp) {
    if (cp < 0x80)    return 1;
    if (cp < 0x800)   return 2;
    if (cp < 0x10000) return 3;
    return 4;
}

#define is_hi_surr(c)  ((c) >= 0xD800 && (c) <= 0xDBFF)
#define is_lo_surr(c)  ((c) >= 0xDC00 && (c) <= 0xDFFF)
#define surr_to_cp(hi, lo) (0x10000 + (((uint32_t)(hi) - 0xD800) << 10) + ((uint32_t)(lo) - 0xDC00))

/* ======================================================================
 *  UTF-8 Decoder (for TextDecoder.decode with utf-8)
 *
 *  Implements the exact WHATWG spec algorithm with:
 *  - utf8_code_point, utf8_bytes_seen, utf8_bytes_needed
 *  - utf8_lower_boundary, utf8_upper_boundary
 *  - "Best Practices for Using U+FFFD" error recovery
 * ====================================================================== */

typedef struct {
    uint32_t code_point;
    uint8_t bytes_seen;
    uint8_t bytes_needed;
    uint8_t lower_boundary;
    uint8_t upper_boundary;
} UTF8DecoderState;

static void utf8_decoder_reset(UTF8DecoderState *st) {
    st->code_point = 0;
    st->bytes_seen = 0;
    st->bytes_needed = 0;
    st->lower_boundary = 0x80;
    st->upper_boundary = 0xBF;
}

/* Handler result codes */
#define HANDLER_FINISHED  (-1)
#define HANDLER_CONTINUE  (-2)
#define HANDLER_ERROR     (-3)

/* UTF-8 handler: processes one byte, returns a code point value (>=0),
   or HANDLER_FINISHED, HANDLER_CONTINUE, or HANDLER_ERROR.
   When HANDLER_ERROR is returned, *restore_byte is set to 1 if the byte
   should be restored to the input queue (re-processed). */
static int32_t utf8_handler(UTF8DecoderState *st, int byte_or_eof,
                             int *restore_byte) {
    *restore_byte = 0;

    /* Step 1: end-of-queue with pending bytes = error */
    if (byte_or_eof < 0) {
        if (st->bytes_needed != 0) {
            st->bytes_needed = 0;
            return HANDLER_ERROR;
        }
        return HANDLER_FINISHED;
    }

    uint8_t byte = (uint8_t)byte_or_eof;

    /* Step 3: bytes_needed == 0 -> start of a new sequence */
    if (st->bytes_needed == 0) {
        if (byte <= 0x7F) {
            return (int32_t)byte;
        } else if (byte >= 0xC2 && byte <= 0xDF) {
            st->bytes_needed = 1;
            st->code_point = byte & 0x1F;
        } else if (byte >= 0xE0 && byte <= 0xEF) {
            if (byte == 0xE0) st->lower_boundary = 0xA0;
            if (byte == 0xED) st->upper_boundary = 0x9F;
            st->bytes_needed = 2;
            st->code_point = byte & 0x0F;
        } else if (byte >= 0xF0 && byte <= 0xF4) {
            if (byte == 0xF0) st->lower_boundary = 0x90;
            if (byte == 0xF4) st->upper_boundary = 0x8F;
            st->bytes_needed = 3;
            st->code_point = byte & 0x07;
        } else {
            return HANDLER_ERROR;
        }
        return HANDLER_CONTINUE;
    }

    /* Step 4: byte out of range -> error + restore */
    if (byte < st->lower_boundary || byte > st->upper_boundary) {
        st->code_point = 0;
        st->bytes_needed = 0;
        st->bytes_seen = 0;
        st->lower_boundary = 0x80;
        st->upper_boundary = 0xBF;
        *restore_byte = 1;
        return HANDLER_ERROR;
    }

    /* Step 5: reset boundaries */
    st->lower_boundary = 0x80;
    st->upper_boundary = 0xBF;

    /* Step 6: accumulate bits */
    st->code_point = (st->code_point << 6) | (byte & 0x3F);

    /* Step 7: increment bytes_seen */
    st->bytes_seen++;

    /* Step 8: not done yet? */
    if (st->bytes_seen != st->bytes_needed) {
        return HANDLER_CONTINUE;
    }

    /* Step 9-11: complete! */
    uint32_t cp = st->code_point;
    st->code_point = 0;
    st->bytes_needed = 0;
    st->bytes_seen = 0;
    return (int32_t)cp;
}

/* ======================================================================
 *  UTF-16 Decoder (for TextDecoder.decode with utf-16le / utf-16be)
 *
 *  Per the WHATWG spec "shared UTF-16 decoder" algorithm.
 * ====================================================================== */

typedef struct {
    int lead_byte;       /* -1 if no pending byte, otherwise 0..255 */
    int lead_surrogate;  /* -1 if no pending surrogate, otherwise 0xD800..0xDBFF */
    int be;              /* 1 for big-endian, 0 for little-endian */
} UTF16DecoderState;

static void utf16_decoder_reset(UTF16DecoderState *st, int big_endian) {
    st->lead_byte = -1;
    st->lead_surrogate = -1;
    st->be = big_endian;
}

/* UTF-16 handler: processes one byte at a time.
   Returns a code point (>=0), HANDLER_FINISHED, HANDLER_CONTINUE, or HANDLER_ERROR. */
static int32_t utf16_handler(UTF16DecoderState *st, int byte_or_eof) {
    /* End-of-queue */
    if (byte_or_eof < 0) {
        if (st->lead_byte != -1 || st->lead_surrogate != -1) {
            st->lead_byte = -1;
            st->lead_surrogate = -1;
            return HANDLER_ERROR;
        }
        return HANDLER_FINISHED;
    }

    uint8_t byte = (uint8_t)byte_or_eof;

    /* If we have a pending lead_byte, combine to form a code unit */
    if (st->lead_byte == -1) {
        st->lead_byte = byte;
        return HANDLER_CONTINUE;
    }

    uint16_t code_unit;
    if (st->be) {
        code_unit = ((uint16_t)st->lead_byte << 8) | byte;
    } else {
        code_unit = ((uint16_t)byte << 8) | (uint16_t)st->lead_byte;
    }
    st->lead_byte = -1;

    /* If we have a pending lead surrogate */
    if (st->lead_surrogate != -1) {
        uint16_t lead = (uint16_t)st->lead_surrogate;
        st->lead_surrogate = -1;
        if (is_lo_surr(code_unit)) {
            return (int32_t)surr_to_cp(lead, code_unit);
        }
        /* Not a trail surrogate — error for the lead surrogate.
           But we need to re-process this code_unit. We handle this
           by checking if it's a lead surrogate itself or a regular code unit. */
        if (is_hi_surr(code_unit)) {
            st->lead_surrogate = code_unit;
            /* Return error for the previous unmatched lead surrogate */
            return HANDLER_ERROR;
        }
        /* The current code_unit is a BMP code point. We emit error for
           the unmatched lead, but we also need to emit the current code_unit.
           Since we can only return one thing at a time, we store the result
           and use a special approach: return the error, and the caller
           will need to re-process. However, the spec's "process an item"
           pushes error and continues, so we just mark error and the next
           call will handle this code_unit. But we've already consumed the
           byte pair... We need a different approach.

           The spec's UTF-16 decoder processes 2 bytes at a time forming
           code units, not single bytes. Let me restructure to buffer the
           code unit for re-processing. */

        /* Actually, for simplicity, we'll store the code_unit as needing
           to be re-examined. We'll use a small queue approach. For now,
           let's emit an error. The code_unit is lost, which is a bug.
           Let me handle this properly with a pending_code_unit field. */

        /* FIXME: this is handled below in the decode function by
           using a different approach. For now, signal error. */
        return HANDLER_ERROR;
    }

    if (is_hi_surr(code_unit)) {
        st->lead_surrogate = code_unit;
        return HANDLER_CONTINUE;
    }

    if (is_lo_surr(code_unit)) {
        return HANDLER_ERROR;
    }

    return (int32_t)code_unit;
}

/* ======================================================================
 *  TextDecoder opaque data
 * ====================================================================== */

typedef struct {
    EncodingType encoding;
    int fatal;
    int ignore_bom;
    int bom_seen;
    int do_not_flush;

    /* Decoder state (depends on encoding) */
    union {
        UTF8DecoderState utf8;
        UTF16DecoderState utf16;
    } state;
} TextDecoderData;

static void decoder_init_state(TextDecoderData *d) {
    d->bom_seen = 0;
    d->do_not_flush = 0;
    switch (d->encoding) {
    case ENCODING_UTF8:
        utf8_decoder_reset(&d->state.utf8);
        break;
    case ENCODING_UTF16LE:
        utf16_decoder_reset(&d->state.utf16, 0);
        break;
    case ENCODING_UTF16BE:
        utf16_decoder_reset(&d->state.utf16, 1);
        break;
    }
}

/* ======================================================================
 *  TextEncoder class
 * ====================================================================== */

static JSClassID js_text_encoder_class_id;

static JSClassDef js_text_encoder_class = {
    "TextEncoder",
};

static JSValue js_text_encoder_constructor(JSContext *ctx, JSValueConst new_target,
                                            int argc, JSValueConst *argv)
{
    /* Per spec: constructor takes no meaningful arguments (legacy label arg is ignored) */
    JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
    if (JS_IsException(proto))
        return JS_EXCEPTION;

    JSValue obj = JS_NewObjectProtoClass(ctx, proto, js_text_encoder_class_id);
    JS_FreeValue(ctx, proto);
    return obj;
}

static JSValue js_text_encoder_get_encoding(JSContext *ctx, JSValueConst this_val) {
    return JS_NewString(ctx, "utf-8");
}

/* TextEncoder.encode(input)
 *
 * Takes a JS string, converts to UTF-8 with USVString semantics
 * (lone surrogates → U+FFFD), returns a Uint8Array.
 */
static JSValue js_text_encoder_encode(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv)
{
    /* Get the input string. Default is empty string. */
    JSValue input_val;
    if (argc < 1 || JS_IsUndefined(argv[0])) {
        /* Return empty Uint8Array */
        return JS_NewUint8ArrayCopy(ctx, NULL, 0);
    }

    /* Get UTF-16 representation for precise surrogate handling */
    size_t utf16_len;
    const uint16_t *utf16 = JS_ToCStringLenUTF16(ctx, &utf16_len, argv[0]);
    if (!utf16) return JS_EXCEPTION;

    /* First pass: compute output size */
    size_t out_size = 0;
    size_t i = 0;
    while (i < utf16_len) {
        uint16_t c = utf16[i++];
        uint32_t cp;
        if (is_hi_surr(c) && i < utf16_len && is_lo_surr(utf16[i])) {
            cp = surr_to_cp(c, utf16[i]);
            i++;
        } else if (is_hi_surr(c) || is_lo_surr(c)) {
            cp = 0xFFFD; /* lone surrogate → U+FFFD */
        } else {
            cp = c;
        }
        out_size += utf8_cp_len(cp);
    }

    /* Allocate output buffer */
    uint8_t *buf = js_malloc(ctx, out_size > 0 ? out_size : 1);
    if (!buf) {
        JS_FreeCStringUTF16(ctx, utf16);
        return JS_EXCEPTION;
    }

    /* Second pass: encode */
    uint8_t *p = buf;
    i = 0;
    while (i < utf16_len) {
        uint16_t c = utf16[i++];
        uint32_t cp;
        if (is_hi_surr(c) && i < utf16_len && is_lo_surr(utf16[i])) {
            cp = surr_to_cp(c, utf16[i]);
            i++;
        } else if (is_hi_surr(c) || is_lo_surr(c)) {
            cp = 0xFFFD;
        } else {
            cp = c;
        }
        p += utf8_encode_cp(p, cp);
    }

    JS_FreeCStringUTF16(ctx, utf16);

    /* Create Uint8Array from buffer */
    JSValue result = JS_NewUint8ArrayCopy(ctx, buf, out_size);
    js_free(ctx, buf);
    return result;
}

/* TextEncoder.encodeInto(source, destination)
 *
 * Encodes into an existing Uint8Array. Returns { read, written }.
 * 'read' counts UTF-16 code units consumed (surrogate pairs count as 2).
 */
static JSValue js_text_encoder_encodeInto(JSContext *ctx, JSValueConst this_val,
                                           int argc, JSValueConst *argv)
{
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "encodeInto requires 2 arguments");

    /* Validate destination is a Uint8Array */
    int ta_type = JS_GetTypedArrayType(argv[1]);
    if (ta_type != JS_TYPED_ARRAY_UINT8) {
        return JS_ThrowTypeError(ctx, "encodeInto destination must be a Uint8Array");
    }

    /* Get destination buffer */
    size_t dest_byte_offset, dest_byte_length, dest_bpe;
    JSValue dest_ab = JS_GetTypedArrayBuffer(ctx, argv[1],
                                              &dest_byte_offset,
                                              &dest_byte_length,
                                              &dest_bpe);
    if (JS_IsException(dest_ab))
        return JS_EXCEPTION;

    size_t ab_size;
    uint8_t *ab_data = JS_GetArrayBuffer(ctx, &ab_size, dest_ab);
    JS_FreeValue(ctx, dest_ab);

    /* Handle detached buffer: ab_data is NULL but byte_length might be 0 */
    uint8_t *dest = ab_data ? (ab_data + dest_byte_offset) : NULL;
    size_t dest_len = dest_byte_length;

    /* Get source as UTF-16 */
    size_t utf16_len;
    const uint16_t *utf16 = JS_ToCStringLenUTF16(ctx, &utf16_len, argv[0]);
    if (!utf16) return JS_EXCEPTION;

    size_t read_units = 0;   /* UTF-16 code units consumed */
    size_t written = 0;      /* bytes written to destination */

    size_t i = 0;
    while (i < utf16_len) {
        uint16_t c = utf16[i];
        uint32_t cp;
        int units_for_this; /* how many UTF-16 code units this consumes */

        if (is_hi_surr(c) && (i + 1) < utf16_len && is_lo_surr(utf16[i + 1])) {
            cp = surr_to_cp(c, utf16[i + 1]);
            units_for_this = 2;
        } else if (is_hi_surr(c) || is_lo_surr(c)) {
            cp = 0xFFFD;
            units_for_this = 1;
        } else {
            cp = c;
            units_for_this = 1;
        }

        int needed = utf8_cp_len(cp);
        if (dest_len - written < (size_t)needed) {
            break; /* not enough space */
        }

        if (dest) {
            written += utf8_encode_cp(dest + written, cp);
        } else {
            written += needed;
        }
        i += units_for_this;
        read_units += units_for_this;
    }

    JS_FreeCStringUTF16(ctx, utf16);

    /* Return { read, written } */
    JSValue result = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, result, "read", JS_NewInt64(ctx, (int64_t)read_units));
    JS_SetPropertyStr(ctx, result, "written", JS_NewInt64(ctx, (int64_t)written));
    return result;
}

static const JSCFunctionListEntry js_text_encoder_proto_funcs[] = {
    JS_CGETSET_DEF("encoding", js_text_encoder_get_encoding, NULL),
    JS_CFUNC_DEF("encode", 0, js_text_encoder_encode),
    JS_CFUNC_DEF("encodeInto", 2, js_text_encoder_encodeInto),
};

/* ======================================================================
 *  TextDecoder class
 * ====================================================================== */

static JSClassID js_text_decoder_class_id;

static void js_text_decoder_finalizer(JSRuntime *rt, JSValue val) {
    TextDecoderData *d = (TextDecoderData *)JS_GetOpaque(val, js_text_decoder_class_id);
    if (d) {
        js_free_rt(rt, d);
    }
}

static JSClassDef js_text_decoder_class = {
    "TextDecoder",
    .finalizer = js_text_decoder_finalizer,
};

static JSValue js_text_decoder_constructor(JSContext *ctx, JSValueConst new_target,
                                            int argc, JSValueConst *argv)
{
    /* Parse label (default "utf-8") */
    EncodingType enc = ENCODING_UTF8;

    if (argc >= 1 && !JS_IsUndefined(argv[0])) {
        size_t label_len;
        const char *label = JS_ToCStringLen(ctx, &label_len, argv[0]);
        if (!label) return JS_EXCEPTION;

        int enc_result = get_encoding(label, label_len);
        if (enc_result < 0) {
            /* Check if it's a known but unsupported encoding, or replacement */
            if (is_replacement_encoding(label, label_len)) {
                JSValue err = JS_ThrowRangeError(ctx, "The encoding label provided ('%s') is not supported.", label);
                JS_FreeCString(ctx, label);
                return err;
            }
            JS_FreeCString(ctx, label);
            return JS_ThrowRangeError(ctx, "The encoding label provided is not supported.");
        }
        JS_FreeCString(ctx, label);
        enc = (EncodingType)enc_result;
    }

    /* Parse options */
    int fatal = 0;
    int ignore_bom = 0;

    if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        JSValue fatal_val = JS_GetPropertyStr(ctx, argv[1], "fatal");
        if (JS_IsException(fatal_val)) return JS_EXCEPTION;
        fatal = JS_ToBool(ctx, fatal_val);
        JS_FreeValue(ctx, fatal_val);

        JSValue ignore_bom_val = JS_GetPropertyStr(ctx, argv[1], "ignoreBOM");
        if (JS_IsException(ignore_bom_val)) return JS_EXCEPTION;
        ignore_bom = JS_ToBool(ctx, ignore_bom_val);
        JS_FreeValue(ctx, ignore_bom_val);
    }

    /* Allocate opaque data */
    TextDecoderData *d = js_mallocz(ctx, sizeof(TextDecoderData));
    if (!d) return JS_EXCEPTION;

    d->encoding = enc;
    d->fatal = fatal;
    d->ignore_bom = ignore_bom;
    decoder_init_state(d);

    /* Create object */
    JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
    if (JS_IsException(proto)) {
        js_free(ctx, d);
        return JS_EXCEPTION;
    }

    JSValue obj = JS_NewObjectProtoClass(ctx, proto, js_text_decoder_class_id);
    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj)) {
        js_free(ctx, d);
        return JS_EXCEPTION;
    }

    JS_SetOpaque(obj, d);
    return obj;
}

/* ---- TextDecoder property getters ---- */

static JSValue js_text_decoder_get_encoding(JSContext *ctx, JSValueConst this_val) {
    TextDecoderData *d = (TextDecoderData *)JS_GetOpaque(this_val, js_text_decoder_class_id);
    if (!d) return JS_EXCEPTION;
    return JS_NewString(ctx, encoding_name(d->encoding));
}

static JSValue js_text_decoder_get_fatal(JSContext *ctx, JSValueConst this_val) {
    TextDecoderData *d = (TextDecoderData *)JS_GetOpaque(this_val, js_text_decoder_class_id);
    if (!d) return JS_EXCEPTION;
    return JS_NewBool(ctx, d->fatal);
}

static JSValue js_text_decoder_get_ignoreBOM(JSContext *ctx, JSValueConst this_val) {
    TextDecoderData *d = (TextDecoderData *)JS_GetOpaque(this_val, js_text_decoder_class_id);
    if (!d) return JS_EXCEPTION;
    return JS_NewBool(ctx, d->ignore_bom);
}

/* ---- UTF-8 decode helper ---- */

/* Decode UTF-8 input bytes to a JS string using the spec's algorithm.
   Handles error mode (replacement vs fatal) and BOM stripping.
   If streaming, the decoder state is preserved across calls.
   Returns JS_EXCEPTION on fatal error. */
static JSValue decode_utf8(JSContext *ctx, TextDecoderData *d,
                            const uint8_t *input, size_t input_len,
                            int stream)
{
    UTF8DecoderState *st = &d->state.utf8;

    /* Allocate output buffer for scalar values (worst case: each byte → one code point).
       Each code point can be up to 4 bytes in the output JS string (UTF-8 encoded).
       We'll build a UTF-8 string directly. */
    size_t max_out = (input_len + 4) * 3 + 16; /* generous upper bound */
    uint8_t *out = js_malloc(ctx, max_out);
    if (!out) return JS_EXCEPTION;
    size_t out_len = 0;

    size_t pos = 0;
    while (1) {
        int byte_or_eof;
        if (pos < input_len) {
            byte_or_eof = input[pos++];
        } else if (!stream) {
            byte_or_eof = -1; /* end-of-queue */
        } else {
            break; /* streaming: don't signal end-of-queue */
        }

        int restore_byte = 0;
        int32_t result = utf8_handler(st, byte_or_eof, &restore_byte);

        if (result == HANDLER_FINISHED) {
            break;
        } else if (result == HANDLER_CONTINUE) {
            continue;
        } else if (result == HANDLER_ERROR) {
            if (d->fatal) {
                js_free(ctx, out);
                return JS_ThrowTypeError(ctx, "The encoded data was not valid.");
            }
            /* Replacement mode: emit U+FFFD */
            uint32_t replacement = 0xFFFD;
            /* BOM filtering for U+FFFD: it's not U+FEFF, so no filtering needed */
            if (!d->bom_seen && !d->ignore_bom &&
                (d->encoding == ENCODING_UTF8)) {
                d->bom_seen = 1;
                /* U+FFFD is not BOM, so we emit it */
            }
            out_len += utf8_encode_cp(out + out_len, replacement);

            if (restore_byte) {
                pos--; /* re-process the byte */
            }
        } else {
            /* result is a code point */
            uint32_t cp = (uint32_t)result;

            /* BOM handling: per "serialize I/O queue" in the spec */
            if (!d->bom_seen && !d->ignore_bom &&
                d->encoding == ENCODING_UTF8) {
                d->bom_seen = 1;
                if (cp == 0xFEFF) {
                    continue; /* strip BOM */
                }
            }

            out_len += utf8_encode_cp(out + out_len, cp);
        }
    }

    JSValue str = JS_NewStringLen(ctx, (const char *)out, out_len);
    js_free(ctx, out);
    return str;
}

/* ---- UTF-16 decode helper ---- */

/* Decode UTF-16 input bytes to a JS string.
   The spec's "shared UTF-16 decoder" processes bytes one at a time,
   pairing them into code units, then handling surrogate pairs.
   For simplicity and correctness, we process the bytes directly. */
static JSValue decode_utf16(JSContext *ctx, TextDecoderData *d,
                             const uint8_t *input, size_t input_len,
                             int stream)
{
    /* For UTF-16: worst case output is input_len code points,
       each up to 3 bytes UTF-8. Plus some for pending state. */
    size_t max_out = (input_len + 4) * 3 + 16;
    uint8_t *out = js_malloc(ctx, max_out);
    if (!out) return JS_EXCEPTION;
    size_t out_len = 0;

    UTF16DecoderState *st = &d->state.utf16;

    /* We process bytes forming code units, then handle surrogates.
       To handle the edge case where an unmatched lead surrogate is
       followed by a non-surrogate code unit, we need to be able to
       "re-process" a code unit. We use a small pending queue. */

    /* Collect code units from the byte stream */
    size_t pos = 0;
    int have_pending_cu = 0;
    uint16_t pending_cu = 0;

    while (1) {
        uint16_t code_unit;
        int have_cu = 0;

        if (have_pending_cu) {
            code_unit = pending_cu;
            have_cu = 1;
            have_pending_cu = 0;
        } else {
            /* Read two bytes to form a code unit */
            if (st->lead_byte != -1) {
                /* We have a pending byte from a previous call */
                if (pos < input_len) {
                    uint8_t b1 = (uint8_t)st->lead_byte;
                    uint8_t b2 = input[pos++];
                    if (st->be) {
                        code_unit = ((uint16_t)b1 << 8) | b2;
                    } else {
                        code_unit = ((uint16_t)b2 << 8) | b1;
                    }
                    st->lead_byte = -1;
                    have_cu = 1;
                } else {
                    /* No more input bytes; leave lead_byte pending */
                    break;
                }
            } else if (pos + 1 < input_len) {
                uint8_t b1 = input[pos];
                uint8_t b2 = input[pos + 1];
                pos += 2;
                if (st->be) {
                    code_unit = ((uint16_t)b1 << 8) | b2;
                } else {
                    code_unit = ((uint16_t)b2 << 8) | b1;
                }
                have_cu = 1;
            } else if (pos < input_len) {
                /* One byte left — save as lead_byte */
                st->lead_byte = input[pos++];
                break;
            } else {
                /* No more input */
                break;
            }
        }

        if (!have_cu) break;

        /* Handle surrogates */
        if (st->lead_surrogate != -1) {
            uint16_t lead = (uint16_t)st->lead_surrogate;
            if (is_lo_surr(code_unit)) {
                st->lead_surrogate = -1;
                uint32_t cp = surr_to_cp(lead, code_unit);

                /* BOM filtering */
                if (!d->bom_seen && !d->ignore_bom) {
                    d->bom_seen = 1;
                    if (cp == 0xFEFF) continue;
                }

                out_len += utf8_encode_cp(out + out_len, cp);
                continue;
            }
            /* Unmatched lead surrogate */
            st->lead_surrogate = -1;
            if (d->fatal) {
                js_free(ctx, out);
                return JS_ThrowTypeError(ctx, "The encoded data was not valid.");
            }
            /* Emit U+FFFD for the unmatched lead */
            if (!d->bom_seen && !d->ignore_bom) {
                d->bom_seen = 1;
                /* U+FFFD is not BOM */
            }
            out_len += utf8_encode_cp(out + out_len, 0xFFFD);
            /* Re-process current code_unit */
            have_pending_cu = 1;
            pending_cu = code_unit;
            continue;
        }

        if (is_hi_surr(code_unit)) {
            st->lead_surrogate = code_unit;
            continue;
        }

        if (is_lo_surr(code_unit)) {
            if (d->fatal) {
                js_free(ctx, out);
                return JS_ThrowTypeError(ctx, "The encoded data was not valid.");
            }
            if (!d->bom_seen && !d->ignore_bom) {
                d->bom_seen = 1;
            }
            out_len += utf8_encode_cp(out + out_len, 0xFFFD);
            continue;
        }

        /* Regular BMP code point */
        if (!d->bom_seen && !d->ignore_bom) {
            d->bom_seen = 1;
            if (code_unit == 0xFEFF) continue; /* strip BOM */
        }
        out_len += utf8_encode_cp(out + out_len, code_unit);
    }

    /* If not streaming, flush pending state */
    if (!stream) {
        if (st->lead_surrogate != -1) {
            if (d->fatal) {
                js_free(ctx, out);
                return JS_ThrowTypeError(ctx, "The encoded data was not valid.");
            }
            out_len += utf8_encode_cp(out + out_len, 0xFFFD);
            st->lead_surrogate = -1;
        }
        if (st->lead_byte != -1) {
            if (d->fatal) {
                js_free(ctx, out);
                return JS_ThrowTypeError(ctx, "The encoded data was not valid.");
            }
            out_len += utf8_encode_cp(out + out_len, 0xFFFD);
            st->lead_byte = -1;
        }
    }

    JSValue str = JS_NewStringLen(ctx, (const char *)out, out_len);
    js_free(ctx, out);
    return str;
}

/* ---- TextDecoder.decode() ---- */

static JSValue js_text_decoder_decode(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv)
{
    TextDecoderData *d = (TextDecoderData *)JS_GetOpaque(this_val, js_text_decoder_class_id);
    if (!d) return JS_EXCEPTION;

    /* Step 1: If do_not_flush is false, reset decoder state */
    if (!d->do_not_flush) {
        decoder_init_state(d);
    }

    /* Step 2: Parse options.stream */
    int stream = 0;
    if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        JSValue stream_val = JS_GetPropertyStr(ctx, argv[1], "stream");
        if (JS_IsException(stream_val)) return JS_EXCEPTION;
        stream = JS_ToBool(ctx, stream_val);
        JS_FreeValue(ctx, stream_val);
    }
    d->do_not_flush = stream;

    /* Step 3: Get input bytes */
    const uint8_t *input = NULL;
    size_t input_len = 0;

    if (argc >= 1 && !JS_IsUndefined(argv[0]) && !JS_IsNull(argv[0])) {
        /* Accept ArrayBuffer, TypedArray, or DataView */
        if (JS_IsArrayBuffer(argv[0])) {
            input = JS_GetArrayBuffer(ctx, &input_len, argv[0]);
        } else {
            /* Try TypedArray first */
            size_t byte_offset, byte_length, bpe;
            JSValue ab = JS_GetTypedArrayBuffer(ctx, argv[0],
                                                 &byte_offset, &byte_length, &bpe);
            if (JS_IsException(ab)) {
                /* Clear the exception and try DataView */
                JSValue exc = JS_GetException(ctx);
                JS_FreeValue(ctx, exc); /* consume the pending exception */

                if (JS_IsDataView(argv[0])) {
                    /* Get buffer, byteOffset, byteLength from the DataView */
                    JSValue buf_val = JS_GetPropertyStr(ctx, argv[0], "buffer");
                    JSValue off_val = JS_GetPropertyStr(ctx, argv[0], "byteOffset");
                    JSValue len_val = JS_GetPropertyStr(ctx, argv[0], "byteLength");

                    if (JS_IsException(buf_val) || JS_IsException(off_val) || JS_IsException(len_val)) {
                        JS_FreeValue(ctx, buf_val);
                        JS_FreeValue(ctx, off_val);
                        JS_FreeValue(ctx, len_val);
                        return JS_EXCEPTION;
                    }

                    size_t ab_size;
                    uint8_t *ab_data = JS_GetArrayBuffer(ctx, &ab_size, buf_val);
                    JS_FreeValue(ctx, buf_val);

                    uint32_t dv_offset = 0, dv_length = 0;
                    JS_ToUint32(ctx, &dv_offset, off_val);
                    JS_ToUint32(ctx, &dv_length, len_val);
                    JS_FreeValue(ctx, off_val);
                    JS_FreeValue(ctx, len_val);

                    if (ab_data) {
                        input = ab_data + dv_offset;
                        input_len = dv_length;
                    } else {
                        input = NULL;
                        input_len = 0;
                    }
                } else {
                    return JS_ThrowTypeError(ctx, "The provided value is not of type '(ArrayBuffer or ArrayBufferView)'");
                }
            } else {
                size_t ab_size;
                uint8_t *ab_data = JS_GetArrayBuffer(ctx, &ab_size, ab);
                JS_FreeValue(ctx, ab);
                if (ab_data) {
                    input = ab_data + byte_offset;
                    input_len = byte_length;
                } else {
                    input = NULL;
                    input_len = 0;
                }
            }
        }
    }

    /* Step 4-5: Decode */
    switch (d->encoding) {
    case ENCODING_UTF8:
        return decode_utf8(ctx, d, input ? input : (const uint8_t *)"", input_len, stream);
    case ENCODING_UTF16LE:
    case ENCODING_UTF16BE:
        return decode_utf16(ctx, d, input ? input : (const uint8_t *)"", input_len, stream);
    }

    return JS_NewString(ctx, "");
}

static const JSCFunctionListEntry js_text_decoder_proto_funcs[] = {
    JS_CGETSET_DEF("encoding", js_text_decoder_get_encoding, NULL),
    JS_CGETSET_DEF("fatal", js_text_decoder_get_fatal, NULL),
    JS_CGETSET_DEF("ignoreBOM", js_text_decoder_get_ignoreBOM, NULL),
    JS_CFUNC_DEF("decode", 0, js_text_decoder_decode),
};

/* ======================================================================
 *  Extension entry point
 * ====================================================================== */

#define countof(x) (sizeof(x) / sizeof((x)[0]))

__attribute__((visibility("default")))
int qjs_ext_encoding_init(JSContext *ctx, JSRuntime *rt) {
    JSValue global = JS_GetGlobalObject(ctx);

    /* ---- TextEncoder ---- */
    JS_NewClassID(rt, &js_text_encoder_class_id);
    JS_NewClass(rt, js_text_encoder_class_id, &js_text_encoder_class);

    JSValue te_ctor = JS_NewCFunction2(ctx, js_text_encoder_constructor,
                                        "TextEncoder", 0,
                                        JS_CFUNC_constructor, 0);

    JSValue te_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, te_proto, js_text_encoder_proto_funcs,
                               countof(js_text_encoder_proto_funcs));
    JS_DefinePropertyValueStr(ctx, te_proto, "constructor", JS_DupValue(ctx, te_ctor),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    JS_SetClassProto(ctx, js_text_encoder_class_id, te_proto);

    JSValue te_proto_ref = JS_GetClassProto(ctx, js_text_encoder_class_id);
    JS_DefinePropertyValueStr(ctx, te_ctor, "prototype", te_proto_ref, 0);

    JS_DefinePropertyValueStr(ctx, global, "TextEncoder", te_ctor,
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);

    /* ---- TextDecoder ---- */
    JS_NewClassID(rt, &js_text_decoder_class_id);
    JS_NewClass(rt, js_text_decoder_class_id, &js_text_decoder_class);

    JSValue td_ctor = JS_NewCFunction2(ctx, js_text_decoder_constructor,
                                        "TextDecoder", 0,
                                        JS_CFUNC_constructor, 0);

    JSValue td_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, td_proto, js_text_decoder_proto_funcs,
                               countof(js_text_decoder_proto_funcs));
    JS_DefinePropertyValueStr(ctx, td_proto, "constructor", JS_DupValue(ctx, td_ctor),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    JS_SetClassProto(ctx, js_text_decoder_class_id, td_proto);

    JSValue td_proto_ref = JS_GetClassProto(ctx, js_text_decoder_class_id);
    JS_DefinePropertyValueStr(ctx, td_ctor, "prototype", td_proto_ref, 0);

    JS_DefinePropertyValueStr(ctx, global, "TextDecoder", td_ctor,
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);

    JS_FreeValue(ctx, global);
    return 0;
}
