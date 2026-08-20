# URL Extension

A fully WHATWG URL Standard compliant implementation of `URL` and `URLSearchParams`, backed by the [ada-url](https://github.com/ada-url/ada) library (the same URL parser used by Node.js).

```typescript
import { readFile } from 'node:fs/promises';

const wasm = await readFile(new URL(import.meta.resolve('quickjs-wasi/quickjs.wasm')));
const urlSo = await readFile(new URL(import.meta.resolve('quickjs-wasi/url.so')));

const vm = await QuickJS.create({
  wasm,
  extensions: [{ name: 'url', wasm: urlSo }],
});

vm.evalCode(`
  const url = new URL('https://example.com:8080/api?key=value');
  console.log(url.hostname); // 'example.com'
  console.log(url.port);     // '8080'

  const params = new URLSearchParams('a=1&b=2');
  console.log(params.get('a')); // '1'
`).dispose();
```

## API

### `URL`

- Constructor: `new URL(url)`, `new URL(url, base)` (full base URL resolution support)
- Getters/Setters: `href`, `protocol`, `username`, `password`, `host`, `hostname`, `port`, `pathname`, `search`, `hash`
- Read-only: `origin`
- Methods: `toString()`, `toJSON()`
- Static: `URL.canParse(url)`, `URL.canParse(url, base)`
- Full WHATWG compliance: percent-encoding, IDNA hostname normalization, default port stripping, path normalization

### `URLSearchParams`

- Constructor: `new URLSearchParams(init)` (parses query strings)
- Methods: `get()`, `getAll()`, `set()`, `has(key [, value])`, `delete(key [, value])`, `append()`, `sort()`, `toString()`, `forEach()`, `entries()`, `keys()`, `values()`
- Property: `size`
- `[Symbol.iterator]`: aliased to `entries()`, enabling `for...of` iteration
- Full WHATWG compliance: proper percent-encoding (spaces as `+`), key sorting

## Building

```bash
make  # builds both quickjs.wasm and extensions/url/url.so
```
