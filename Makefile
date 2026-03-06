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
	-DNDEBUG \
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
	-Wl,--export=malloc \
	-Wl,--export=free \
	-Wl,--export=realloc \
	-Wl,--export=__stack_pointer

# Object files
QJS_OBJS = $(patsubst $(QJS_DIR)/%.c,$(BUILD_DIR)/%.o,$(QJS_SRCS))
INTERFACE_OBJ = $(BUILD_DIR)/interface.o

ALL_OBJS = $(QJS_OBJS) $(INTERFACE_OBJ)

.PHONY: all clean

all: $(OUTPUT)

$(OUTPUT): $(ALL_OBJS)
	$(CC) $(LDFLAGS) -o $@ $^

$(BUILD_DIR)/%.o: $(QJS_DIR)/%.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c -o $@ $<

$(BUILD_DIR)/interface.o: $(INTERFACE_SRC) | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c -o $@ $<

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

clean:
	rm -rf $(BUILD_DIR) $(OUTPUT)
