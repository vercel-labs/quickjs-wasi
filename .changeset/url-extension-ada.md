---
"quickjs-wasi": minor
---

Add `quickjs-wasi/url` sub-export with WHATWG-compliant URL and URLSearchParams backed by ada-url

- Replace hand-written URL parser with [ada-url](https://github.com/ada-url/ada) v3.4.3 for full WHATWG URL Standard compliance
- Add `quickjs-wasi/url` package sub-export for ergonomic opt-in: `import { urlExtension } from 'quickjs-wasi/url'`
- URL class: constructor with base URL support, all property getters/setters, `toString()`, `toJSON()`, static `URL.canParse()`
- URLSearchParams class: `get()`, `getAll()`, `set()`, `has()`, `delete()`, `append()`, `sort()`, `toString()`, `forEach()`, `entries()`, `keys()`, `values()`, `size`
- Extension loader: support C++ shared library self-resolution and graceful handling of unresolved symbols
- 100% pass rate on 877 Web Platform Tests (urltestdata.json)
