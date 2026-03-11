/*
 * C++ runtime stubs for WASM shared library extensions.
 *
 * Provides minimal implementations of C++ runtime functions that the
 * ada-url library and libc++ require. These are linked directly into
 * the .so so they don't need to be resolved from the host module.
 */

#include <cstdlib>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <new>

/* ---- operator new / delete ---- */

void* operator new(size_t size) {
    void* p = malloc(size);
    if (!p) __builtin_trap();
    return p;
}

void* operator new(size_t size, const std::nothrow_t&) noexcept {
    return malloc(size);
}

void* operator new[](size_t size) {
    void* p = malloc(size);
    if (!p) __builtin_trap();
    return p;
}

void operator delete(void* p) noexcept {
    free(p);
}

void operator delete(void* p, size_t) noexcept {
    free(p);
}

void operator delete[](void* p) noexcept {
    free(p);
}

/* ---- __cxa_atexit ---- */
extern "C" int __cxa_atexit(void (*)(void*), void*, void*) {
    return 0;
}

/* ---- __assert_fail ---- */
extern "C" void __assert_fail(const char*, const char*, unsigned int, const char*) {
    __builtin_trap();
}

/* ---- __libcpp_verbose_abort ---- */
namespace std {
inline namespace __2 {
void __libcpp_verbose_abort(const char* format, ...) noexcept {
    __builtin_trap();
}
} // namespace __2
} // namespace std

/* ---- wmemchr ---- */
extern "C" wchar_t* wmemchr(const wchar_t* s, wchar_t c, size_t n) {
    for (size_t i = 0; i < n; i++) {
        if (s[i] == c) return const_cast<wchar_t*>(&s[i]);
    }
    return nullptr;
}

/* std::to_string and std::string methods are provided by libc++'s string.cpp.o */
