// Termux/Android workaround for Ghidra's native decompiler build.
//
// libc++ (LLVM 21, shipped in Termux) declares std::__ndk1::__hash_memory as
// `_LIBCPP_EXPORTED_FROM_ABI` and expects it to come from libc++_shared.so.
// On Termux aarch64 the Android dynamic linker refuses to resolve that symbol
// for our binaries ("CANNOT LINK EXECUTABLE ... cannot locate symbol
// _ZNSt6__ndk113__hash_memoryEPKvm"), even though it is exported as
// GLOBAL DEFAULT and `LD_PRELOAD`ing libc++_shared.so makes the same binary run.
//
// Supplying the definition inside the executable resolves the reference
// locally. The implementation is libc++'s own murmur2/cityhash, so hash values
// stay identical to the ones the shared library would produce.
#include <__functional/hash.h>

namespace std {
inline namespace __ndk1 {

size_t __hash_memory(_LIBCPP_NOESCAPE const void* __ptr, size_t __size) _NOEXCEPT {
  return __murmur2_or_cityhash<size_t>()(__ptr, __size);
}

} // namespace __ndk1
} // namespace std
