# QuickJS WASM Build
#
# Compiles quickjs-ng + our interface layer into a single .wasm WASI reactor binary.
# Requires wasi-sdk to be installed.

WASI_SDK ?= /tmp/wasi-sdk
CC = $(WASI_SDK)/bin/clang
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

# Extension compiler flags (PIC, no LTO)
EXT_CFLAGS = \
	--target=wasm32-wasip1 \
	--sysroot=$(SYSROOT) \
	-fPIC -O2 \
	-I$(QJS_DIR)

# Extensions
EXT_URL_SRC = extensions/url/url.c
EXT_URL_OBJ = extensions/url/url.o
EXT_URL_SO  = extensions/url/url.so

.PHONY: all clean

all: $(OUTPUT) $(EXT_URL_SO)

$(OUTPUT): $(ALL_OBJS)
	$(CC) $(LDFLAGS) -o $@ $^

$(BUILD_DIR)/%.o: $(QJS_DIR)/%.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c -o $@ $<

$(BUILD_DIR)/interface.o: $(INTERFACE_SRC) | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c -o $@ $<

# Extensions
$(EXT_URL_OBJ): $(EXT_URL_SRC)
	$(CC) $(EXT_CFLAGS) -c -o $@ $<

$(EXT_URL_SO): $(EXT_URL_OBJ)
	$(WASI_SDK)/bin/wasm-ld --shared --no-entry --export-dynamic --allow-undefined -o $@ $<

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

clean:
	rm -rf $(BUILD_DIR) $(OUTPUT) extensions/url/url.o extensions/url/url.so
