/*
 * QuickJS Extension: Web Crypto API
 *
 * W3C Web Cryptography API implementation backed by mbedTLS 4.0 PSA Crypto.
 *
 * Implements:
 *   - crypto.getRandomValues(typedArray)
 *   - crypto.randomUUID()
 *   - crypto.subtle.digest(algorithm, data)
 *   - crypto.subtle.generateKey(algorithm, extractable, keyUsages)
 *   - crypto.subtle.importKey(format, keyData, algorithm, extractable, keyUsages)
 *   - crypto.subtle.exportKey(format, key)
 *   - crypto.subtle.sign(algorithm, key, data)
 *   - crypto.subtle.verify(algorithm, key, signature, data)
 *   - crypto.subtle.encrypt(algorithm, key, data)
 *   - crypto.subtle.decrypt(algorithm, key, data)
 *   - crypto.subtle.deriveBits(algorithm, baseKey, length)
 *   - crypto.subtle.deriveKey(algorithm, baseKey, derivedKeyType, extractable, keyUsages)
 *   - crypto.subtle.wrapKey(format, key, wrappingKey, wrapAlgorithm)
 *   - crypto.subtle.unwrapKey(format, wrappedKey, unwrappingKey, unwrapAlgorithm,
 *                             unwrappedKeyAlgorithm, extractable, keyUsages)
 *   - CryptoKey (type, extractable, algorithm, usages)
 *
 * References:
 *   - https://w3c.github.io/webcrypto/#crypto-interface
 *   - https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API
 */

#include "quickjs.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

#include "psa/crypto.h"

/* ================================================================
 * WASI random_get — used as the external RNG for mbedTLS PSA
 * ================================================================ */

/* WASI random_get syscall */
extern int __wasi_random_get(void *buf, size_t buf_len)
    __attribute__((__import_module__("wasi_snapshot_preview1"),
                   __import_name__("random_get")));

/* mbedTLS external RNG callback — called by PSA internals */
psa_status_t mbedtls_psa_external_get_random(
    mbedtls_psa_external_random_context_t *context,
    uint8_t *output, size_t output_size, size_t *output_length)
{
    (void)context;
    int rc = __wasi_random_get(output, output_size);
    if (rc != 0) return PSA_ERROR_HARDWARE_FAILURE;
    *output_length = output_size;
    return PSA_SUCCESS;
}

/* ================================================================
 * Forward declarations and class IDs
 * ================================================================ */

static JSClassID js_cryptokey_class_id;
static JSClassID js_subtle_class_id;
static JSClassID js_crypto_class_id;

#define countof(x) (sizeof(x) / sizeof((x)[0]))

/* ================================================================
 * Algorithm identifier constants
 * ================================================================ */

enum {
    ALG_SHA1 = 1,
    ALG_SHA256,
    ALG_SHA384,
    ALG_SHA512,
    ALG_HMAC,
    ALG_AES_CBC,
    ALG_AES_CTR,
    ALG_AES_GCM,
    ALG_AES_KW,
    ALG_RSA_OAEP,
    ALG_RSASSA_PKCS1_V1_5,
    ALG_RSA_PSS,
    ALG_ECDSA,
    ALG_ECDH,
    ALG_ED25519,
    ALG_X25519,
    ALG_HKDF,
    ALG_PBKDF2,
};

/* ================================================================
 * CryptoKey opaque data
 * ================================================================ */

typedef struct {
    psa_key_id_t key_id;        /* PSA key handle */
    int algorithm;              /* Our ALG_* enum */
    char *alg_name;             /* Algorithm name string (e.g. "AES-GCM") */
    int extractable;
    JSValue usages_array;       /* Frozen JS array of usage strings */
    uint32_t psa_usage_flags;   /* PSA usage flags */
    psa_algorithm_t psa_alg;    /* PSA algorithm used for this key */
    psa_key_type_t key_type;    /* PSA key type */
    size_t key_bits;            /* Key size in bits */
    /* For RSA/EC: hash algorithm used */
    int hash_alg;               /* ALG_SHA* for RSA/EC algorithms */
    /* For EC: named curve */
    char *named_curve;          /* "P-256", "P-384", "P-521" */
    /* For HMAC: hash + length */
    size_t hmac_length;
} CryptoKeyData;

/* ================================================================
 * Helper: case-insensitive string compare
 * ================================================================ */

static int str_eq_nocase(const char *a, const char *b) {
    while (*a && *b) {
        char ca = *a, cb = *b;
        if (ca >= 'A' && ca <= 'Z') ca += 32;
        if (cb >= 'A' && cb <= 'Z') cb += 32;
        if (ca != cb) return 0;
        a++; b++;
    }
    return *a == *b;
}

/* ================================================================
 * Helper: resolve hash algorithm name -> ALG_* and PSA algorithm
 * ================================================================ */

static int resolve_hash_alg(const char *name) {
    if (str_eq_nocase(name, "SHA-1"))   return ALG_SHA1;
    if (str_eq_nocase(name, "SHA-256")) return ALG_SHA256;
    if (str_eq_nocase(name, "SHA-384")) return ALG_SHA384;
    if (str_eq_nocase(name, "SHA-512")) return ALG_SHA512;
    return 0;
}

static psa_algorithm_t hash_to_psa(int h) {
    switch (h) {
    case ALG_SHA1:   return PSA_ALG_SHA_1;
    case ALG_SHA256: return PSA_ALG_SHA_256;
    case ALG_SHA384: return PSA_ALG_SHA_384;
    case ALG_SHA512: return PSA_ALG_SHA_512;
    default:         return PSA_ALG_NONE;
    }
}

static const char *hash_to_name(int h) {
    switch (h) {
    case ALG_SHA1:   return "SHA-1";
    case ALG_SHA256: return "SHA-256";
    case ALG_SHA384: return "SHA-384";
    case ALG_SHA512: return "SHA-512";
    default:         return "unknown";
    }
}

/* ================================================================
 * Helper: extract algorithm name from JS argument
 * The algorithm parameter can be a string or {name: "..."} object
 * ================================================================ */

static const char *get_algorithm_name(JSContext *ctx, JSValueConst arg, JSValue *free_val) {
    *free_val = JS_UNDEFINED;
    if (JS_IsString(arg)) {
        return JS_ToCString(ctx, arg);
    }
    if (JS_IsObject(arg)) {
        JSValue name_val = JS_GetPropertyStr(ctx, arg, "name");
        if (JS_IsException(name_val)) return NULL;
        *free_val = name_val;
        return JS_ToCString(ctx, name_val);
    }
    JS_ThrowTypeError(ctx, "Algorithm must be a string or object with 'name' property");
    return NULL;
}

/* ================================================================
 * Helper: get hash algorithm from algorithm param object
 * e.g. { name: "HMAC", hash: "SHA-256" } or { name: "HMAC", hash: { name: "SHA-256" } }
 * ================================================================ */

static int get_hash_from_algorithm(JSContext *ctx, JSValueConst alg_obj) {
    JSValue hash_val = JS_GetPropertyStr(ctx, alg_obj, "hash");
    if (JS_IsUndefined(hash_val) || JS_IsException(hash_val)) {
        JS_FreeValue(ctx, hash_val);
        return 0;
    }
    const char *hash_name;
    JSValue free_val;
    hash_name = get_algorithm_name(ctx, hash_val, &free_val);
    JS_FreeValue(ctx, hash_val);
    if (!hash_name) return 0;
    int h = resolve_hash_alg(hash_name);
    JS_FreeCString(ctx, hash_name);
    if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
    return h;
}

/* ================================================================
 * Helper: resolve named curve -> PSA ECC family + bits
 * ================================================================ */

static int resolve_named_curve(const char *curve, psa_ecc_family_t *family, size_t *bits) {
    if (str_eq_nocase(curve, "P-256")) {
        *family = PSA_ECC_FAMILY_SECP_R1; *bits = 256; return 1;
    }
    if (str_eq_nocase(curve, "P-384")) {
        *family = PSA_ECC_FAMILY_SECP_R1; *bits = 384; return 1;
    }
    if (str_eq_nocase(curve, "P-521")) {
        *family = PSA_ECC_FAMILY_SECP_R1; *bits = 521; return 1;
    }
    return 0;
}

/* ================================================================
 * Helper: parse key usages array -> PSA usage flags
 * ================================================================ */

static uint32_t parse_key_usages(JSContext *ctx, JSValueConst usages_arr, int *ok) {
    uint32_t flags = 0;
    *ok = 1;
    if (!JS_IsArray(usages_arr)) {
        JS_ThrowTypeError(ctx, "keyUsages must be an array");
        *ok = 0;
        return 0;
    }
    JSValue len_val = JS_GetPropertyStr(ctx, usages_arr, "length");
    uint32_t len;
    JS_ToUint32(ctx, &len, len_val);
    JS_FreeValue(ctx, len_val);

    for (uint32_t i = 0; i < len; i++) {
        JSValue v = JS_GetPropertyUint32(ctx, usages_arr, i);
        const char *s = JS_ToCString(ctx, v);
        JS_FreeValue(ctx, v);
        if (!s) { *ok = 0; return 0; }

        if (strcmp(s, "encrypt") == 0)       flags |= PSA_KEY_USAGE_ENCRYPT;
        else if (strcmp(s, "decrypt") == 0)   flags |= PSA_KEY_USAGE_DECRYPT;
        else if (strcmp(s, "sign") == 0)      flags |= PSA_KEY_USAGE_SIGN_MESSAGE | PSA_KEY_USAGE_SIGN_HASH;
        else if (strcmp(s, "verify") == 0)    flags |= PSA_KEY_USAGE_VERIFY_MESSAGE | PSA_KEY_USAGE_VERIFY_HASH;
        else if (strcmp(s, "deriveKey") == 0)  flags |= PSA_KEY_USAGE_DERIVE;
        else if (strcmp(s, "deriveBits") == 0) flags |= PSA_KEY_USAGE_DERIVE;
        else if (strcmp(s, "wrapKey") == 0)    flags |= PSA_KEY_USAGE_ENCRYPT;
        else if (strcmp(s, "unwrapKey") == 0)  flags |= PSA_KEY_USAGE_DECRYPT;
        else {
            JS_ThrowTypeError(ctx, "Invalid key usage: '%s'", s);
            JS_FreeCString(ctx, s);
            *ok = 0;
            return 0;
        }
        JS_FreeCString(ctx, s);
    }
    return flags;
}

/* ================================================================
 * Helper: create a frozen JS array of usage strings from flags
 * ================================================================ */

static JSValue usages_from_flags(JSContext *ctx, uint32_t flags) {
    JSValue arr = JS_NewArray(ctx);
    uint32_t idx = 0;
    if (flags & PSA_KEY_USAGE_ENCRYPT)
        JS_SetPropertyUint32(ctx, arr, idx++, JS_NewString(ctx, "encrypt"));
    if (flags & PSA_KEY_USAGE_DECRYPT)
        JS_SetPropertyUint32(ctx, arr, idx++, JS_NewString(ctx, "decrypt"));
    if (flags & (PSA_KEY_USAGE_SIGN_MESSAGE | PSA_KEY_USAGE_SIGN_HASH))
        JS_SetPropertyUint32(ctx, arr, idx++, JS_NewString(ctx, "sign"));
    if (flags & (PSA_KEY_USAGE_VERIFY_MESSAGE | PSA_KEY_USAGE_VERIFY_HASH))
        JS_SetPropertyUint32(ctx, arr, idx++, JS_NewString(ctx, "verify"));
    if (flags & PSA_KEY_USAGE_DERIVE) {
        JS_SetPropertyUint32(ctx, arr, idx++, JS_NewString(ctx, "deriveKey"));
        JS_SetPropertyUint32(ctx, arr, idx++, JS_NewString(ctx, "deriveBits"));
    }
    /* Freeze it */
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue obj_ctor = JS_GetPropertyStr(ctx, global, "Object");
    JSValue freeze = JS_GetPropertyStr(ctx, obj_ctor, "freeze");
    JS_Call(ctx, freeze, obj_ctor, 1, &arr);
    JS_FreeValue(ctx, freeze);
    JS_FreeValue(ctx, obj_ctor);
    JS_FreeValue(ctx, global);
    return arr;
}

/* ================================================================
 * Helper: get ArrayBuffer data from various buffer types
 * Handles ArrayBuffer, TypedArray, DataView
 * ================================================================ */

static uint8_t *get_buffer_data(JSContext *ctx, JSValueConst val,
                                size_t *plen, JSValue *pfree) {
    size_t len, offset, bpe;
    *pfree = JS_UNDEFINED;

    /* Try TypedArray first */
    JSValue buf = JS_GetTypedArrayBuffer(ctx, val, &offset, &len, &bpe);
    if (!JS_IsException(buf)) {
        size_t ab_len;
        uint8_t *ptr = JS_GetArrayBuffer(ctx, &ab_len, buf);
        *pfree = buf;
        if (ptr) {
            *plen = len;
            return ptr + offset;
        }
        JS_FreeValue(ctx, buf);
        *pfree = JS_UNDEFINED;
    } else {
        JS_FreeValue(ctx, JS_GetException(ctx)); /* clear exception */
    }

    /* Try ArrayBuffer directly */
    size_t ab_len;
    uint8_t *ptr = JS_GetArrayBuffer(ctx, &ab_len, val);
    if (ptr) {
        *plen = ab_len;
        return ptr;
    }

    /* Try DataView */
    JSValue dv_buf = JS_GetPropertyStr(ctx, val, "buffer");
    if (!JS_IsUndefined(dv_buf) && !JS_IsException(dv_buf)) {
        JSValue dv_offset = JS_GetPropertyStr(ctx, val, "byteOffset");
        JSValue dv_len = JS_GetPropertyStr(ctx, val, "byteLength");
        uint32_t off32 = 0, len32 = 0;
        JS_ToUint32(ctx, &off32, dv_offset);
        JS_ToUint32(ctx, &len32, dv_len);
        JS_FreeValue(ctx, dv_offset);
        JS_FreeValue(ctx, dv_len);

        size_t buf_len;
        uint8_t *buf_ptr = JS_GetArrayBuffer(ctx, &buf_len, dv_buf);
        *pfree = dv_buf;
        if (buf_ptr) {
            *plen = len32;
            return buf_ptr + off32;
        }
        JS_FreeValue(ctx, dv_buf);
        *pfree = JS_UNDEFINED;
    } else {
        JS_FreeValue(ctx, dv_buf);
    }

    JS_ThrowTypeError(ctx, "Expected BufferSource (ArrayBuffer, TypedArray, or DataView)");
    *plen = 0;
    return NULL;
}

/* ================================================================
 * Helper: create a resolved Promise wrapping a value
 * ================================================================ */

static JSValue new_resolved_promise(JSContext *ctx, JSValue val) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue promise_ctor = JS_GetPropertyStr(ctx, global, "Promise");
    JSValue resolve_fn = JS_GetPropertyStr(ctx, promise_ctor, "resolve");
    JSValue result = JS_Call(ctx, resolve_fn, promise_ctor, 1, &val);
    JS_FreeValue(ctx, resolve_fn);
    JS_FreeValue(ctx, promise_ctor);
    JS_FreeValue(ctx, global);
    return result;
}

/* ================================================================
 * Helper: create a rejected Promise with an error message
 * ================================================================ */

static JSValue new_rejected_promise(JSContext *ctx, const char *msg) {
    JSValue err = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, err, "message", JS_NewString(ctx, msg));
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue promise_ctor = JS_GetPropertyStr(ctx, global, "Promise");
    JSValue reject_fn = JS_GetPropertyStr(ctx, promise_ctor, "reject");
    JSValue result = JS_Call(ctx, reject_fn, promise_ctor, 1, &err);
    JS_FreeValue(ctx, reject_fn);
    JS_FreeValue(ctx, promise_ctor);
    JS_FreeValue(ctx, global);
    JS_FreeValue(ctx, err);
    return result;
}

/* ================================================================
 * CryptoKey class
 * ================================================================ */

static void js_cryptokey_finalizer(JSRuntime *rt, JSValue val) {
    CryptoKeyData *kd = (CryptoKeyData *)JS_GetOpaque(val, js_cryptokey_class_id);
    if (kd) {
        if (kd->key_id != 0) {
            psa_destroy_key(kd->key_id);
        }
        if (kd->alg_name) js_free_rt(rt, kd->alg_name);
        if (kd->named_curve) js_free_rt(rt, kd->named_curve);
        JS_FreeValueRT(rt, kd->usages_array);
        js_free_rt(rt, kd);
    }
}

static JSClassDef js_cryptokey_class = {
    "CryptoKey",
    .finalizer = js_cryptokey_finalizer,
};

/* CryptoKey.type getter */
static JSValue js_cryptokey_get_type(JSContext *ctx, JSValueConst this_val) {
    CryptoKeyData *kd = (CryptoKeyData *)JS_GetOpaque(this_val, js_cryptokey_class_id);
    if (!kd) return JS_EXCEPTION;
    /* Determine type from PSA key type */
    if (PSA_KEY_TYPE_IS_PUBLIC_KEY(kd->key_type))
        return JS_NewString(ctx, "public");
    if (PSA_KEY_TYPE_IS_KEY_PAIR(kd->key_type))
        return JS_NewString(ctx, "private");
    return JS_NewString(ctx, "secret");
}

/* CryptoKey.extractable getter */
static JSValue js_cryptokey_get_extractable(JSContext *ctx, JSValueConst this_val) {
    CryptoKeyData *kd = (CryptoKeyData *)JS_GetOpaque(this_val, js_cryptokey_class_id);
    if (!kd) return JS_EXCEPTION;
    return JS_NewBool(ctx, kd->extractable);
}

/* CryptoKey.algorithm getter — returns a frozen algorithm object */
static JSValue js_cryptokey_get_algorithm(JSContext *ctx, JSValueConst this_val) {
    CryptoKeyData *kd = (CryptoKeyData *)JS_GetOpaque(this_val, js_cryptokey_class_id);
    if (!kd) return JS_EXCEPTION;

    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "name", JS_NewString(ctx, kd->alg_name));

    switch (kd->algorithm) {
    case ALG_HMAC:
        if (kd->hash_alg) {
            JSValue hash_obj = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, hash_obj, "name",
                              JS_NewString(ctx, hash_to_name(kd->hash_alg)));
            JS_SetPropertyStr(ctx, obj, "hash", hash_obj);
        }
        JS_SetPropertyStr(ctx, obj, "length",
                          JS_NewInt64(ctx, (int64_t)kd->key_bits));
        break;

    case ALG_AES_CBC: case ALG_AES_CTR: case ALG_AES_GCM: case ALG_AES_KW:
        JS_SetPropertyStr(ctx, obj, "length",
                          JS_NewInt64(ctx, (int64_t)kd->key_bits));
        break;

    case ALG_RSA_OAEP: case ALG_RSASSA_PKCS1_V1_5: case ALG_RSA_PSS:
        JS_SetPropertyStr(ctx, obj, "modulusLength",
                          JS_NewInt64(ctx, (int64_t)kd->key_bits));
        /* publicExponent: typically 65537 */
        {
            uint8_t exp_bytes[] = {0x01, 0x00, 0x01}; /* 65537 */
            JSValue ab = JS_NewArrayBufferCopy(ctx, exp_bytes, 3);
            JSValue global = JS_GetGlobalObject(ctx);
            JSValue u8_ctor = JS_GetPropertyStr(ctx, global, "Uint8Array");
            JSValue u8 = JS_CallConstructor(ctx, u8_ctor, 1, &ab);
            JS_FreeValue(ctx, ab);
            JS_FreeValue(ctx, u8_ctor);
            JS_FreeValue(ctx, global);
            JS_SetPropertyStr(ctx, obj, "publicExponent", u8);
        }
        if (kd->hash_alg) {
            JSValue hash_obj = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, hash_obj, "name",
                              JS_NewString(ctx, hash_to_name(kd->hash_alg)));
            JS_SetPropertyStr(ctx, obj, "hash", hash_obj);
        }
        break;

    case ALG_ECDSA: case ALG_ECDH:
        if (kd->named_curve)
            JS_SetPropertyStr(ctx, obj, "namedCurve",
                              JS_NewString(ctx, kd->named_curve));
        break;

    case ALG_ED25519: case ALG_X25519:
        /* No extra properties */
        break;

    case ALG_HKDF: case ALG_PBKDF2:
        if (kd->hash_alg) {
            JSValue hash_obj = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, hash_obj, "name",
                              JS_NewString(ctx, hash_to_name(kd->hash_alg)));
            JS_SetPropertyStr(ctx, obj, "hash", hash_obj);
        }
        break;
    }

    /* Freeze the algorithm object */
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue obj_ctor = JS_GetPropertyStr(ctx, global, "Object");
    JSValue freeze = JS_GetPropertyStr(ctx, obj_ctor, "freeze");
    JS_Call(ctx, freeze, obj_ctor, 1, &obj);
    JS_FreeValue(ctx, freeze);
    JS_FreeValue(ctx, obj_ctor);
    JS_FreeValue(ctx, global);

    return obj;
}

/* CryptoKey.usages getter */
static JSValue js_cryptokey_get_usages(JSContext *ctx, JSValueConst this_val) {
    CryptoKeyData *kd = (CryptoKeyData *)JS_GetOpaque(this_val, js_cryptokey_class_id);
    if (!kd) return JS_EXCEPTION;
    return JS_DupValue(ctx, kd->usages_array);
}

static const JSCFunctionListEntry js_cryptokey_proto_funcs[] = {
    JS_CGETSET_DEF("type", js_cryptokey_get_type, NULL),
    JS_CGETSET_DEF("extractable", js_cryptokey_get_extractable, NULL),
    JS_CGETSET_DEF("algorithm", js_cryptokey_get_algorithm, NULL),
    JS_CGETSET_DEF("usages", js_cryptokey_get_usages, NULL),
};

/* Helper: create a new CryptoKey JS object from CryptoKeyData */
static JSValue make_cryptokey(JSContext *ctx, CryptoKeyData *kd) {
    JSValue proto = JS_GetClassProto(ctx, js_cryptokey_class_id);
    JSValue obj = JS_NewObjectProtoClass(ctx, proto, js_cryptokey_class_id);
    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj)) return obj;
    JS_SetOpaque(obj, kd);
    return obj;
}

/* ================================================================
 * Crypto.getRandomValues(typedArray)
 * ================================================================ */

static JSValue js_crypto_getRandomValues(JSContext *ctx, JSValueConst this_val,
                                          int argc, JSValueConst *argv) {
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "getRandomValues requires 1 argument");

    JSValue arg = argv[0];

    /* Must be an integer typed array */
    size_t offset, len, bpe;
    JSValue buf = JS_GetTypedArrayBuffer(ctx, arg, &offset, &len, &bpe);
    if (JS_IsException(buf))
        return JS_ThrowTypeError(ctx, "Argument must be an integer typed array");

    /* Check byteLength <= 65536 */
    if (len > 65536) {
        JS_FreeValue(ctx, buf);
        return JS_ThrowRangeError(ctx,
            "The ArrayBufferView's byte length (%zu) exceeds the number of bytes "
            "of entropy available via this API (65536)", len);
    }

    size_t ab_len;
    uint8_t *ptr = JS_GetArrayBuffer(ctx, &ab_len, buf);
    JS_FreeValue(ctx, buf);
    if (!ptr)
        return JS_ThrowTypeError(ctx, "Could not access ArrayBuffer data");

    /* Fill with random bytes via WASI */
    int rc = __wasi_random_get(ptr + offset, len);
    if (rc != 0)
        return JS_ThrowInternalError(ctx, "random_get failed");

    return JS_DupValue(ctx, arg);
}

/* ================================================================
 * Crypto.randomUUID()
 * Returns a v4 UUID string: "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
 * ================================================================ */

static JSValue js_crypto_randomUUID(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv) {
    uint8_t bytes[16];
    int rc = __wasi_random_get(bytes, 16);
    if (rc != 0)
        return JS_ThrowInternalError(ctx, "random_get failed");

    /* Set version 4 */
    bytes[6] = (bytes[6] & 0x0F) | 0x40;
    /* Set variant 1 */
    bytes[8] = (bytes[8] & 0x3F) | 0x80;

    static const char hex[] = "0123456789abcdef";
    char uuid[37];
    int p = 0;
    for (int i = 0; i < 16; i++) {
        if (i == 4 || i == 6 || i == 8 || i == 10)
            uuid[p++] = '-';
        uuid[p++] = hex[bytes[i] >> 4];
        uuid[p++] = hex[bytes[i] & 0x0F];
    }
    uuid[36] = '\0';

    return JS_NewStringLen(ctx, uuid, 36);
}

/* ================================================================
 * SubtleCrypto.digest(algorithm, data)
 * ================================================================ */

static JSValue js_subtle_digest(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
    if (argc < 2)
        return new_rejected_promise(ctx, "digest requires 2 arguments");

    JSValue free_val;
    const char *alg_name = get_algorithm_name(ctx, argv[0], &free_val);
    if (!alg_name) return new_rejected_promise(ctx, "Invalid algorithm");

    int h = resolve_hash_alg(alg_name);
    JS_FreeCString(ctx, alg_name);
    if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);

    if (!h)
        return new_rejected_promise(ctx, "Unrecognized algorithm name for digest");

    psa_algorithm_t psa_hash = hash_to_psa(h);

    size_t data_len;
    JSValue data_free;
    uint8_t *data = get_buffer_data(ctx, argv[1], &data_len, &data_free);
    if (!data) {
        /* Clear thrown exception, return rejected promise */
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        return new_rejected_promise(ctx, "Invalid data argument for digest");
    }

    size_t hash_len = PSA_HASH_LENGTH(psa_hash);
    uint8_t *hash_buf = js_malloc(ctx, hash_len);
    if (!hash_buf) {
        if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);
        return new_rejected_promise(ctx, "Out of memory");
    }

    size_t actual_len = 0;
    psa_status_t status = psa_hash_compute(psa_hash, data, data_len,
                                            hash_buf, hash_len, &actual_len);
    if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);

    if (status != PSA_SUCCESS) {
        js_free(ctx, hash_buf);
        return new_rejected_promise(ctx, "Digest computation failed");
    }

    JSValue ab = JS_NewArrayBufferCopy(ctx, hash_buf, actual_len);
    js_free(ctx, hash_buf);
    JSValue result = new_resolved_promise(ctx, ab);
    JS_FreeValue(ctx, ab);
    return result;
}

/* ================================================================
 * SubtleCrypto.generateKey(algorithm, extractable, keyUsages)
 * ================================================================ */

static JSValue js_subtle_generateKey(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv) {
    if (argc < 3)
        return new_rejected_promise(ctx, "generateKey requires 3 arguments");

    JSValue alg_obj = argv[0];
    int extractable = JS_ToBool(ctx, argv[1]);
    JSValue usages_arr = argv[2];

    JSValue free_val;
    const char *alg_name = get_algorithm_name(ctx, alg_obj, &free_val);
    if (!alg_name) {
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        return new_rejected_promise(ctx, "Invalid algorithm");
    }

    int ok;
    uint32_t usage_flags = parse_key_usages(ctx, usages_arr, &ok);
    if (!ok) {
        JS_FreeCString(ctx, alg_name);
        if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        return new_rejected_promise(ctx, "Invalid key usages");
    }

    psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
    psa_key_id_t key_id = 0;
    int alg_id = 0;
    int hash_alg = 0;
    char *curve_name = NULL;
    size_t key_bits = 0;

    /* --- HMAC --- */
    if (str_eq_nocase(alg_name, "HMAC")) {
        alg_id = ALG_HMAC;
        hash_alg = get_hash_from_algorithm(ctx, alg_obj);
        if (!hash_alg) {
            JS_FreeCString(ctx, alg_name);
            if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
            return new_rejected_promise(ctx, "HMAC requires a hash algorithm");
        }
        psa_algorithm_t psa_hash = hash_to_psa(hash_alg);

        /* Optional length property */
        JSValue len_val = JS_GetPropertyStr(ctx, alg_obj, "length");
        if (!JS_IsUndefined(len_val) && !JS_IsException(len_val)) {
            uint32_t len32;
            JS_ToUint32(ctx, &len32, len_val);
            key_bits = len32;
        } else {
            key_bits = PSA_HASH_LENGTH(psa_hash) * 8;
        }
        JS_FreeValue(ctx, len_val);

        psa_set_key_type(&attributes, PSA_KEY_TYPE_HMAC);
        psa_set_key_bits(&attributes, key_bits);
        psa_set_key_algorithm(&attributes, PSA_ALG_HMAC(psa_hash));
        psa_set_key_usage_flags(&attributes,
            usage_flags | PSA_KEY_USAGE_EXPORT);
        if (extractable) psa_set_key_usage_flags(&attributes,
            psa_get_key_usage_flags(&attributes) | PSA_KEY_USAGE_EXPORT);
    }
    /* --- AES-CBC, AES-CTR, AES-GCM, AES-KW --- */
    else if (str_eq_nocase(alg_name, "AES-CBC") || str_eq_nocase(alg_name, "AES-CTR") ||
             str_eq_nocase(alg_name, "AES-GCM") || str_eq_nocase(alg_name, "AES-KW")) {
        if (str_eq_nocase(alg_name, "AES-CBC"))      alg_id = ALG_AES_CBC;
        else if (str_eq_nocase(alg_name, "AES-CTR"))  alg_id = ALG_AES_CTR;
        else if (str_eq_nocase(alg_name, "AES-GCM"))  alg_id = ALG_AES_GCM;
        else                                           alg_id = ALG_AES_KW;

        JSValue len_val = JS_GetPropertyStr(ctx, alg_obj, "length");
        if (JS_IsUndefined(len_val) || JS_IsException(len_val)) {
            JS_FreeValue(ctx, len_val);
            JS_FreeCString(ctx, alg_name);
            if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
            return new_rejected_promise(ctx, "AES generateKey requires 'length' (128, 192, or 256)");
        }
        uint32_t len32;
        JS_ToUint32(ctx, &len32, len_val);
        JS_FreeValue(ctx, len_val);
        key_bits = len32;

        if (key_bits != 128 && key_bits != 192 && key_bits != 256) {
            JS_FreeCString(ctx, alg_name);
            if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
            return new_rejected_promise(ctx, "AES key length must be 128, 192, or 256");
        }

        psa_algorithm_t psa_alg;
        switch (alg_id) {
        case ALG_AES_CBC: psa_alg = PSA_ALG_CBC_NO_PADDING; break;
        case ALG_AES_CTR: psa_alg = PSA_ALG_CTR; break;
        case ALG_AES_GCM: psa_alg = PSA_ALG_GCM; break;
        case ALG_AES_KW:  psa_alg = PSA_ALG_ECB_NO_PADDING; break; /* AES-KW uses nist_kw */
        default:          psa_alg = PSA_ALG_NONE; break;
        }

        psa_set_key_type(&attributes, PSA_KEY_TYPE_AES);
        psa_set_key_bits(&attributes, key_bits);
        psa_set_key_algorithm(&attributes, psa_alg);
        uint32_t uf = usage_flags;
        if (extractable) uf |= PSA_KEY_USAGE_EXPORT;
        psa_set_key_usage_flags(&attributes, uf);
    }
    /* --- RSA algorithms --- */
    else if (str_eq_nocase(alg_name, "RSASSA-PKCS1-v1_5") ||
             str_eq_nocase(alg_name, "RSA-PSS") ||
             str_eq_nocase(alg_name, "RSA-OAEP")) {
        if (str_eq_nocase(alg_name, "RSASSA-PKCS1-v1_5")) alg_id = ALG_RSASSA_PKCS1_V1_5;
        else if (str_eq_nocase(alg_name, "RSA-PSS"))       alg_id = ALG_RSA_PSS;
        else                                                alg_id = ALG_RSA_OAEP;

        hash_alg = get_hash_from_algorithm(ctx, alg_obj);
        if (!hash_alg) {
            JS_FreeCString(ctx, alg_name);
            if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
            return new_rejected_promise(ctx, "RSA requires a hash algorithm");
        }
        psa_algorithm_t psa_hash = hash_to_psa(hash_alg);

        JSValue ml_val = JS_GetPropertyStr(ctx, alg_obj, "modulusLength");
        uint32_t modulus_length = 2048;
        if (!JS_IsUndefined(ml_val) && !JS_IsException(ml_val))
            JS_ToUint32(ctx, &modulus_length, ml_val);
        JS_FreeValue(ctx, ml_val);
        key_bits = modulus_length;

        psa_algorithm_t psa_alg;
        switch (alg_id) {
        case ALG_RSASSA_PKCS1_V1_5: psa_alg = PSA_ALG_RSA_PKCS1V15_SIGN(psa_hash); break;
        case ALG_RSA_PSS:            psa_alg = PSA_ALG_RSA_PSS(psa_hash); break;
        case ALG_RSA_OAEP:           psa_alg = PSA_ALG_RSA_OAEP(psa_hash); break;
        default:                     psa_alg = PSA_ALG_NONE; break;
        }

        psa_set_key_type(&attributes, PSA_KEY_TYPE_RSA_KEY_PAIR);
        psa_set_key_bits(&attributes, key_bits);
        psa_set_key_algorithm(&attributes, psa_alg);
        uint32_t uf = usage_flags;
        if (extractable) uf |= PSA_KEY_USAGE_EXPORT;
        psa_set_key_usage_flags(&attributes, uf);
    }
    /* --- ECDSA / ECDH --- */
    else if (str_eq_nocase(alg_name, "ECDSA") || str_eq_nocase(alg_name, "ECDH")) {
        alg_id = str_eq_nocase(alg_name, "ECDSA") ? ALG_ECDSA : ALG_ECDH;

        JSValue curve_val = JS_GetPropertyStr(ctx, alg_obj, "namedCurve");
        const char *curve_str = JS_ToCString(ctx, curve_val);
        JS_FreeValue(ctx, curve_val);
        if (!curve_str) {
            JS_FreeCString(ctx, alg_name);
            if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
            return new_rejected_promise(ctx, "ECDSA/ECDH requires namedCurve");
        }

        psa_ecc_family_t family;
        if (!resolve_named_curve(curve_str, &family, &key_bits)) {
            JS_FreeCString(ctx, curve_str);
            JS_FreeCString(ctx, alg_name);
            if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
            return new_rejected_promise(ctx, "Unsupported named curve");
        }

        size_t clen = strlen(curve_str);
        curve_name = js_malloc(ctx, clen + 1);
        if (curve_name) { memcpy(curve_name, curve_str, clen); curve_name[clen] = '\0'; }
        JS_FreeCString(ctx, curve_str);

        hash_alg = get_hash_from_algorithm(ctx, alg_obj);

        psa_algorithm_t psa_alg;
        if (alg_id == ALG_ECDSA) {
            psa_algorithm_t h = hash_alg ? hash_to_psa(hash_alg) : PSA_ALG_ANY_HASH;
            psa_alg = PSA_ALG_ECDSA(h);
        } else {
            psa_alg = PSA_ALG_ECDH;
        }

        psa_set_key_type(&attributes, PSA_KEY_TYPE_ECC_KEY_PAIR(family));
        psa_set_key_bits(&attributes, key_bits);
        psa_set_key_algorithm(&attributes, psa_alg);
        uint32_t uf = usage_flags;
        if (extractable) uf |= PSA_KEY_USAGE_EXPORT;
        psa_set_key_usage_flags(&attributes, uf);
    }
    /* --- Ed25519 --- */
    else if (str_eq_nocase(alg_name, "Ed25519")) {
        alg_id = ALG_ED25519;
        key_bits = 255;
        psa_set_key_type(&attributes, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_TWISTED_EDWARDS));
        psa_set_key_bits(&attributes, key_bits);
        psa_set_key_algorithm(&attributes, PSA_ALG_PURE_EDDSA);
        uint32_t uf = usage_flags;
        if (extractable) uf |= PSA_KEY_USAGE_EXPORT;
        psa_set_key_usage_flags(&attributes, uf);
    }
    /* --- X25519 --- */
    else if (str_eq_nocase(alg_name, "X25519")) {
        alg_id = ALG_X25519;
        key_bits = 255;
        psa_set_key_type(&attributes, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_MONTGOMERY));
        psa_set_key_bits(&attributes, key_bits);
        psa_set_key_algorithm(&attributes, PSA_ALG_ECDH);
        uint32_t uf = usage_flags;
        if (extractable) uf |= PSA_KEY_USAGE_EXPORT;
        psa_set_key_usage_flags(&attributes, uf);
    }
    else {
        JS_FreeCString(ctx, alg_name);
        if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
        return new_rejected_promise(ctx, "Unsupported algorithm for generateKey");
    }

    /* Generate the key */
    psa_status_t status = psa_generate_key(&attributes, &key_id);
    psa_algorithm_t final_alg = psa_get_key_algorithm(&attributes);
    psa_key_type_t final_type = PSA_KEY_TYPE_NONE;
    if (status == PSA_SUCCESS) {
        psa_key_attributes_t ka = PSA_KEY_ATTRIBUTES_INIT;
        psa_get_key_attributes(key_id, &ka);
        final_type = psa_get_key_type(&ka);
        key_bits = psa_get_key_bits(&ka);
        psa_reset_key_attributes(&ka);
    }

    if (status != PSA_SUCCESS) {
        JS_FreeCString(ctx, alg_name);
        if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
        if (curve_name) js_free(ctx, curve_name);
        char errbuf[128];
        snprintf(errbuf, sizeof(errbuf), "Key generation failed (PSA error %d)", (int)status);
        return new_rejected_promise(ctx, errbuf);
    }

    /* For asymmetric algorithms, return CryptoKeyPair {publicKey, privateKey} */
    int is_keypair = PSA_KEY_TYPE_IS_KEY_PAIR(final_type);

    if (is_keypair) {
        /* Export public key and re-import as public-only key */
        uint8_t pub_buf[PSA_EXPORT_PUBLIC_KEY_MAX_SIZE];
        size_t pub_len = 0;
        psa_status_t ps = psa_export_public_key(key_id, pub_buf, sizeof(pub_buf), &pub_len);
        if (ps != PSA_SUCCESS) {
            psa_destroy_key(key_id);
            JS_FreeCString(ctx, alg_name);
            if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
            if (curve_name) js_free(ctx, curve_name);
            return new_rejected_promise(ctx, "Failed to export public key");
        }

        /* Import as public key */
        psa_key_attributes_t pub_attr = PSA_KEY_ATTRIBUTES_INIT;
        psa_key_type_t pub_type = PSA_KEY_TYPE_PUBLIC_KEY_OF_KEY_PAIR(final_type);
        psa_set_key_type(&pub_attr, pub_type);
        psa_set_key_bits(&pub_attr, key_bits);
        psa_set_key_algorithm(&pub_attr, final_alg);
        /* Public key: allow export + verify/encrypt */
        uint32_t pub_usage = PSA_KEY_USAGE_EXPORT |
                             PSA_KEY_USAGE_VERIFY_MESSAGE | PSA_KEY_USAGE_VERIFY_HASH |
                             PSA_KEY_USAGE_ENCRYPT;
        psa_set_key_usage_flags(&pub_attr, pub_usage);

        psa_key_id_t pub_key_id = 0;
        ps = psa_import_key(&pub_attr, pub_buf, pub_len, &pub_key_id);
        if (ps != PSA_SUCCESS) {
            psa_destroy_key(key_id);
            JS_FreeCString(ctx, alg_name);
            if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
            if (curve_name) js_free(ctx, curve_name);
            return new_rejected_promise(ctx, "Failed to import public key");
        }

        /* Build private CryptoKeyData */
        CryptoKeyData *priv_kd = js_mallocz(ctx, sizeof(CryptoKeyData));
        priv_kd->key_id = key_id;
        priv_kd->algorithm = alg_id;
        size_t nlen = strlen(alg_name);
        priv_kd->alg_name = js_malloc(ctx, nlen + 1);
        memcpy(priv_kd->alg_name, alg_name, nlen + 1);
        priv_kd->extractable = extractable;
        priv_kd->psa_usage_flags = usage_flags;
        priv_kd->psa_alg = final_alg;
        priv_kd->key_type = final_type;
        priv_kd->key_bits = key_bits;
        priv_kd->hash_alg = hash_alg;
        priv_kd->named_curve = curve_name;
        priv_kd->usages_array = usages_from_flags(ctx, usage_flags);

        /* Build public CryptoKeyData */
        CryptoKeyData *pub_kd = js_mallocz(ctx, sizeof(CryptoKeyData));
        pub_kd->key_id = pub_key_id;
        pub_kd->algorithm = alg_id;
        pub_kd->alg_name = js_malloc(ctx, nlen + 1);
        memcpy(pub_kd->alg_name, alg_name, nlen + 1);
        pub_kd->extractable = 1; /* public keys are always extractable */
        pub_kd->psa_usage_flags = pub_usage;
        pub_kd->psa_alg = final_alg;
        pub_kd->key_type = pub_type;
        pub_kd->key_bits = key_bits;
        pub_kd->hash_alg = hash_alg;
        if (curve_name) {
            size_t clen2 = strlen(curve_name);
            pub_kd->named_curve = js_malloc(ctx, clen2 + 1);
            memcpy(pub_kd->named_curve, curve_name, clen2 + 1);
        }
        pub_kd->usages_array = usages_from_flags(ctx, pub_usage);

        JS_FreeCString(ctx, alg_name);
        if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);

        JSValue priv_obj = make_cryptokey(ctx, priv_kd);
        JSValue pub_obj = make_cryptokey(ctx, pub_kd);

        JSValue pair = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, pair, "privateKey", priv_obj);
        JS_SetPropertyStr(ctx, pair, "publicKey", pub_obj);

        JSValue result = new_resolved_promise(ctx, pair);
        JS_FreeValue(ctx, pair);
        return result;
    }

    /* Symmetric key */
    CryptoKeyData *kd = js_mallocz(ctx, sizeof(CryptoKeyData));
    kd->key_id = key_id;
    kd->algorithm = alg_id;
    size_t nlen = strlen(alg_name);
    kd->alg_name = js_malloc(ctx, nlen + 1);
    memcpy(kd->alg_name, alg_name, nlen + 1);
    kd->extractable = extractable;
    kd->psa_usage_flags = usage_flags;
    kd->psa_alg = final_alg;
    kd->key_type = final_type;
    kd->key_bits = key_bits;
    kd->hash_alg = hash_alg;
    kd->usages_array = usages_from_flags(ctx, usage_flags);

    JS_FreeCString(ctx, alg_name);
    if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);

    JSValue key_obj = make_cryptokey(ctx, kd);
    JSValue result = new_resolved_promise(ctx, key_obj);
    JS_FreeValue(ctx, key_obj);
    return result;
}

/* ================================================================
 * SubtleCrypto.importKey(format, keyData, algorithm, extractable, keyUsages)
 * Supported formats: "raw", "pkcs8", "spki"
 * ================================================================ */

static JSValue js_subtle_importKey(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    if (argc < 5)
        return new_rejected_promise(ctx, "importKey requires 5 arguments");

    const char *format = JS_ToCString(ctx, argv[0]);
    if (!format) return new_rejected_promise(ctx, "Invalid format");

    JSValue alg_obj = argv[2];
    int extractable = JS_ToBool(ctx, argv[3]);
    JSValue usages_arr = argv[4];

    JSValue free_val;
    const char *alg_name = get_algorithm_name(ctx, alg_obj, &free_val);
    if (!alg_name) {
        JS_FreeCString(ctx, format);
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        return new_rejected_promise(ctx, "Invalid algorithm");
    }

    int ok;
    uint32_t usage_flags = parse_key_usages(ctx, usages_arr, &ok);
    if (!ok) {
        JS_FreeCString(ctx, format);
        JS_FreeCString(ctx, alg_name);
        if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        return new_rejected_promise(ctx, "Invalid key usages");
    }

    /* Get key data bytes */
    size_t data_len;
    JSValue data_free;
    uint8_t *data = get_buffer_data(ctx, argv[1], &data_len, &data_free);
    if (!data) {
        JS_FreeCString(ctx, format);
        JS_FreeCString(ctx, alg_name);
        if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        return new_rejected_promise(ctx, "Invalid key data");
    }

    /* Resolve algorithm and key type */
    int alg_id = 0;
    int hash_alg = 0;
    psa_key_type_t key_type = PSA_KEY_TYPE_NONE;
    psa_algorithm_t psa_alg = PSA_ALG_NONE;
    size_t key_bits_hint = 0;
    char *curve_name = NULL;

    if (str_eq_nocase(alg_name, "HMAC")) {
        alg_id = ALG_HMAC;
        hash_alg = get_hash_from_algorithm(ctx, alg_obj);
        if (!hash_alg) {
            JS_FreeCString(ctx, format); JS_FreeCString(ctx, alg_name);
            if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
            if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);
            return new_rejected_promise(ctx, "HMAC importKey requires hash");
        }
        key_type = PSA_KEY_TYPE_HMAC;
        psa_alg = PSA_ALG_HMAC(hash_to_psa(hash_alg));
    }
    else if (str_eq_nocase(alg_name, "AES-CBC")) {
        alg_id = ALG_AES_CBC; key_type = PSA_KEY_TYPE_AES; psa_alg = PSA_ALG_CBC_NO_PADDING;
    }
    else if (str_eq_nocase(alg_name, "AES-CTR")) {
        alg_id = ALG_AES_CTR; key_type = PSA_KEY_TYPE_AES; psa_alg = PSA_ALG_CTR;
    }
    else if (str_eq_nocase(alg_name, "AES-GCM")) {
        alg_id = ALG_AES_GCM; key_type = PSA_KEY_TYPE_AES; psa_alg = PSA_ALG_GCM;
    }
    else if (str_eq_nocase(alg_name, "AES-KW")) {
        alg_id = ALG_AES_KW; key_type = PSA_KEY_TYPE_AES; psa_alg = PSA_ALG_ECB_NO_PADDING;
    }
    else if (str_eq_nocase(alg_name, "RSASSA-PKCS1-v1_5") ||
             str_eq_nocase(alg_name, "RSA-PSS") ||
             str_eq_nocase(alg_name, "RSA-OAEP")) {
        hash_alg = get_hash_from_algorithm(ctx, alg_obj);
        psa_algorithm_t ph = hash_alg ? hash_to_psa(hash_alg) : PSA_ALG_SHA_256;
        if (str_eq_nocase(alg_name, "RSASSA-PKCS1-v1_5")) {
            alg_id = ALG_RSASSA_PKCS1_V1_5; psa_alg = PSA_ALG_RSA_PKCS1V15_SIGN(ph);
        } else if (str_eq_nocase(alg_name, "RSA-PSS")) {
            alg_id = ALG_RSA_PSS; psa_alg = PSA_ALG_RSA_PSS(ph);
        } else {
            alg_id = ALG_RSA_OAEP; psa_alg = PSA_ALG_RSA_OAEP(ph);
        }
        /* key_type depends on format */
        if (strcmp(format, "pkcs8") == 0)
            key_type = PSA_KEY_TYPE_RSA_KEY_PAIR;
        else if (strcmp(format, "spki") == 0)
            key_type = PSA_KEY_TYPE_RSA_PUBLIC_KEY;
        else
            key_type = PSA_KEY_TYPE_RSA_KEY_PAIR; /* raw not typical for RSA */
    }
    else if (str_eq_nocase(alg_name, "ECDSA") || str_eq_nocase(alg_name, "ECDH")) {
        alg_id = str_eq_nocase(alg_name, "ECDSA") ? ALG_ECDSA : ALG_ECDH;
        hash_alg = get_hash_from_algorithm(ctx, alg_obj);

        JSValue curve_val = JS_GetPropertyStr(ctx, alg_obj, "namedCurve");
        const char *cs = JS_ToCString(ctx, curve_val);
        JS_FreeValue(ctx, curve_val);
        psa_ecc_family_t family;
        size_t bits;
        if (!cs || !resolve_named_curve(cs, &family, &bits)) {
            if (cs) JS_FreeCString(ctx, cs);
            JS_FreeCString(ctx, format); JS_FreeCString(ctx, alg_name);
            if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
            if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);
            return new_rejected_promise(ctx, "Unsupported curve for ECDSA/ECDH importKey");
        }
        size_t cnlen = strlen(cs);
        curve_name = js_malloc(ctx, cnlen + 1);
        if (curve_name) { memcpy(curve_name, cs, cnlen); curve_name[cnlen] = '\0'; }
        JS_FreeCString(ctx, cs);
        key_bits_hint = bits;

        if (strcmp(format, "pkcs8") == 0 || strcmp(format, "raw") == 0)
            key_type = PSA_KEY_TYPE_ECC_KEY_PAIR(family);
        else if (strcmp(format, "spki") == 0)
            key_type = PSA_KEY_TYPE_ECC_PUBLIC_KEY(family);
        else
            key_type = PSA_KEY_TYPE_ECC_KEY_PAIR(family);

        if (alg_id == ALG_ECDSA) {
            psa_algorithm_t h = hash_alg ? hash_to_psa(hash_alg) : PSA_ALG_ANY_HASH;
            psa_alg = PSA_ALG_ECDSA(h);
        } else {
            psa_alg = PSA_ALG_ECDH;
        }
    }
    else if (str_eq_nocase(alg_name, "Ed25519")) {
        alg_id = ALG_ED25519;
        key_bits_hint = 255;
        psa_alg = PSA_ALG_PURE_EDDSA;
        if (strcmp(format, "pkcs8") == 0 || strcmp(format, "raw") == 0)
            key_type = PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_TWISTED_EDWARDS);
        else
            key_type = PSA_KEY_TYPE_ECC_PUBLIC_KEY(PSA_ECC_FAMILY_TWISTED_EDWARDS);
    }
    else if (str_eq_nocase(alg_name, "X25519")) {
        alg_id = ALG_X25519;
        key_bits_hint = 255;
        psa_alg = PSA_ALG_ECDH;
        if (strcmp(format, "pkcs8") == 0 || strcmp(format, "raw") == 0)
            key_type = PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_MONTGOMERY);
        else
            key_type = PSA_KEY_TYPE_ECC_PUBLIC_KEY(PSA_ECC_FAMILY_MONTGOMERY);
    }
    else if (str_eq_nocase(alg_name, "HKDF")) {
        alg_id = ALG_HKDF;
        hash_alg = get_hash_from_algorithm(ctx, alg_obj);
        key_type = PSA_KEY_TYPE_DERIVE;
        psa_alg = PSA_ALG_HKDF(hash_alg ? hash_to_psa(hash_alg) : PSA_ALG_SHA_256);
    }
    else if (str_eq_nocase(alg_name, "PBKDF2")) {
        alg_id = ALG_PBKDF2;
        hash_alg = get_hash_from_algorithm(ctx, alg_obj);
        key_type = PSA_KEY_TYPE_PASSWORD;
        psa_alg = PSA_ALG_PBKDF2_HMAC(hash_alg ? hash_to_psa(hash_alg) : PSA_ALG_SHA_256);
    }
    else {
        JS_FreeCString(ctx, format); JS_FreeCString(ctx, alg_name);
        if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
        if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);
        return new_rejected_promise(ctx, "Unsupported algorithm for importKey");
    }

    /* Set up PSA attributes and import */
    psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
    psa_set_key_type(&attributes, key_type);
    psa_set_key_algorithm(&attributes, psa_alg);
    uint32_t uf = usage_flags;
    if (extractable) uf |= PSA_KEY_USAGE_EXPORT;
    psa_set_key_usage_flags(&attributes, uf);
    if (key_bits_hint > 0)
        psa_set_key_bits(&attributes, key_bits_hint);

    psa_key_id_t key_id = 0;
    psa_status_t status = psa_import_key(&attributes, data, data_len, &key_id);
    if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);

    if (status != PSA_SUCCESS) {
        JS_FreeCString(ctx, format); JS_FreeCString(ctx, alg_name);
        if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
        if (curve_name) js_free(ctx, curve_name);
        char errbuf[128];
        snprintf(errbuf, sizeof(errbuf), "importKey failed (PSA error %d)", (int)status);
        return new_rejected_promise(ctx, errbuf);
    }

    /* Read back actual attributes */
    psa_key_attributes_t ka = PSA_KEY_ATTRIBUTES_INIT;
    psa_get_key_attributes(key_id, &ka);
    psa_key_type_t actual_type = psa_get_key_type(&ka);
    size_t actual_bits = psa_get_key_bits(&ka);
    psa_reset_key_attributes(&ka);

    CryptoKeyData *kd = js_mallocz(ctx, sizeof(CryptoKeyData));
    kd->key_id = key_id;
    kd->algorithm = alg_id;
    size_t nlen = strlen(alg_name);
    kd->alg_name = js_malloc(ctx, nlen + 1);
    memcpy(kd->alg_name, alg_name, nlen + 1);
    kd->extractable = extractable;
    kd->psa_usage_flags = usage_flags;
    kd->psa_alg = psa_alg;
    kd->key_type = actual_type;
    kd->key_bits = actual_bits;
    kd->hash_alg = hash_alg;
    kd->named_curve = curve_name;
    kd->usages_array = usages_from_flags(ctx, usage_flags);

    JS_FreeCString(ctx, format);
    JS_FreeCString(ctx, alg_name);
    if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);

    JSValue key_obj = make_cryptokey(ctx, kd);
    JSValue result = new_resolved_promise(ctx, key_obj);
    JS_FreeValue(ctx, key_obj);
    return result;
}

/* ================================================================
 * SubtleCrypto.exportKey(format, key)
 * Supported formats: "raw", "pkcs8", "spki"
 * ================================================================ */

static JSValue js_subtle_exportKey(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    if (argc < 2)
        return new_rejected_promise(ctx, "exportKey requires 2 arguments");

    const char *format = JS_ToCString(ctx, argv[0]);
    if (!format) return new_rejected_promise(ctx, "Invalid format");

    CryptoKeyData *kd = (CryptoKeyData *)JS_GetOpaque(argv[1], js_cryptokey_class_id);
    if (!kd) {
        JS_FreeCString(ctx, format);
        return new_rejected_promise(ctx, "Second argument must be a CryptoKey");
    }

    if (!kd->extractable) {
        JS_FreeCString(ctx, format);
        return new_rejected_promise(ctx, "Key is not extractable");
    }

    uint8_t buf[4096]; /* enough for most keys */
    size_t out_len = 0;
    psa_status_t status;

    if (strcmp(format, "raw") == 0) {
        status = psa_export_key(kd->key_id, buf, sizeof(buf), &out_len);
    } else if (strcmp(format, "spki") == 0) {
        status = psa_export_public_key(kd->key_id, buf, sizeof(buf), &out_len);
    } else if (strcmp(format, "pkcs8") == 0) {
        status = psa_export_key(kd->key_id, buf, sizeof(buf), &out_len);
    } else {
        JS_FreeCString(ctx, format);
        return new_rejected_promise(ctx, "Unsupported export format (use 'raw', 'pkcs8', or 'spki')");
    }

    JS_FreeCString(ctx, format);

    if (status != PSA_SUCCESS) {
        char errbuf[128];
        snprintf(errbuf, sizeof(errbuf), "exportKey failed (PSA error %d)", (int)status);
        return new_rejected_promise(ctx, errbuf);
    }

    JSValue ab = JS_NewArrayBufferCopy(ctx, buf, out_len);
    JSValue result = new_resolved_promise(ctx, ab);
    JS_FreeValue(ctx, ab);
    return result;
}

/* ================================================================
 * SubtleCrypto.sign(algorithm, key, data)
 * ================================================================ */

static JSValue js_subtle_sign(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    if (argc < 3)
        return new_rejected_promise(ctx, "sign requires 3 arguments");

    CryptoKeyData *kd = (CryptoKeyData *)JS_GetOpaque(argv[1], js_cryptokey_class_id);
    if (!kd) return new_rejected_promise(ctx, "Second argument must be a CryptoKey");

    size_t data_len;
    JSValue data_free;
    uint8_t *data = get_buffer_data(ctx, argv[2], &data_len, &data_free);
    if (!data) {
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        return new_rejected_promise(ctx, "Invalid data for sign");
    }

    /* Determine PSA algorithm to use.
     * For ECDSA/RSA: the sign() algorithm param may specify the hash
     * (e.g. { name: 'ECDSA', hash: 'SHA-256' }). If the key was generated
     * with ANY_HASH wildcard, we need to construct the concrete algorithm. */
    psa_algorithm_t sign_alg = kd->psa_alg;
    {
        JSValue alg_param = argv[0];
        int h = 0;
        if (JS_IsObject(alg_param))
            h = get_hash_from_algorithm(ctx, alg_param);
        if (h && (kd->algorithm == ALG_ECDSA || kd->algorithm == ALG_RSASSA_PKCS1_V1_5 || kd->algorithm == ALG_RSA_PSS)) {
            psa_algorithm_t ph = hash_to_psa(h);
            switch (kd->algorithm) {
            case ALG_ECDSA:              sign_alg = PSA_ALG_ECDSA(ph); break;
            case ALG_RSASSA_PKCS1_V1_5:  sign_alg = PSA_ALG_RSA_PKCS1V15_SIGN(ph); break;
            case ALG_RSA_PSS:            sign_alg = PSA_ALG_RSA_PSS(ph); break;
            }
        }
    }

    uint8_t sig_buf[PSA_SIGNATURE_MAX_SIZE];
    size_t sig_len = 0;
    psa_status_t status;

    /* HMAC uses MAC operations, not signature operations */
    if (kd->algorithm == ALG_HMAC) {
        uint8_t mac_buf[PSA_MAC_MAX_SIZE];
        size_t mac_len = 0;
        status = psa_mac_compute(kd->key_id, sign_alg,
                                  data, data_len,
                                  mac_buf, sizeof(mac_buf), &mac_len);
        if (status == PSA_SUCCESS) {
            memcpy(sig_buf, mac_buf, mac_len);
            sig_len = mac_len;
        }
    } else {
        /* Use sign_message for algorithms that hash internally */
        status = psa_sign_message(kd->key_id, sign_alg,
                                   data, data_len,
                                   sig_buf, sizeof(sig_buf), &sig_len);
    }

    if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);

    if (status != PSA_SUCCESS) {
        char errbuf[128];
        snprintf(errbuf, sizeof(errbuf), "sign failed (PSA error %d)", (int)status);
        return new_rejected_promise(ctx, errbuf);
    }

    JSValue ab = JS_NewArrayBufferCopy(ctx, sig_buf, sig_len);
    JSValue result = new_resolved_promise(ctx, ab);
    JS_FreeValue(ctx, ab);
    return result;
}

/* ================================================================
 * SubtleCrypto.verify(algorithm, key, signature, data)
 * ================================================================ */

static JSValue js_subtle_verify(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
    if (argc < 4)
        return new_rejected_promise(ctx, "verify requires 4 arguments");

    CryptoKeyData *kd = (CryptoKeyData *)JS_GetOpaque(argv[1], js_cryptokey_class_id);
    if (!kd) return new_rejected_promise(ctx, "Second argument must be a CryptoKey");

    size_t sig_len;
    JSValue sig_free;
    uint8_t *sig = get_buffer_data(ctx, argv[2], &sig_len, &sig_free);
    if (!sig) {
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        return new_rejected_promise(ctx, "Invalid signature data");
    }

    size_t data_len;
    JSValue data_free;
    uint8_t *data = get_buffer_data(ctx, argv[3], &data_len, &data_free);
    if (!data) {
        if (!JS_IsUndefined(sig_free)) JS_FreeValue(ctx, sig_free);
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        return new_rejected_promise(ctx, "Invalid data for verify");
    }

    psa_algorithm_t verify_alg = kd->psa_alg;
    /* Resolve concrete hash from algorithm param if needed */
    {
        JSValue alg_param = argv[0];
        int h = 0;
        if (JS_IsObject(alg_param))
            h = get_hash_from_algorithm(ctx, alg_param);
        if (h && (kd->algorithm == ALG_ECDSA || kd->algorithm == ALG_RSASSA_PKCS1_V1_5 || kd->algorithm == ALG_RSA_PSS)) {
            psa_algorithm_t ph = hash_to_psa(h);
            switch (kd->algorithm) {
            case ALG_ECDSA:              verify_alg = PSA_ALG_ECDSA(ph); break;
            case ALG_RSASSA_PKCS1_V1_5:  verify_alg = PSA_ALG_RSA_PKCS1V15_SIGN(ph); break;
            case ALG_RSA_PSS:            verify_alg = PSA_ALG_RSA_PSS(ph); break;
            }
        }
    }
    psa_status_t status;

    /* HMAC uses MAC verification, not signature verification */
    if (kd->algorithm == ALG_HMAC) {
        status = psa_mac_verify(kd->key_id, verify_alg,
                                 data, data_len,
                                 sig, sig_len);
    } else {
        status = psa_verify_message(kd->key_id, verify_alg,
                                     data, data_len,
                                     sig, sig_len);
    }

    if (!JS_IsUndefined(sig_free)) JS_FreeValue(ctx, sig_free);
    if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);

    JSValue bool_val = JS_NewBool(ctx, status == PSA_SUCCESS);
    JSValue result = new_resolved_promise(ctx, bool_val);
    JS_FreeValue(ctx, bool_val);
    return result;
}

/* ================================================================
 * SubtleCrypto.encrypt(algorithm, key, data)
 * Supports: AES-CBC, AES-CTR, AES-GCM, RSA-OAEP
 * ================================================================ */

static JSValue js_subtle_encrypt(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    if (argc < 3)
        return new_rejected_promise(ctx, "encrypt requires 3 arguments");

    CryptoKeyData *kd = (CryptoKeyData *)JS_GetOpaque(argv[1], js_cryptokey_class_id);
    if (!kd) return new_rejected_promise(ctx, "Second argument must be a CryptoKey");

    size_t data_len;
    JSValue data_free;
    uint8_t *data = get_buffer_data(ctx, argv[2], &data_len, &data_free);
    if (!data) {
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        return new_rejected_promise(ctx, "Invalid plaintext data");
    }

    JSValue alg_obj = argv[0];
    size_t out_max = data_len + 256; /* padding + tag overhead */
    uint8_t *out_buf = js_malloc(ctx, out_max);
    if (!out_buf) {
        if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);
        return new_rejected_promise(ctx, "Out of memory");
    }

    size_t out_len = 0;
    psa_status_t status;

    switch (kd->algorithm) {
    case ALG_AES_GCM: {
        /* Get IV/nonce */
        JSValue iv_val = JS_GetPropertyStr(ctx, alg_obj, "iv");
        size_t iv_len;
        JSValue iv_free;
        uint8_t *iv = get_buffer_data(ctx, iv_val, &iv_len, &iv_free);
        JS_FreeValue(ctx, iv_val);
        if (!iv) {
            js_free(ctx, out_buf);
            if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);
            JSValue exc = JS_GetException(ctx);
            JS_FreeValue(ctx, exc);
            return new_rejected_promise(ctx, "AES-GCM encrypt requires 'iv'");
        }

        /* Get optional additionalData */
        JSValue ad_val = JS_GetPropertyStr(ctx, alg_obj, "additionalData");
        uint8_t *ad = NULL;
        size_t ad_len = 0;
        JSValue ad_free = JS_UNDEFINED;
        if (!JS_IsUndefined(ad_val) && !JS_IsNull(ad_val)) {
            ad = get_buffer_data(ctx, ad_val, &ad_len, &ad_free);
        }
        JS_FreeValue(ctx, ad_val);

        /* tagLength (default 128 bits) */
        JSValue tl_val = JS_GetPropertyStr(ctx, alg_obj, "tagLength");
        uint32_t tag_bits = 128;
        if (!JS_IsUndefined(tl_val) && !JS_IsException(tl_val))
            JS_ToUint32(ctx, &tag_bits, tl_val);
        JS_FreeValue(ctx, tl_val);

        /* Use PSA AEAD */
        out_max = data_len + (tag_bits / 8) + 16;
        uint8_t *new_buf = js_realloc(ctx, out_buf, out_max);
        if (!new_buf) {
            js_free(ctx, out_buf);
            if (!JS_IsUndefined(iv_free)) JS_FreeValue(ctx, iv_free);
            if (!JS_IsUndefined(ad_free)) JS_FreeValue(ctx, ad_free);
            if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);
            return new_rejected_promise(ctx, "Out of memory");
        }
        out_buf = new_buf;

        status = psa_aead_encrypt(kd->key_id, PSA_ALG_GCM,
                                   iv, iv_len,
                                   ad, ad_len,
                                   data, data_len,
                                   out_buf, out_max, &out_len);

        if (!JS_IsUndefined(iv_free)) JS_FreeValue(ctx, iv_free);
        if (!JS_IsUndefined(ad_free)) JS_FreeValue(ctx, ad_free);
        break;
    }

    case ALG_AES_CBC: {
        JSValue iv_val = JS_GetPropertyStr(ctx, alg_obj, "iv");
        size_t iv_len;
        JSValue iv_free;
        uint8_t *iv = get_buffer_data(ctx, iv_val, &iv_len, &iv_free);
        JS_FreeValue(ctx, iv_val);
        if (!iv || iv_len != 16) {
            if (iv && !JS_IsUndefined(iv_free)) JS_FreeValue(ctx, iv_free);
            js_free(ctx, out_buf);
            if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);
            JSValue exc = JS_GetException(ctx);
            JS_FreeValue(ctx, exc);
            return new_rejected_promise(ctx, "AES-CBC requires a 16-byte 'iv'");
        }

        /* AES-CBC with PKCS7 padding */
        /* Manually add PKCS7 padding */
        size_t pad_len = 16 - (data_len % 16);
        size_t padded_len = data_len + pad_len;
        uint8_t *padded = js_malloc(ctx, padded_len);
        if (!padded) {
            if (!JS_IsUndefined(iv_free)) JS_FreeValue(ctx, iv_free);
            js_free(ctx, out_buf);
            if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);
            return new_rejected_promise(ctx, "Out of memory");
        }
        memcpy(padded, data, data_len);
        memset(padded + data_len, (uint8_t)pad_len, pad_len);

        /* Resize output buffer */
        uint8_t *new_buf = js_realloc(ctx, out_buf, padded_len + 16);
        if (!new_buf) {
            js_free(ctx, padded);
            if (!JS_IsUndefined(iv_free)) JS_FreeValue(ctx, iv_free);
            js_free(ctx, out_buf);
            if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);
            return new_rejected_promise(ctx, "Out of memory");
        }
        out_buf = new_buf;

        /* Use PSA cipher */
        psa_cipher_operation_t op = PSA_CIPHER_OPERATION_INIT;
        status = psa_cipher_encrypt_setup(&op, kd->key_id, PSA_ALG_CBC_NO_PADDING);
        if (status == PSA_SUCCESS)
            status = psa_cipher_set_iv(&op, iv, iv_len);
        size_t written = 0;
        if (status == PSA_SUCCESS)
            status = psa_cipher_update(&op, padded, padded_len,
                                        out_buf, padded_len + 16, &written);
        out_len = written;
        size_t finish_len = 0;
        if (status == PSA_SUCCESS)
            status = psa_cipher_finish(&op, out_buf + out_len,
                                        padded_len + 16 - out_len, &finish_len);
        out_len += finish_len;
        if (status != PSA_SUCCESS) psa_cipher_abort(&op);

        js_free(ctx, padded);
        if (!JS_IsUndefined(iv_free)) JS_FreeValue(ctx, iv_free);
        break;
    }

    case ALG_AES_CTR: {
        JSValue ctr_val = JS_GetPropertyStr(ctx, alg_obj, "counter");
        size_t ctr_len;
        JSValue ctr_free;
        uint8_t *ctr = get_buffer_data(ctx, ctr_val, &ctr_len, &ctr_free);
        JS_FreeValue(ctx, ctr_val);
        if (!ctr || ctr_len != 16) {
            if (ctr && !JS_IsUndefined(ctr_free)) JS_FreeValue(ctx, ctr_free);
            js_free(ctx, out_buf);
            if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);
            JSValue exc = JS_GetException(ctx);
            JS_FreeValue(ctx, exc);
            return new_rejected_promise(ctx, "AES-CTR requires a 16-byte 'counter'");
        }

        psa_cipher_operation_t op = PSA_CIPHER_OPERATION_INIT;
        status = psa_cipher_encrypt_setup(&op, kd->key_id, PSA_ALG_CTR);
        if (status == PSA_SUCCESS)
            status = psa_cipher_set_iv(&op, ctr, ctr_len);
        size_t written = 0;
        if (status == PSA_SUCCESS)
            status = psa_cipher_update(&op, data, data_len,
                                        out_buf, out_max, &written);
        out_len = written;
        size_t finish_len = 0;
        if (status == PSA_SUCCESS)
            status = psa_cipher_finish(&op, out_buf + out_len,
                                        out_max - out_len, &finish_len);
        out_len += finish_len;
        if (status != PSA_SUCCESS) psa_cipher_abort(&op);

        if (!JS_IsUndefined(ctr_free)) JS_FreeValue(ctx, ctr_free);
        break;
    }

    case ALG_RSA_OAEP: {
        /* Get optional label */
        JSValue label_val = JS_GetPropertyStr(ctx, alg_obj, "label");
        uint8_t *label = NULL;
        size_t label_len = 0;
        JSValue label_free = JS_UNDEFINED;
        if (!JS_IsUndefined(label_val) && !JS_IsNull(label_val))
            label = get_buffer_data(ctx, label_val, &label_len, &label_free);
        JS_FreeValue(ctx, label_val);

        (void)label; (void)label_len; /* PSA OAEP does not support custom label directly */

        /* RSA OAEP encrypt */
        out_max = kd->key_bits / 8 + 64;
        uint8_t *new_buf = js_realloc(ctx, out_buf, out_max);
        if (new_buf) out_buf = new_buf;

        status = psa_asymmetric_encrypt(kd->key_id, kd->psa_alg,
                                         data, data_len,
                                         NULL, 0,
                                         out_buf, out_max, &out_len);

        if (!JS_IsUndefined(label_free)) JS_FreeValue(ctx, label_free);
        break;
    }

    default:
        js_free(ctx, out_buf);
        if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);
        return new_rejected_promise(ctx, "Unsupported algorithm for encrypt");
    }

    if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);

    if (status != PSA_SUCCESS) {
        js_free(ctx, out_buf);
        char errbuf[128];
        snprintf(errbuf, sizeof(errbuf), "encrypt failed (PSA error %d)", (int)status);
        return new_rejected_promise(ctx, errbuf);
    }

    JSValue ab = JS_NewArrayBufferCopy(ctx, out_buf, out_len);
    js_free(ctx, out_buf);
    JSValue result = new_resolved_promise(ctx, ab);
    JS_FreeValue(ctx, ab);
    return result;
}

/* ================================================================
 * SubtleCrypto.decrypt(algorithm, key, data)
 * ================================================================ */

static JSValue js_subtle_decrypt(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    if (argc < 3)
        return new_rejected_promise(ctx, "decrypt requires 3 arguments");

    CryptoKeyData *kd = (CryptoKeyData *)JS_GetOpaque(argv[1], js_cryptokey_class_id);
    if (!kd) return new_rejected_promise(ctx, "Second argument must be a CryptoKey");

    size_t data_len;
    JSValue data_free;
    uint8_t *data = get_buffer_data(ctx, argv[2], &data_len, &data_free);
    if (!data) {
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        return new_rejected_promise(ctx, "Invalid ciphertext data");
    }

    JSValue alg_obj = argv[0];
    size_t out_max = data_len + 256;
    uint8_t *out_buf = js_malloc(ctx, out_max);
    if (!out_buf) {
        if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);
        return new_rejected_promise(ctx, "Out of memory");
    }

    size_t out_len = 0;
    psa_status_t status;

    switch (kd->algorithm) {
    case ALG_AES_GCM: {
        JSValue iv_val = JS_GetPropertyStr(ctx, alg_obj, "iv");
        size_t iv_len;
        JSValue iv_free;
        uint8_t *iv = get_buffer_data(ctx, iv_val, &iv_len, &iv_free);
        JS_FreeValue(ctx, iv_val);
        if (!iv) {
            js_free(ctx, out_buf);
            if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);
            JSValue exc = JS_GetException(ctx);
            JS_FreeValue(ctx, exc);
            return new_rejected_promise(ctx, "AES-GCM decrypt requires 'iv'");
        }

        JSValue ad_val = JS_GetPropertyStr(ctx, alg_obj, "additionalData");
        uint8_t *ad = NULL;
        size_t ad_len = 0;
        JSValue ad_free = JS_UNDEFINED;
        if (!JS_IsUndefined(ad_val) && !JS_IsNull(ad_val))
            ad = get_buffer_data(ctx, ad_val, &ad_len, &ad_free);
        JS_FreeValue(ctx, ad_val);

        status = psa_aead_decrypt(kd->key_id, PSA_ALG_GCM,
                                   iv, iv_len,
                                   ad, ad_len,
                                   data, data_len,
                                   out_buf, out_max, &out_len);

        if (!JS_IsUndefined(iv_free)) JS_FreeValue(ctx, iv_free);
        if (!JS_IsUndefined(ad_free)) JS_FreeValue(ctx, ad_free);
        break;
    }

    case ALG_AES_CBC: {
        JSValue iv_val = JS_GetPropertyStr(ctx, alg_obj, "iv");
        size_t iv_len;
        JSValue iv_free;
        uint8_t *iv = get_buffer_data(ctx, iv_val, &iv_len, &iv_free);
        JS_FreeValue(ctx, iv_val);
        if (!iv || iv_len != 16) {
            if (iv && !JS_IsUndefined(iv_free)) JS_FreeValue(ctx, iv_free);
            js_free(ctx, out_buf);
            if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);
            JSValue exc = JS_GetException(ctx);
            JS_FreeValue(ctx, exc);
            return new_rejected_promise(ctx, "AES-CBC decrypt requires a 16-byte 'iv'");
        }

        psa_cipher_operation_t op = PSA_CIPHER_OPERATION_INIT;
        status = psa_cipher_decrypt_setup(&op, kd->key_id, PSA_ALG_CBC_NO_PADDING);
        if (status == PSA_SUCCESS)
            status = psa_cipher_set_iv(&op, iv, iv_len);
        size_t written = 0;
        if (status == PSA_SUCCESS)
            status = psa_cipher_update(&op, data, data_len,
                                        out_buf, out_max, &written);
        out_len = written;
        size_t finish_len = 0;
        if (status == PSA_SUCCESS)
            status = psa_cipher_finish(&op, out_buf + out_len,
                                        out_max - out_len, &finish_len);
        out_len += finish_len;
        if (status != PSA_SUCCESS) { psa_cipher_abort(&op); break; }

        /* Remove PKCS7 padding */
        if (out_len > 0) {
            uint8_t pad_byte = out_buf[out_len - 1];
            if (pad_byte >= 1 && pad_byte <= 16 && pad_byte <= out_len) {
                int valid = 1;
                for (size_t i = 0; i < pad_byte; i++) {
                    if (out_buf[out_len - 1 - i] != pad_byte) { valid = 0; break; }
                }
                if (valid) out_len -= pad_byte;
            }
        }

        if (!JS_IsUndefined(iv_free)) JS_FreeValue(ctx, iv_free);
        break;
    }

    case ALG_AES_CTR: {
        JSValue ctr_val = JS_GetPropertyStr(ctx, alg_obj, "counter");
        size_t ctr_len;
        JSValue ctr_free;
        uint8_t *ctr = get_buffer_data(ctx, ctr_val, &ctr_len, &ctr_free);
        JS_FreeValue(ctx, ctr_val);
        if (!ctr || ctr_len != 16) {
            if (ctr && !JS_IsUndefined(ctr_free)) JS_FreeValue(ctx, ctr_free);
            js_free(ctx, out_buf);
            if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);
            JSValue exc = JS_GetException(ctx);
            JS_FreeValue(ctx, exc);
            return new_rejected_promise(ctx, "AES-CTR decrypt requires a 16-byte 'counter'");
        }

        psa_cipher_operation_t op = PSA_CIPHER_OPERATION_INIT;
        status = psa_cipher_decrypt_setup(&op, kd->key_id, PSA_ALG_CTR);
        if (status == PSA_SUCCESS)
            status = psa_cipher_set_iv(&op, ctr, ctr_len);
        size_t written = 0;
        if (status == PSA_SUCCESS)
            status = psa_cipher_update(&op, data, data_len,
                                        out_buf, out_max, &written);
        out_len = written;
        size_t finish_len = 0;
        if (status == PSA_SUCCESS)
            status = psa_cipher_finish(&op, out_buf + out_len,
                                        out_max - out_len, &finish_len);
        out_len += finish_len;
        if (status != PSA_SUCCESS) psa_cipher_abort(&op);

        if (!JS_IsUndefined(ctr_free)) JS_FreeValue(ctx, ctr_free);
        break;
    }

    case ALG_RSA_OAEP: {
        out_max = kd->key_bits / 8 + 64;
        uint8_t *new_buf = js_realloc(ctx, out_buf, out_max);
        if (new_buf) out_buf = new_buf;

        status = psa_asymmetric_decrypt(kd->key_id, kd->psa_alg,
                                         data, data_len,
                                         NULL, 0,
                                         out_buf, out_max, &out_len);
        break;
    }

    default:
        js_free(ctx, out_buf);
        if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);
        return new_rejected_promise(ctx, "Unsupported algorithm for decrypt");
    }

    if (!JS_IsUndefined(data_free)) JS_FreeValue(ctx, data_free);

    if (status != PSA_SUCCESS) {
        js_free(ctx, out_buf);
        char errbuf[128];
        snprintf(errbuf, sizeof(errbuf), "decrypt failed (PSA error %d)", (int)status);
        return new_rejected_promise(ctx, errbuf);
    }

    JSValue ab = JS_NewArrayBufferCopy(ctx, out_buf, out_len);
    js_free(ctx, out_buf);
    JSValue result = new_resolved_promise(ctx, ab);
    JS_FreeValue(ctx, ab);
    return result;
}

/* ================================================================
 * SubtleCrypto.deriveBits(algorithm, baseKey, length)
 * Supports: HKDF, PBKDF2, ECDH, X25519
 * ================================================================ */

static JSValue js_subtle_deriveBits(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv) {
    if (argc < 3)
        return new_rejected_promise(ctx, "deriveBits requires 3 arguments");

    CryptoKeyData *kd = (CryptoKeyData *)JS_GetOpaque(argv[1], js_cryptokey_class_id);
    if (!kd) return new_rejected_promise(ctx, "Second argument must be a CryptoKey");

    uint32_t length_bits = 0;
    JS_ToUint32(ctx, &length_bits, argv[2]);
    if (length_bits == 0 || (length_bits % 8) != 0)
        return new_rejected_promise(ctx, "deriveBits length must be a positive multiple of 8");
    size_t length_bytes = length_bits / 8;

    JSValue alg_obj = argv[0];
    JSValue free_val;
    const char *alg_name = get_algorithm_name(ctx, alg_obj, &free_val);
    if (!alg_name) {
        JSValue exc = JS_GetException(ctx); JS_FreeValue(ctx, exc);
        return new_rejected_promise(ctx, "Invalid algorithm");
    }

    uint8_t *out_buf = js_malloc(ctx, length_bytes);
    if (!out_buf) {
        JS_FreeCString(ctx, alg_name);
        if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
        return new_rejected_promise(ctx, "Out of memory");
    }

    psa_status_t status = PSA_ERROR_NOT_SUPPORTED;

    if (str_eq_nocase(alg_name, "HKDF")) {
        /* Use the key's stored algorithm (which includes the correct hash) */
        psa_algorithm_t kdf_alg = kd->psa_alg;

        JSValue salt_val = JS_GetPropertyStr(ctx, alg_obj, "salt");
        uint8_t *salt = NULL; size_t salt_len = 0; JSValue sf = JS_UNDEFINED;
        if (!JS_IsUndefined(salt_val) && !JS_IsNull(salt_val))
            salt = get_buffer_data(ctx, salt_val, &salt_len, &sf);
        JS_FreeValue(ctx, salt_val);

        JSValue info_val = JS_GetPropertyStr(ctx, alg_obj, "info");
        uint8_t *info = NULL; size_t info_len = 0; JSValue inf = JS_UNDEFINED;
        if (!JS_IsUndefined(info_val) && !JS_IsNull(info_val))
            info = get_buffer_data(ctx, info_val, &info_len, &inf);
        JS_FreeValue(ctx, info_val);

        psa_key_derivation_operation_t op = PSA_KEY_DERIVATION_OPERATION_INIT;
        status = psa_key_derivation_setup(&op, kdf_alg);
        if (status == PSA_SUCCESS && salt && salt_len > 0)
            status = psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_SALT, salt, salt_len);
        if (status == PSA_SUCCESS)
            status = psa_key_derivation_input_key(&op, PSA_KEY_DERIVATION_INPUT_SECRET, kd->key_id);
        /* INFO step is always required for HKDF, even if empty */
        if (status == PSA_SUCCESS)
            status = psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_INFO,
                                                     info ? info : (const uint8_t *)"", info_len);
        if (status == PSA_SUCCESS)
            status = psa_key_derivation_output_bytes(&op, out_buf, length_bytes);
        psa_key_derivation_abort(&op);

        if (!JS_IsUndefined(sf)) JS_FreeValue(ctx, sf);
        if (!JS_IsUndefined(inf)) JS_FreeValue(ctx, inf);
    }
    else if (str_eq_nocase(alg_name, "PBKDF2")) {
        /* Use the key's stored algorithm (which includes the correct hash) */
        psa_algorithm_t kdf_alg = kd->psa_alg;

        JSValue salt_val = JS_GetPropertyStr(ctx, alg_obj, "salt");
        uint8_t *salt = NULL; size_t salt_len = 0; JSValue sf = JS_UNDEFINED;
        if (!JS_IsUndefined(salt_val) && !JS_IsNull(salt_val))
            salt = get_buffer_data(ctx, salt_val, &salt_len, &sf);
        JS_FreeValue(ctx, salt_val);

        JSValue iv = JS_GetPropertyStr(ctx, alg_obj, "iterations");
        uint32_t iters = 1;
        if (!JS_IsUndefined(iv)) JS_ToUint32(ctx, &iters, iv);
        JS_FreeValue(ctx, iv);

        psa_key_derivation_operation_t op = PSA_KEY_DERIVATION_OPERATION_INIT;
        status = psa_key_derivation_setup(&op, kdf_alg);
        if (status == PSA_SUCCESS)
            status = psa_key_derivation_input_integer(&op, PSA_KEY_DERIVATION_INPUT_COST, (uint64_t)iters);
        if (status == PSA_SUCCESS && salt && salt_len > 0)
            status = psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_SALT, salt, salt_len);
        if (status == PSA_SUCCESS)
            status = psa_key_derivation_input_key(&op, PSA_KEY_DERIVATION_INPUT_PASSWORD, kd->key_id);
        if (status == PSA_SUCCESS)
            status = psa_key_derivation_output_bytes(&op, out_buf, length_bytes);
        psa_key_derivation_abort(&op);

        if (!JS_IsUndefined(sf)) JS_FreeValue(ctx, sf);
    }
    else if (str_eq_nocase(alg_name, "ECDH") || str_eq_nocase(alg_name, "X25519")) {
        JSValue pub_val = JS_GetPropertyStr(ctx, alg_obj, "public");
        CryptoKeyData *pub_kd = (CryptoKeyData *)JS_GetOpaque(pub_val, js_cryptokey_class_id);
        JS_FreeValue(ctx, pub_val);
        if (!pub_kd) {
            js_free(ctx, out_buf);
            JS_FreeCString(ctx, alg_name);
            if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
            return new_rejected_promise(ctx, "ECDH/X25519 deriveBits requires 'public' CryptoKey");
        }
        uint8_t peer[PSA_EXPORT_PUBLIC_KEY_MAX_SIZE];
        size_t peer_len = 0;
        status = psa_export_public_key(pub_kd->key_id, peer, sizeof(peer), &peer_len);
        if (status == PSA_SUCCESS) {
            size_t shared_len = 0;
            status = psa_raw_key_agreement(PSA_ALG_ECDH, kd->key_id,
                                            peer, peer_len, out_buf, length_bytes, &shared_len);
        }
    }
    else {
        js_free(ctx, out_buf);
        JS_FreeCString(ctx, alg_name);
        if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);
        return new_rejected_promise(ctx, "Unsupported algorithm for deriveBits");
    }

    JS_FreeCString(ctx, alg_name);
    if (!JS_IsUndefined(free_val)) JS_FreeValue(ctx, free_val);

    if (status != PSA_SUCCESS) {
        js_free(ctx, out_buf);
        char errbuf[128];
        snprintf(errbuf, sizeof(errbuf), "deriveBits failed (PSA error %d)", (int)status);
        return new_rejected_promise(ctx, errbuf);
    }

    JSValue ab = JS_NewArrayBufferCopy(ctx, out_buf, length_bytes);
    js_free(ctx, out_buf);
    JSValue result2 = new_resolved_promise(ctx, ab);
    JS_FreeValue(ctx, ab);
    return result2;
}

/* ================================================================
 * SubtleCrypto.deriveKey(algorithm, baseKey, derivedKeyType, extractable, keyUsages)
 * ================================================================ */

static JSValue js_subtle_deriveKey(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    if (argc < 5)
        return new_rejected_promise(ctx, "deriveKey requires 5 arguments");

    /* Determine derived key length from derivedKeyType.length or hash */
    JSValue dkt = argv[2];
    JSValue len_val = JS_GetPropertyStr(ctx, dkt, "length");
    uint32_t derived_bits = 0;
    if (!JS_IsUndefined(len_val) && !JS_IsException(len_val))
        JS_ToUint32(ctx, &derived_bits, len_val);
    JS_FreeValue(ctx, len_val);
    if (derived_bits == 0) {
        int h = get_hash_from_algorithm(ctx, dkt);
        if (h) derived_bits = (uint32_t)(PSA_HASH_LENGTH(hash_to_psa(h)) * 8);
        else derived_bits = 256;
    }

    /* deriveBits then importKey */
    JSValue bits_len = JS_NewUint32(ctx, derived_bits);
    JSValue db_args[3] = { argv[0], argv[1], bits_len };
    JSValue bits_result = js_subtle_deriveBits(ctx, this_val, 3, db_args);
    JS_FreeValue(ctx, bits_len);

    /* Extract the ArrayBuffer from the resolved promise.
     * Since our implementation is synchronous, we can use a .then() approach,
     * but it's simpler to just re-derive synchronously and importKey. */

    /* For now, chain via Promise.then. Build a callback that calls importKey. */
    /* Actually, simplest: just do deriveBits again synchronously, get raw bytes, importKey */
    /* But our deriveBits already returns a promise. Let's just chain: */

    /* Use the deriveBits raw bytes directly. We need to redo the derivation to get raw. */
    /* Better approach: return bits_result.then(buf => importKey("raw", buf, ...)) */

    /* Build a JS function that does the import */
    /* For simplicity and correctness, use JS-level promise chaining */

    JS_FreeValue(ctx, bits_result);

    /* Redo: derive raw bytes synchronously */
    CryptoKeyData *base_kd = (CryptoKeyData *)JS_GetOpaque(argv[1], js_cryptokey_class_id);
    if (!base_kd) return new_rejected_promise(ctx, "baseKey must be a CryptoKey");

    size_t len_bytes = derived_bits / 8;
    uint8_t *raw = js_malloc(ctx, len_bytes);
    if (!raw) return new_rejected_promise(ctx, "Out of memory");

    JSValue fv;
    const char *an = get_algorithm_name(ctx, argv[0], &fv);
    if (!an) { js_free(ctx, raw); JSValue e = JS_GetException(ctx); JS_FreeValue(ctx, e); return new_rejected_promise(ctx, "Invalid alg"); }

    psa_status_t st = PSA_ERROR_NOT_SUPPORTED;
    if (str_eq_nocase(an, "HKDF")) {
        int h = get_hash_from_algorithm(ctx, argv[0]);
        psa_algorithm_t ph = h ? hash_to_psa(h) : PSA_ALG_SHA_256;
        JSValue sv = JS_GetPropertyStr(ctx, argv[0], "salt");
        uint8_t *sa = NULL; size_t sl = 0; JSValue sff = JS_UNDEFINED;
        if (!JS_IsUndefined(sv) && !JS_IsNull(sv)) sa = get_buffer_data(ctx, sv, &sl, &sff);
        JS_FreeValue(ctx, sv);
        JSValue iv2 = JS_GetPropertyStr(ctx, argv[0], "info");
        uint8_t *inf2 = NULL; size_t il = 0; JSValue iff = JS_UNDEFINED;
        if (!JS_IsUndefined(iv2) && !JS_IsNull(iv2)) inf2 = get_buffer_data(ctx, iv2, &il, &iff);
        JS_FreeValue(ctx, iv2);

        psa_key_derivation_operation_t op = PSA_KEY_DERIVATION_OPERATION_INIT;
        st = psa_key_derivation_setup(&op, PSA_ALG_HKDF(ph));
        if (st == PSA_SUCCESS && sa && sl > 0)
            st = psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_SALT, sa, sl);
        if (st == PSA_SUCCESS)
            st = psa_key_derivation_input_key(&op, PSA_KEY_DERIVATION_INPUT_SECRET, base_kd->key_id);
        if (st == PSA_SUCCESS && inf2 && il > 0)
            st = psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_INFO, inf2, il);
        if (st == PSA_SUCCESS)
            st = psa_key_derivation_output_bytes(&op, raw, len_bytes);
        psa_key_derivation_abort(&op);
        if (!JS_IsUndefined(sff)) JS_FreeValue(ctx, sff);
        if (!JS_IsUndefined(iff)) JS_FreeValue(ctx, iff);
    } else if (str_eq_nocase(an, "PBKDF2")) {
        int h = get_hash_from_algorithm(ctx, argv[0]);
        psa_algorithm_t ph = h ? hash_to_psa(h) : PSA_ALG_SHA_256;
        JSValue sv = JS_GetPropertyStr(ctx, argv[0], "salt");
        uint8_t *sa = NULL; size_t sl = 0; JSValue sff = JS_UNDEFINED;
        if (!JS_IsUndefined(sv) && !JS_IsNull(sv)) sa = get_buffer_data(ctx, sv, &sl, &sff);
        JS_FreeValue(ctx, sv);
        JSValue itv = JS_GetPropertyStr(ctx, argv[0], "iterations");
        uint32_t it = 1; if (!JS_IsUndefined(itv)) JS_ToUint32(ctx, &it, itv);
        JS_FreeValue(ctx, itv);

        psa_key_derivation_operation_t op = PSA_KEY_DERIVATION_OPERATION_INIT;
        st = psa_key_derivation_setup(&op, PSA_ALG_PBKDF2_HMAC(ph));
        if (st == PSA_SUCCESS) st = psa_key_derivation_input_integer(&op, PSA_KEY_DERIVATION_INPUT_COST, it);
        if (st == PSA_SUCCESS && sa && sl > 0)
            st = psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_SALT, sa, sl);
        if (st == PSA_SUCCESS)
            st = psa_key_derivation_input_key(&op, PSA_KEY_DERIVATION_INPUT_PASSWORD, base_kd->key_id);
        if (st == PSA_SUCCESS) st = psa_key_derivation_output_bytes(&op, raw, len_bytes);
        psa_key_derivation_abort(&op);
        if (!JS_IsUndefined(sff)) JS_FreeValue(ctx, sff);
    }
    JS_FreeCString(ctx, an);
    if (!JS_IsUndefined(fv)) JS_FreeValue(ctx, fv);

    if (st != PSA_SUCCESS) {
        js_free(ctx, raw);
        char eb[128]; snprintf(eb, sizeof(eb), "deriveKey failed (PSA error %d)", (int)st);
        return new_rejected_promise(ctx, eb);
    }

    JSValue raw_ab = JS_NewArrayBufferCopy(ctx, raw, len_bytes);
    js_free(ctx, raw);
    JSValue fmt = JS_NewString(ctx, "raw");
    JSValue ia[5] = { fmt, raw_ab, argv[2], argv[3], argv[4] };
    JSValue r = js_subtle_importKey(ctx, this_val, 5, ia);
    JS_FreeValue(ctx, fmt);
    JS_FreeValue(ctx, raw_ab);
    return r;
}

/* ================================================================
 * SubtleCrypto.wrapKey(format, key, wrappingKey, wrapAlgorithm)
 * Implemented as: exportKey + encrypt
 * ================================================================ */

static JSValue js_subtle_wrapKey(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    if (argc < 4)
        return new_rejected_promise(ctx, "wrapKey requires 4 arguments");

    /* Step 1: Export the key */
    JSValue export_args[2] = { argv[0], argv[1] };
    /* We call exportKey synchronously (it returns a resolved promise).
     * Extract the ArrayBuffer from the result. */
    CryptoKeyData *key_kd = (CryptoKeyData *)JS_GetOpaque(argv[1], js_cryptokey_class_id);
    if (!key_kd) return new_rejected_promise(ctx, "Second argument must be a CryptoKey");
    if (!key_kd->extractable)
        return new_rejected_promise(ctx, "Key is not extractable");

    const char *format = JS_ToCString(ctx, argv[0]);
    if (!format) return new_rejected_promise(ctx, "Invalid format");

    uint8_t exp_buf[4096];
    size_t exp_len = 0;
    psa_status_t status;

    if (strcmp(format, "raw") == 0)
        status = psa_export_key(key_kd->key_id, exp_buf, sizeof(exp_buf), &exp_len);
    else if (strcmp(format, "spki") == 0)
        status = psa_export_public_key(key_kd->key_id, exp_buf, sizeof(exp_buf), &exp_len);
    else if (strcmp(format, "pkcs8") == 0)
        status = psa_export_key(key_kd->key_id, exp_buf, sizeof(exp_buf), &exp_len);
    else {
        JS_FreeCString(ctx, format);
        return new_rejected_promise(ctx, "Unsupported format for wrapKey");
    }
    JS_FreeCString(ctx, format);

    if (status != PSA_SUCCESS)
        return new_rejected_promise(ctx, "wrapKey: export failed");

    /* Step 2: Encrypt the exported key data */
    JSValue ab = JS_NewArrayBufferCopy(ctx, exp_buf, exp_len);
    JSValue enc_args[3] = { argv[3], argv[2], ab };
    JSValue result = js_subtle_encrypt(ctx, this_val, 3, enc_args);
    JS_FreeValue(ctx, ab);
    return result;
}

/* ================================================================
 * SubtleCrypto.unwrapKey(format, wrappedKey, unwrappingKey, unwrapAlgo,
 *                        unwrappedKeyAlgo, extractable, keyUsages)
 * Implemented as: decrypt + importKey
 * ================================================================ */

static JSValue js_subtle_unwrapKey(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    if (argc < 7)
        return new_rejected_promise(ctx, "unwrapKey requires 7 arguments");

    /* Step 1: Decrypt */
    /* decrypt(unwrapAlgo, unwrappingKey, wrappedKey) */
    CryptoKeyData *unwrap_kd = (CryptoKeyData *)JS_GetOpaque(argv[2], js_cryptokey_class_id);
    if (!unwrap_kd)
        return new_rejected_promise(ctx, "unwrappingKey must be a CryptoKey");

    /* Get wrapped key data */
    size_t wrapped_len;
    JSValue wrapped_free;
    uint8_t *wrapped = get_buffer_data(ctx, argv[1], &wrapped_len, &wrapped_free);
    if (!wrapped) {
        JSValue exc = JS_GetException(ctx); JS_FreeValue(ctx, exc);
        return new_rejected_promise(ctx, "Invalid wrappedKey data");
    }

    JSValue alg_obj = argv[3]; /* unwrapAlgorithm */

    /* Decrypt inline */
    size_t out_max = wrapped_len + 256;
    uint8_t *dec_buf = js_malloc(ctx, out_max);
    if (!dec_buf) {
        if (!JS_IsUndefined(wrapped_free)) JS_FreeValue(ctx, wrapped_free);
        return new_rejected_promise(ctx, "Out of memory");
    }

    size_t dec_len = 0;
    psa_status_t status = PSA_ERROR_NOT_SUPPORTED;

    switch (unwrap_kd->algorithm) {
    case ALG_AES_GCM: {
        JSValue iv_val = JS_GetPropertyStr(ctx, alg_obj, "iv");
        size_t iv_len; JSValue iv_free;
        uint8_t *iv2 = get_buffer_data(ctx, iv_val, &iv_len, &iv_free);
        JS_FreeValue(ctx, iv_val);

        JSValue ad_val = JS_GetPropertyStr(ctx, alg_obj, "additionalData");
        uint8_t *ad = NULL; size_t ad_len = 0; JSValue ad_free = JS_UNDEFINED;
        if (!JS_IsUndefined(ad_val) && !JS_IsNull(ad_val))
            ad = get_buffer_data(ctx, ad_val, &ad_len, &ad_free);
        JS_FreeValue(ctx, ad_val);

        if (iv2) {
            status = psa_aead_decrypt(unwrap_kd->key_id, PSA_ALG_GCM,
                                       iv2, iv_len, ad, ad_len,
                                       wrapped, wrapped_len,
                                       dec_buf, out_max, &dec_len);
        }
        if (iv2 && !JS_IsUndefined(iv_free)) JS_FreeValue(ctx, iv_free);
        if (!JS_IsUndefined(ad_free)) JS_FreeValue(ctx, ad_free);
        break;
    }
    case ALG_AES_KW:
    default: {
        /* For AES-KW or generic: use encrypt/decrypt. Fallback to direct cipher. */
        psa_cipher_operation_t op = PSA_CIPHER_OPERATION_INIT;
        status = psa_cipher_decrypt_setup(&op, unwrap_kd->key_id, unwrap_kd->psa_alg);
        size_t written = 0;
        if (status == PSA_SUCCESS)
            status = psa_cipher_update(&op, wrapped, wrapped_len, dec_buf, out_max, &written);
        dec_len = written;
        size_t fl = 0;
        if (status == PSA_SUCCESS)
            status = psa_cipher_finish(&op, dec_buf + dec_len, out_max - dec_len, &fl);
        dec_len += fl;
        if (status != PSA_SUCCESS) psa_cipher_abort(&op);
        break;
    }
    }

    if (!JS_IsUndefined(wrapped_free)) JS_FreeValue(ctx, wrapped_free);

    if (status != PSA_SUCCESS) {
        js_free(ctx, dec_buf);
        char errbuf[128];
        snprintf(errbuf, sizeof(errbuf), "unwrapKey decrypt failed (PSA error %d)", (int)status);
        return new_rejected_promise(ctx, errbuf);
    }

    /* Step 2: Import the decrypted key material */
    JSValue dec_ab = JS_NewArrayBufferCopy(ctx, dec_buf, dec_len);
    js_free(ctx, dec_buf);

    /* importKey(format, keyData, algorithm, extractable, keyUsages) */
    JSValue import_args[5] = { argv[0], dec_ab, argv[4], argv[5], argv[6] };
    JSValue result = js_subtle_importKey(ctx, this_val, 5, import_args);
    JS_FreeValue(ctx, dec_ab);
    return result;
}

/* ================================================================
 * SubtleCrypto class definition and methods
 * ================================================================ */

static JSClassDef js_subtle_class = {
    "SubtleCrypto",
};

static const JSCFunctionListEntry js_subtle_proto_funcs[] = {
    JS_CFUNC_DEF("digest", 2, js_subtle_digest),
    JS_CFUNC_DEF("generateKey", 3, js_subtle_generateKey),
    JS_CFUNC_DEF("importKey", 5, js_subtle_importKey),
    JS_CFUNC_DEF("exportKey", 2, js_subtle_exportKey),
    JS_CFUNC_DEF("sign", 3, js_subtle_sign),
    JS_CFUNC_DEF("verify", 4, js_subtle_verify),
    JS_CFUNC_DEF("encrypt", 3, js_subtle_encrypt),
    JS_CFUNC_DEF("decrypt", 3, js_subtle_decrypt),
    JS_CFUNC_DEF("deriveBits", 3, js_subtle_deriveBits),
    JS_CFUNC_DEF("deriveKey", 5, js_subtle_deriveKey),
    JS_CFUNC_DEF("wrapKey", 4, js_subtle_wrapKey),
    JS_CFUNC_DEF("unwrapKey", 7, js_subtle_unwrapKey),
};

/* ================================================================
 * Crypto class definition
 * ================================================================ */

static JSClassDef js_crypto_class = {
    "Crypto",
};

static const JSCFunctionListEntry js_crypto_proto_funcs[] = {
    JS_CFUNC_DEF("getRandomValues", 1, js_crypto_getRandomValues),
    JS_CFUNC_DEF("randomUUID", 0, js_crypto_randomUUID),
};

/* ================================================================
 * Extension entry point
 * ================================================================ */

static int psa_initialized = 0;

__attribute__((visibility("default")))
int qjs_ext_crypto_init(JSContext *ctx, JSRuntime *rt) {
    /* Initialize PSA Crypto (idempotent) */
    if (!psa_initialized) {
        psa_status_t status = psa_crypto_init();
        if (status != PSA_SUCCESS) return -1;
        psa_initialized = 1;
    }

    JSValue global = JS_GetGlobalObject(ctx);

    /* ---- Register CryptoKey class ---- */
    JS_NewClassID(rt, &js_cryptokey_class_id);
    JS_NewClass(rt, js_cryptokey_class_id, &js_cryptokey_class);

    JSValue ck_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, ck_proto, js_cryptokey_proto_funcs,
                               countof(js_cryptokey_proto_funcs));

    /* Set Symbol.toStringTag = "CryptoKey" */
    {
        JSValue symbol = JS_GetPropertyStr(ctx, global, "Symbol");
        JSValue tst = JS_GetPropertyStr(ctx, symbol, "toStringTag");
        JSAtom atom = JS_ValueToAtom(ctx, tst);
        JS_DefinePropertyValue(ctx, ck_proto, atom,
                               JS_NewString(ctx, "CryptoKey"),
                               JS_PROP_CONFIGURABLE);
        JS_FreeAtom(ctx, atom);
        JS_FreeValue(ctx, tst);
        JS_FreeValue(ctx, symbol);
    }

    JS_SetClassProto(ctx, js_cryptokey_class_id, ck_proto);

    /* ---- Register SubtleCrypto class ---- */
    JS_NewClassID(rt, &js_subtle_class_id);
    JS_NewClass(rt, js_subtle_class_id, &js_subtle_class);

    JSValue subtle_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, subtle_proto, js_subtle_proto_funcs,
                               countof(js_subtle_proto_funcs));

    /* Set Symbol.toStringTag = "SubtleCrypto" */
    {
        JSValue symbol = JS_GetPropertyStr(ctx, global, "Symbol");
        JSValue tst = JS_GetPropertyStr(ctx, symbol, "toStringTag");
        JSAtom atom = JS_ValueToAtom(ctx, tst);
        JS_DefinePropertyValue(ctx, subtle_proto, atom,
                               JS_NewString(ctx, "SubtleCrypto"),
                               JS_PROP_CONFIGURABLE);
        JS_FreeAtom(ctx, atom);
        JS_FreeValue(ctx, tst);
        JS_FreeValue(ctx, symbol);
    }

    JS_SetClassProto(ctx, js_subtle_class_id, subtle_proto);

    /* Create the SubtleCrypto singleton instance */
    JSValue subtle_obj = JS_NewObjectProtoClass(ctx, subtle_proto, js_subtle_class_id);

    /* ---- Register Crypto class ---- */
    JS_NewClassID(rt, &js_crypto_class_id);
    JS_NewClass(rt, js_crypto_class_id, &js_crypto_class);

    JSValue crypto_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, crypto_proto, js_crypto_proto_funcs,
                               countof(js_crypto_proto_funcs));

    /* Set Symbol.toStringTag = "Crypto" */
    {
        JSValue symbol = JS_GetPropertyStr(ctx, global, "Symbol");
        JSValue tst = JS_GetPropertyStr(ctx, symbol, "toStringTag");
        JSAtom atom = JS_ValueToAtom(ctx, tst);
        JS_DefinePropertyValue(ctx, crypto_proto, atom,
                               JS_NewString(ctx, "Crypto"),
                               JS_PROP_CONFIGURABLE);
        JS_FreeAtom(ctx, atom);
        JS_FreeValue(ctx, tst);
        JS_FreeValue(ctx, symbol);
    }

    JS_SetClassProto(ctx, js_crypto_class_id, crypto_proto);

    /* Create the Crypto singleton and attach subtle */
    JSValue crypto_obj = JS_NewObjectProtoClass(ctx, crypto_proto, js_crypto_class_id);
    JS_DefinePropertyValueStr(ctx, crypto_obj, "subtle", subtle_obj,
                              JS_PROP_ENUMERABLE);

    /* Set globalThis.crypto */
    JS_DefinePropertyValueStr(ctx, global, "crypto", crypto_obj,
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);

    /* Also expose CryptoKey as a global (for instanceof checks) */
    JSValue ck_ctor = JS_NewCFunction2(ctx, NULL, "CryptoKey", 0,
                                        JS_CFUNC_constructor, 0);
    JSValue ck_proto_ref = JS_GetClassProto(ctx, js_cryptokey_class_id);
    JS_DefinePropertyValueStr(ctx, ck_ctor, "prototype", ck_proto_ref, 0);
    JS_DefinePropertyValueStr(ctx, global, "CryptoKey", ck_ctor,
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);

    JS_FreeValue(ctx, global);
    return 0;
}

