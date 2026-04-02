# QuickJS WASM Build
#
# Compiles quickjs-ng + our interface layer into a single .wasm WASI reactor binary.
# Requires wasi-sdk to be installed. Run `make setup` to install it automatically.

WASI_SDK_VERSION_REQUIRED = 32
WASI_SDK ?= /tmp/wasi-sdk
CC = $(WASI_SDK)/bin/clang
CXX = $(WASI_SDK)/bin/clang++
AR = $(WASI_SDK)/bin/llvm-ar
SYSROOT = $(WASI_SDK)/share/wasi-sysroot

# QuickJS source directory
QJS_DIR = quickjs-ng

# Source files
QJS_SRCS = \
	$(QJS_DIR)/quickjs.c \
	$(QJS_DIR)/dtoa.c \
	$(QJS_DIR)/libregexp.c \
	$(QJS_DIR)/libunicode.c

INTERFACE_SRC = c/interface.c

# Output
BUILD_DIR = build
OUTPUT = quickjs.wasm

# Compiler flags
CFLAGS = \
	--target=wasm32-wasip1 \
	--sysroot=$(SYSROOT) \
	-O2 \
	-flto \
	-I$(QJS_DIR) \
	-D_GNU_SOURCE \
	-D_WASI_EMULATED_PROCESS_CLOCKS \
	-D_WASI_EMULATED_SIGNAL \
	-DQJS_BUILD_LIBC=0 \
	-fvisibility=hidden \
	-Wall \
	-Wno-implicit-fallthrough \
	-Wno-sign-compare \
	-Wno-missing-field-initializers \
	-Wno-unused-parameter \
	-Wno-unused-but-set-variable

# Linker flags
LDFLAGS = \
	--target=wasm32-wasip1 \
	--sysroot=$(SYSROOT) \
	-flto \
	-mexec-model=reactor \
	-lwasi-emulated-process-clocks \
	-lwasi-emulated-signal \
	-Wl,--wrap=__secs_to_zone \
	-Wl,--export-dynamic \
	-Wl,--export=__stack_pointer \
	-Wl,-z,stack-size=1048576 \
	-Wl,--export=__indirect_function_table \
	-Wl,--growable-table \
	-Wl,--export=malloc \
	-Wl,--export=free \
	-Wl,--export=realloc \
	-Wl,--export=calloc \
	-Wl,--export=memcpy \
	-Wl,--export=memset \
	-Wl,--export=memmove \
	-Wl,--export=memcmp \
	-Wl,--export=memchr \
	-Wl,--export=strlen \
	-Wl,--export=strcmp \
	-Wl,--export=strncmp \
	-Wl,--export=strchr \
	-Wl,--export=strrchr \
	-Wl,--export=strstr \
	-Wl,--export=strcpy \
	-Wl,--export=strncpy \
	-Wl,--export=strcat \
	-Wl,--export=strncat \
	-Wl,--export=strdup \
	-Wl,--export=stpcpy \
	-Wl,--export=strtol \
	-Wl,--export=strtoul \
	-Wl,--export=strtod \
	-Wl,--export=atoi \
	-Wl,--export=atof \
	-Wl,--export=isalpha \
	-Wl,--export=isalnum \
	-Wl,--export=isdigit \
	-Wl,--export=isxdigit \
	-Wl,--export=isspace \
	-Wl,--export=isprint \
	-Wl,--export=isupper \
	-Wl,--export=islower \
	-Wl,--export=toupper \
	-Wl,--export=tolower \
	-Wl,--export=snprintf \
	-Wl,--export=sprintf \
	-Wl,--export=vsnprintf \
	-Wl,--export=sscanf \
	-Wl,--export=qsort \
	-Wl,--export=bsearch \
	-Wl,--export=strerror \
	-Wl,--export=abort \
	-Wl,--export=sin \
	-Wl,--export=cos \
	-Wl,--export=tan \
	-Wl,--export=asin \
	-Wl,--export=acos \
	-Wl,--export=atan \
	-Wl,--export=atan2 \
	-Wl,--export=sqrt \
	-Wl,--export=pow \
	-Wl,--export=exp \
	-Wl,--export=log \
	-Wl,--export=log2 \
	-Wl,--export=log10 \
	-Wl,--export=fabs \
	-Wl,--export=floor \
	-Wl,--export=ceil \
	-Wl,--export=round \
	-Wl,--export=trunc \
	-Wl,--export=fmod \
	-Wl,--export=fmin \
	-Wl,--export=fmax \
	-Wl,--export=cbrt \
	-Wl,--export=exp2 \
	-Wl,--export=sinh \
	-Wl,--export=cosh \
	-Wl,--export=tanh \
	-Wl,--export=asinh \
	-Wl,--export=acosh \
	-Wl,--export=atanh \
	-Wl,--export=copysign \
	-Wl,--export=ldexp \
	-Wl,--export=frexp \
	-Wl,--export=modf \
	-Wl,--export=remainder

# Object files
QJS_OBJS = $(patsubst $(QJS_DIR)/%.c,$(BUILD_DIR)/%.o,$(QJS_SRCS))
INTERFACE_OBJ = $(BUILD_DIR)/interface.o

ALL_OBJS = $(QJS_OBJS) $(INTERFACE_OBJ)

# Extension compiler flags (C, PIC, no LTO)
EXT_CFLAGS = \
	--target=wasm32-wasip1 \
	--sysroot=$(SYSROOT) \
	-fPIC -O2 \
	-I$(QJS_DIR)

# Extension compiler flags (C++20, PIC, no LTO)
EXT_CXXFLAGS = \
	--target=wasm32-wasip1 \
	--sysroot=$(SYSROOT) \
	-fPIC -O2 -std=c++20 \
	-fno-exceptions -fno-rtti \
	-D_LIBCPP_HAS_NO_THREADS \
	-D_LIBCPP_DISABLE_EXTERN_TEMPLATE

# Extensions: URL (backed by ada-url)
# The libc++ string.cpp.o is extracted from the archive and linked directly
# to provide std::basic_string<char> method implementations that ada uses.
# The wstring (wchar_t) symbols it pulls in are dead code never called at runtime.
EXT_URL_DIR = extensions/url
EXT_URL_BUILD = $(EXT_URL_DIR)/build
WASM_LIB_DIR = $(SYSROOT)/lib/wasm32-wasip1
EXT_URL_OBJS = \
	$(EXT_URL_DIR)/url.o \
	$(EXT_URL_DIR)/ada/ada.o \
	$(EXT_URL_DIR)/cxxstubs.o \
	$(EXT_URL_BUILD)/string.cpp.o
EXT_URL_SO = $(EXT_URL_DIR)/url.so

# Extensions: Encoding (TextEncoder / TextDecoder)
# Pure C extension — no C++ dependencies needed.
EXT_ENC_DIR = extensions/encoding
EXT_ENC_SO = $(EXT_ENC_DIR)/encoding.so

# Extensions: Base64 (atob / btoa)
EXT_B64_DIR = extensions/base64
EXT_B64_SO = $(EXT_B64_DIR)/base64.so

# Extensions: Headers
EXT_HDR_DIR = extensions/headers
EXT_HDR_SO = $(EXT_HDR_DIR)/headers.so

# Extensions: structuredClone
EXT_SC_DIR = extensions/structured-clone
EXT_SC_SO = $(EXT_SC_DIR)/structured-clone.so

# Extensions: Crypto (Web Crypto API backed by mbedTLS 4.0 PSA)
EXT_CRYPTO_DIR = extensions/crypto
EXT_CRYPTO_BUILD = $(EXT_CRYPTO_DIR)/build
MBEDTLS_DIR = $(EXT_CRYPTO_DIR)/mbedtls

# mbedTLS / PSA Crypto include paths
MBEDTLS_INCLUDES = \
	-I$(MBEDTLS_DIR)/include \
	-I$(MBEDTLS_DIR)/tf-psa-crypto/include \
	-I$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/include \
	-I$(MBEDTLS_DIR)/tf-psa-crypto/drivers/everest/include \
	-I$(MBEDTLS_DIR)/tf-psa-crypto/drivers/everest/include/tf-psa-crypto/private/everest \
	-I$(MBEDTLS_DIR)/tf-psa-crypto/drivers/everest/include/tf-psa-crypto/private/everest/kremlib \
	-I$(MBEDTLS_DIR)/tf-psa-crypto/core \
	-I$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src \
	-I$(MBEDTLS_DIR)/library

# mbedTLS config: use our custom WASM config for both mbedTLS and TF-PSA-Crypto
MBEDTLS_CONFIG_FLAGS = \
	-DMBEDTLS_CONFIG_FILE='"mbedtls_config_wasm.h"' \
	-DTF_PSA_CRYPTO_CONFIG_FILE='"mbedtls_config_wasm.h"' \
	-I$(EXT_CRYPTO_DIR)

# Crypto extension C flags
EXT_CRYPTO_CFLAGS = $(EXT_CFLAGS) $(MBEDTLS_INCLUDES) $(MBEDTLS_CONFIG_FLAGS) \
	-Wno-unused-function -Wno-unused-variable

# PSA Core source files
MBEDTLS_PSA_CORE_SRCS = \
	$(MBEDTLS_DIR)/tf-psa-crypto/core/psa_crypto.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/core/psa_crypto_client.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/core/psa_crypto_driver_wrappers_no_static.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/core/psa_crypto_slot_management.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/core/psa_crypto_storage.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/core/psa_its_file.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/core/tf_psa_crypto_config.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/core/tf_psa_crypto_version.c

# Builtin driver source files
MBEDTLS_BUILTIN_SRCS = \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/aes.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/asn1parse.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/asn1write.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/base64.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/bignum.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/bignum_core.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/bignum_mod.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/bignum_mod_raw.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/block_cipher.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/cipher.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/cipher_wrap.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/constant_time.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/ecdh.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/ecdsa.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/ecp.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/ecp_curves.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/ecp_curves_new.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/entropy.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/entropy_poll.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/gcm.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/md.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/nist_kw.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/oid.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/pem.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/pk.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/pk_ecc.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/pk_rsa.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/pk_wrap.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/pkcs5.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/pkparse.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/pkwrite.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/platform.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/platform_util.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/psa_crypto_aead.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/psa_crypto_cipher.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/psa_crypto_ecp.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/psa_crypto_ffdh.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/psa_crypto_hash.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/psa_crypto_mac.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/psa_crypto_pake.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/psa_crypto_rsa.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/psa_util.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/rsa.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/rsa_alt_helpers.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/sha1.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/sha256.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/sha512.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/builtin/src/threading.c

# Everest (X25519/Curve25519)
MBEDTLS_EVEREST_SRCS = \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/everest/library/everest.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/everest/library/x25519.c \
	$(MBEDTLS_DIR)/tf-psa-crypto/drivers/everest/library/Hacl_Curve25519_joined.c

# Top-level library (error strings)
MBEDTLS_LIB_SRCS = \
	$(MBEDTLS_DIR)/library/error.c

# All mbedTLS sources
MBEDTLS_ALL_SRCS = $(MBEDTLS_PSA_CORE_SRCS) $(MBEDTLS_BUILTIN_SRCS) $(MBEDTLS_EVEREST_SRCS) $(MBEDTLS_LIB_SRCS)

# Object files: flatten into build dir
MBEDTLS_ALL_OBJS = $(patsubst %.c,$(EXT_CRYPTO_BUILD)/%.o,$(notdir $(MBEDTLS_ALL_SRCS)))

# Add the crypto.c object
EXT_CRYPTO_OBJ = $(EXT_CRYPTO_BUILD)/crypto.o
EXT_CRYPTO_ALL_OBJS = $(EXT_CRYPTO_OBJ) $(MBEDTLS_ALL_OBJS)
EXT_CRYPTO_SO = $(EXT_CRYPTO_DIR)/crypto.so

.PHONY: all clean setup check-wasi-sdk

all: check-wasi-sdk $(OUTPUT) $(EXT_URL_SO) $(EXT_ENC_SO) $(EXT_B64_SO) $(EXT_HDR_SO) $(EXT_SC_SO) $(EXT_CRYPTO_SO)

# Verify wasi-sdk is installed and matches the required version
check-wasi-sdk:
	@if [ ! -f "$(WASI_SDK)/VERSION" ]; then \
		echo ""; \
		echo "ERROR: wasi-sdk not found at $(WASI_SDK)"; \
		echo ""; \
		echo "Run 'make setup' to install wasi-sdk $(WASI_SDK_VERSION_REQUIRED) automatically,"; \
		echo "or set WASI_SDK to point to an existing installation."; \
		echo ""; \
		exit 1; \
	fi
	@INSTALLED=$$(head -1 "$(WASI_SDK)/VERSION" | cut -d. -f1); \
	if [ "$$INSTALLED" != "$(WASI_SDK_VERSION_REQUIRED)" ]; then \
		echo ""; \
		echo "ERROR: wasi-sdk version mismatch"; \
		echo "  Required: $(WASI_SDK_VERSION_REQUIRED)"; \
		echo "  Installed: $$INSTALLED (at $(WASI_SDK))"; \
		echo ""; \
		echo "Run 'make setup' to install the correct version."; \
		echo ""; \
		exit 1; \
	fi

# Download and install the correct wasi-sdk version for the current platform
setup:
	@echo "Installing wasi-sdk $(WASI_SDK_VERSION_REQUIRED)..."
	@case "$$(uname -s)-$$(uname -m)" in \
		Linux-x86_64)  PLATFORM="x86_64-linux" ;; \
		Linux-aarch64) PLATFORM="arm64-linux" ;; \
		Darwin-arm64)  PLATFORM="arm64-macos" ;; \
		Darwin-x86_64) PLATFORM="x86_64-macos" ;; \
		*) echo "Unsupported platform: $$(uname -s)-$$(uname -m)"; exit 1 ;; \
	esac; \
	URL="https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$(WASI_SDK_VERSION_REQUIRED)/wasi-sdk-$(WASI_SDK_VERSION_REQUIRED).0-$$PLATFORM.tar.gz"; \
	echo "Downloading $$URL"; \
	rm -rf "$(WASI_SDK)"; \
	mkdir -p "$(WASI_SDK)"; \
	curl -sL "$$URL" | tar xz -C "$(WASI_SDK)" --strip-components=1; \
	echo ""; \
	echo "wasi-sdk $(WASI_SDK_VERSION_REQUIRED) installed to $(WASI_SDK)"

$(OUTPUT): $(ALL_OBJS)
	$(CC) $(LDFLAGS) -o $@ $^

$(BUILD_DIR)/%.o: $(QJS_DIR)/%.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c -o $@ $<

$(BUILD_DIR)/interface.o: $(INTERFACE_SRC) | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c -o $@ $<

# URL extension: compile C source
$(EXT_URL_DIR)/url.o: $(EXT_URL_DIR)/url.c
	$(CC) $(EXT_CFLAGS) -I$(EXT_URL_DIR) -c -o $@ $<

# URL extension: compile ada C++ source
$(EXT_URL_DIR)/ada/ada.o: $(EXT_URL_DIR)/ada/ada.cpp
	$(CXX) $(EXT_CXXFLAGS) -c -o $@ $<

# URL extension: compile C++ runtime stubs
$(EXT_URL_DIR)/cxxstubs.o: $(EXT_URL_DIR)/cxxstubs.cpp
	$(CXX) $(EXT_CXXFLAGS) -c -o $@ $<

# URL extension: extract libc++ std::string implementation
$(EXT_URL_BUILD)/string.cpp.o: | $(EXT_URL_BUILD)
	$(AR) x $(WASM_LIB_DIR)/libc++.a string.cpp.o --output=$(EXT_URL_BUILD)

$(EXT_URL_BUILD):
	mkdir -p $(EXT_URL_BUILD)

# URL extension: link as shared library
$(EXT_URL_SO): $(EXT_URL_OBJS)
	$(WASI_SDK)/bin/wasm-ld \
		--shared --no-entry --export-dynamic --allow-undefined \
		-o $@ $(EXT_URL_OBJS)

# Encoding extension: compile C source
$(EXT_ENC_DIR)/encoding.o: $(EXT_ENC_DIR)/encoding.c
	$(CC) $(EXT_CFLAGS) -c -o $@ $<

# Encoding extension: link as shared library
$(EXT_ENC_SO): $(EXT_ENC_DIR)/encoding.o
	$(WASI_SDK)/bin/wasm-ld \
		--shared --no-entry --export-dynamic --allow-undefined \
		-o $@ $<

# Base64 extension: compile and link
$(EXT_B64_DIR)/base64.o: $(EXT_B64_DIR)/base64.c
	$(CC) $(EXT_CFLAGS) -c -o $@ $<

$(EXT_B64_SO): $(EXT_B64_DIR)/base64.o
	$(WASI_SDK)/bin/wasm-ld \
		--shared --no-entry --export-dynamic --allow-undefined \
		-o $@ $<

# Headers extension: compile and link
$(EXT_HDR_DIR)/headers.o: $(EXT_HDR_DIR)/headers.c
	$(CC) $(EXT_CFLAGS) -c -o $@ $<

$(EXT_HDR_SO): $(EXT_HDR_DIR)/headers.o
	$(WASI_SDK)/bin/wasm-ld \
		--shared --no-entry --export-dynamic --allow-undefined \
		-o $@ $<

# structuredClone extension: compile and link
$(EXT_SC_DIR)/structured-clone.o: $(EXT_SC_DIR)/structured-clone.c
	$(CC) $(EXT_CFLAGS) -c -o $@ $<

$(EXT_SC_SO): $(EXT_SC_DIR)/structured-clone.o
	$(WASI_SDK)/bin/wasm-ld \
		--shared --no-entry --export-dynamic --allow-undefined \
		-o $@ $<

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

# ---- Crypto extension ----

$(EXT_CRYPTO_BUILD):
	mkdir -p $(EXT_CRYPTO_BUILD)

# Compile crypto.c (our extension code)
$(EXT_CRYPTO_BUILD)/crypto.o: $(EXT_CRYPTO_DIR)/crypto.c | $(EXT_CRYPTO_BUILD)
	$(CC) $(EXT_CRYPTO_CFLAGS) -c -o $@ $<

# Compile mbedTLS sources. We use VPATH-like pattern rules via a define+eval loop
# to map each source file to its corresponding .o in the build directory.
define MBEDTLS_COMPILE_RULE
$(EXT_CRYPTO_BUILD)/$(notdir $(1:.c=.o)): $(1) | $(EXT_CRYPTO_BUILD)
	$(CC) $(EXT_CRYPTO_CFLAGS) -c -o $$@ $$<
endef
$(foreach src,$(MBEDTLS_ALL_SRCS),$(eval $(call MBEDTLS_COMPILE_RULE,$(src))))

# Link crypto extension as shared library
$(EXT_CRYPTO_SO): $(EXT_CRYPTO_ALL_OBJS)
	$(WASI_SDK)/bin/wasm-ld \
		--shared --no-entry --export-dynamic --allow-undefined \
		-o $@ $(EXT_CRYPTO_ALL_OBJS)

clean:
	rm -rf $(BUILD_DIR) $(OUTPUT) \
		$(EXT_URL_DIR)/url.o $(EXT_URL_DIR)/ada/ada.o \
		$(EXT_URL_DIR)/cxxstubs.o $(EXT_URL_BUILD) \
		$(EXT_URL_SO) \
		$(EXT_ENC_DIR)/encoding.o $(EXT_ENC_SO) \
		$(EXT_B64_DIR)/base64.o $(EXT_B64_SO) \
		$(EXT_HDR_DIR)/headers.o $(EXT_HDR_SO) \
		$(EXT_SC_DIR)/structured-clone.o $(EXT_SC_SO) \
		$(EXT_CRYPTO_BUILD) $(EXT_CRYPTO_SO)
