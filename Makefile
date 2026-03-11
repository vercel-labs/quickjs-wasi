# QuickJS WASM Build
#
# Compiles quickjs-ng + our interface layer into a single .wasm WASI reactor binary.
# Requires wasi-sdk to be installed.

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

# Extensions: DOMException
EXT_DOMEXC_DIR = extensions/dom-exception
EXT_DOMEXC_SO = $(EXT_DOMEXC_DIR)/dom-exception.so

# Extensions: queueMicrotask
EXT_QMT_DIR = extensions/queue-microtask
EXT_QMT_SO = $(EXT_QMT_DIR)/queue-microtask.so

# Extensions: structuredClone
EXT_SC_DIR = extensions/structured-clone
EXT_SC_SO = $(EXT_SC_DIR)/structured-clone.so

.PHONY: all clean

all: $(OUTPUT) $(EXT_URL_SO) $(EXT_ENC_SO) $(EXT_B64_SO) $(EXT_DOMEXC_SO) $(EXT_QMT_SO) $(EXT_SC_SO)

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

# DOMException extension: compile and link
$(EXT_DOMEXC_DIR)/dom-exception.o: $(EXT_DOMEXC_DIR)/dom-exception.c
	$(CC) $(EXT_CFLAGS) -c -o $@ $<

$(EXT_DOMEXC_SO): $(EXT_DOMEXC_DIR)/dom-exception.o
	$(WASI_SDK)/bin/wasm-ld \
		--shared --no-entry --export-dynamic --allow-undefined \
		-o $@ $<

# queueMicrotask extension: compile and link
$(EXT_QMT_DIR)/queue-microtask.o: $(EXT_QMT_DIR)/queue-microtask.c
	$(CC) $(EXT_CFLAGS) -c -o $@ $<

$(EXT_QMT_SO): $(EXT_QMT_DIR)/queue-microtask.o
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

clean:
	rm -rf $(BUILD_DIR) $(OUTPUT) \
		$(EXT_URL_DIR)/url.o $(EXT_URL_DIR)/ada/ada.o \
		$(EXT_URL_DIR)/cxxstubs.o $(EXT_URL_BUILD) \
		$(EXT_URL_SO) \
		$(EXT_ENC_DIR)/encoding.o $(EXT_ENC_SO) \
		$(EXT_B64_DIR)/base64.o $(EXT_B64_SO) \
		$(EXT_DOMEXC_DIR)/dom-exception.o $(EXT_DOMEXC_SO) \
		$(EXT_QMT_DIR)/queue-microtask.o $(EXT_QMT_SO) \
		$(EXT_SC_DIR)/structured-clone.o $(EXT_SC_SO)
