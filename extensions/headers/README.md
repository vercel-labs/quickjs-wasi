# Headers Extension

A WHATWG Fetch Standard compliant `Headers` class, providing HTTP header manipulation with case-insensitive name matching, value normalization, and sorted iteration.

```typescript
import { readFile } from 'node:fs/promises';

const wasm = await readFile(new URL(import.meta.resolve('quickjs-wasi/quickjs.wasm')));
const headersSo = await readFile(new URL(import.meta.resolve('quickjs-wasi/headers.so')));

const vm = await QuickJS.create({
  wasm,
  extensions: [{ name: 'headers', wasm: headersSo }],
});

vm.evalCode(`
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Accept', 'text/html');
  console.log(headers.get('content-type'));  // 'application/json'
`).dispose();
```

## API

### `Headers`

- Constructor: `new Headers()`, `new Headers(init)`
  - `init` can be a `Headers` instance, an object of key/value pairs, or an array of `[name, value]` pairs
- Methods:
  - `append(name, value)`: append a header value (does not replace existing values)
  - `delete(name)`: remove all values for a header name
  - `get(name)`: get the combined value for a header name, or `null`
  - `getSetCookie()`: returns an array of `Set-Cookie` header values (per spec, these are not combined)
  - `has(name)`: check if a header exists
  - `set(name, value)`: set a header, replacing any existing values
  - `entries()`: returns an iterator of `[name, value]` pairs (sorted by name)
  - `keys()`: returns an iterator of header names (sorted)
  - `values()`: returns an iterator of header values (sorted by name)
  - `forEach(callback [, thisArg])`: call a function for each header
- `[Symbol.iterator]`: aliased to `entries()`, enabling `for...of` iteration
- Header names are case-insensitive and normalized to lowercase
- Header values are trimmed of leading/trailing whitespace

## Building

```bash
make  # builds quickjs.wasm and extensions/headers/headers.so
```
