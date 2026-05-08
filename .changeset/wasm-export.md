---
'quickjs-wasi': major
---

Stop performing implicit filesystem I/O. The caller is now always responsible for providing the WASM bytes (or a pre-compiled `WebAssembly.Module`) for both the main runtime and any native extensions, using whichever loading mechanism is appropriate for their environment (`fetch()`, `node:fs/promises`, bundler imports, etc.).

**Main runtime**

The `wasm` option on `QuickJS.create()` / `QuickJS.restore()` is now required — the previous `node:fs/promises` fallback has been removed. A new `quickjs-wasi/quickjs.wasm` subpath export points to the published `.wasm` binary so callers can resolve it through their bundler or runtime.

**Extensions**

The Node-only convenience wrappers (`quickjs-wasi/url`, `quickjs-wasi/encoding`, `quickjs-wasi/base64`, `quickjs-wasi/headers`, `quickjs-wasi/crypto`, `quickjs-wasi/structured-clone`) have been removed. Each extension's compiled `.so` is now exposed directly via `quickjs-wasi/<name>.so` (e.g. `quickjs-wasi/url.so`, `quickjs-wasi/crypto.so`) so it can be loaded the same way as the main runtime.

**Migration**

```ts
// Before
import { QuickJS } from 'quickjs-wasi';
import { urlExtension } from 'quickjs-wasi/url';
const vm = await QuickJS.create({ extensions: [urlExtension] });

// After (Node)
import { readFile } from 'node:fs/promises';
import { QuickJS } from 'quickjs-wasi';

const wasm = await readFile(new URL(import.meta.resolve('quickjs-wasi/quickjs.wasm')));
const urlSo = await readFile(new URL(import.meta.resolve('quickjs-wasi/url.so')));

const vm = await QuickJS.create({
  wasm,
  extensions: [{ name: 'url', wasm: urlSo }],
});

// After (Vite / bundlers)
import wasmUrl from 'quickjs-wasi/quickjs.wasm?url';
import urlSoUrl from 'quickjs-wasi/url.so?url';

const wasm = await WebAssembly.compileStreaming(fetch(wasmUrl));
const urlSo = await fetch(urlSoUrl).then((r) => r.arrayBuffer());

const vm = await QuickJS.create({
  wasm,
  extensions: [{ name: 'url', wasm: urlSo }],
});
```
