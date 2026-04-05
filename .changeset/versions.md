---
"quickjs-wasi": minor
---

Add `vm.versions` property returning version information for the runtime and loaded native libraries. Always includes `quickjs-wasi` (package version) and `quickjs` (engine version). Extensions can contribute additional entries by exporting a `qjs_ext_<name>_versions()` function — the built-in URL extension reports `ada` and the crypto extension reports `mbedtls`.
