/*
 * Custom Mbed TLS / TF-PSA-Crypto configuration for WASM (wasi-sdk)
 *
 * This is a minimal configuration enabling only the algorithms required
 * by the W3C Web Cryptography API:
 *   - SHA-1, SHA-256, SHA-384, SHA-512 (digest)
 *   - HMAC (sign/verify)
 *   - AES-CBC, AES-CTR, AES-GCM, AES-KW (encrypt/decrypt/wrap/unwrap)
 *   - RSA-OAEP, RSASSA-PKCS1-v1_5, RSA-PSS (encrypt/sign)
 *   - ECDSA, ECDH (sign/deriveBits)
 *   - Ed25519, X25519 (sign/deriveBits)  -- Level 2
 *   - HKDF, PBKDF2 (deriveBits/deriveKey)
 *
 * Disabled: TLS, X.509, networking, file I/O, threading, persistent storage.
 * Entropy is provided via MBEDTLS_PSA_CRYPTO_EXTERNAL_RNG backed by
 * WASI random_get / arc4random_buf.
 */

#ifndef MBEDTLS_CONFIG_WASM_H
#define MBEDTLS_CONFIG_WASM_H

/* ================================================================
 * TF-PSA-Crypto / PSA algorithm selection
 * ================================================================ */

#define TF_PSA_CRYPTO_CONFIG_VERSION 0x01000000

/* --- Hash algorithms --- */
#define PSA_WANT_ALG_SHA_1                      1
#define PSA_WANT_ALG_SHA_256                    1
#define PSA_WANT_ALG_SHA_384                    1
#define PSA_WANT_ALG_SHA_512                    1

/* --- HMAC --- */
#define PSA_WANT_ALG_HMAC                       1

/* --- AES modes --- */
#define PSA_WANT_ALG_CBC_NO_PADDING             1
#define PSA_WANT_ALG_CBC_PKCS7                  1
#define PSA_WANT_ALG_CTR                        1
#define PSA_WANT_ALG_GCM                        1
#define PSA_WANT_ALG_ECB_NO_PADDING             1  /* needed internally by CTR_DRBG */

/* --- RSA --- */
#define PSA_WANT_ALG_RSA_OAEP                   1
#define PSA_WANT_ALG_RSA_PKCS1V15_SIGN          1
#define PSA_WANT_ALG_RSA_PSS                    1

/* --- ECDSA --- */
#define PSA_WANT_ALG_ECDSA                      1
#define PSA_WANT_ALG_DETERMINISTIC_ECDSA        1

/* --- ECDH --- */
#define PSA_WANT_ALG_ECDH                       1

/* --- Key derivation --- */
#define PSA_WANT_ALG_HKDF                       1
#define PSA_WANT_ALG_HKDF_EXTRACT               1
#define PSA_WANT_ALG_HKDF_EXPAND                1
#define PSA_WANT_ALG_PBKDF2_HMAC                1

/* --- ECC curves --- */
#define PSA_WANT_ECC_SECP_R1_256                1
#define PSA_WANT_ECC_SECP_R1_384                1
#define PSA_WANT_ECC_SECP_R1_521                1
#define PSA_WANT_ECC_MONTGOMERY_255             1  /* X25519 / Ed25519 */

/* --- Key types --- */
#define PSA_WANT_KEY_TYPE_AES                   1
#define PSA_WANT_KEY_TYPE_HMAC                  1
#define PSA_WANT_KEY_TYPE_DERIVE                1
#define PSA_WANT_KEY_TYPE_PASSWORD              1
#define PSA_WANT_KEY_TYPE_RAW_DATA              1
#define PSA_WANT_KEY_TYPE_RSA_PUBLIC_KEY        1
#define PSA_WANT_KEY_TYPE_ECC_PUBLIC_KEY        1

#define PSA_WANT_KEY_TYPE_RSA_KEY_PAIR_BASIC    1
#define PSA_WANT_KEY_TYPE_RSA_KEY_PAIR_IMPORT   1
#define PSA_WANT_KEY_TYPE_RSA_KEY_PAIR_EXPORT   1
#define PSA_WANT_KEY_TYPE_RSA_KEY_PAIR_GENERATE 1

#define PSA_WANT_KEY_TYPE_ECC_KEY_PAIR_BASIC    1
#define PSA_WANT_KEY_TYPE_ECC_KEY_PAIR_IMPORT   1
#define PSA_WANT_KEY_TYPE_ECC_KEY_PAIR_EXPORT   1
#define PSA_WANT_KEY_TYPE_ECC_KEY_PAIR_GENERATE 1
#define PSA_WANT_KEY_TYPE_ECC_KEY_PAIR_DERIVE   1

/* ================================================================
 * Mbed TLS module selection (mbedtls_config.h portion)
 * ================================================================ */

/* Platform */
#define MBEDTLS_PLATFORM_C
/* Disable MBEDTLS_HAVE_TIME — WASI does not provide mbedtls_ms_time */
/* #undef MBEDTLS_HAVE_TIME */

/* Do NOT enable these — no filesystem, no network, no threads in WASM */
/* #undef MBEDTLS_FS_IO */
/* #undef MBEDTLS_NET_C */
/* #undef MBEDTLS_TIMING_C */
/* #undef MBEDTLS_THREADING_C */
/* #undef MBEDTLS_HAVE_TIME_DATE */

/* PSA Crypto core */
#define MBEDTLS_PSA_CRYPTO_C

/* Use external RNG — we provide mbedtls_psa_external_get_random() backed by
   WASI random_get / arc4random_buf. This avoids needing the entropy module,
   DRBG, and filesystem for seed storage. */
#define MBEDTLS_PSA_CRYPTO_EXTERNAL_RNG

/* Disable persistent key storage (no filesystem) */
/* #undef MBEDTLS_PSA_CRYPTO_STORAGE_C */
/* #undef MBEDTLS_PSA_ITS_FILE_C */

/* Dynamic key store */
#define MBEDTLS_PSA_KEY_STORE_DYNAMIC

/* Assume exclusive buffers — safe in single-threaded WASM */
#define MBEDTLS_PSA_ASSUME_EXCLUSIVE_BUFFERS

/* Bignum, ASN.1, PK — needed for RSA/ECC key import/export (PKCS#8, SPKI, JWK) */
#define MBEDTLS_ASN1_PARSE_C
#define MBEDTLS_ASN1_WRITE_C
#define MBEDTLS_PK_C
#define MBEDTLS_PK_PARSE_C
#define MBEDTLS_PK_WRITE_C
#define MBEDTLS_PK_PARSE_EC_EXTENDED
#define MBEDTLS_PK_PARSE_EC_COMPRESSED

/* MD layer — needed by many modules */
#define MBEDTLS_MD_C

/* PEM parsing — for importing PEM-encoded keys */
#define MBEDTLS_BASE64_C
#define MBEDTLS_PEM_PARSE_C
#define MBEDTLS_PEM_WRITE_C

/* NIST key wrapping — AES-KW */
#define MBEDTLS_NIST_KW_C

/* Error strings (useful for debugging) */
#define MBEDTLS_ERROR_C
#define MBEDTLS_ERROR_STRERROR_DUMMY

/* Disable self-test to save code size */
/* #undef MBEDTLS_SELF_TEST */

/* Disable version info to save code size */
/* #undef MBEDTLS_VERSION_C */
/* #undef MBEDTLS_VERSION_FEATURES */

/* ================================================================
 * Disable everything we do NOT need
 * ================================================================ */

/* No DRBG needed (external RNG) */
/* #undef MBEDTLS_CTR_DRBG_C */
/* #undef MBEDTLS_HMAC_DRBG_C */

/* No LMS */
/* #undef MBEDTLS_LMS_C */

/* No PKCS5 (we use PSA PBKDF2 directly) */
/* #undef MBEDTLS_PKCS5_C */

#endif /* MBEDTLS_CONFIG_WASM_H */
