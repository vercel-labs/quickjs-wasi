# Structured Clone Extension

WHATWG HTML Standard compliant `structuredClone()` global function. Deep clones values following the Structured Clone algorithm with circular reference detection.

```typescript
import { readFile } from 'node:fs/promises';

const wasm = await readFile(new URL(import.meta.resolve('quickjs-wasi/quickjs.wasm')));
const structuredCloneSo = await readFile(new URL(import.meta.resolve('quickjs-wasi/structured-clone.so')));

const vm = await QuickJS.create({
  wasm,
  extensions: [{ name: 'structured-clone', wasm: structuredCloneSo }],
});
```

## API

### `structuredClone(value, options?)`

Deep clones a value. Handles:

- Primitives: undefined, null, boolean, number, bigint, string
- Date, RegExp
- ArrayBuffer, TypedArrays (Uint8Array, Int32Array, Float64Array, etc.), DataView
- Map, Set
- Array (including sparse arrays)
- Error (Error, TypeError, RangeError, etc.)
- Plain objects
- Circular references and shared references (preserved in the clone graph)

Throws `DataCloneError` DOMException for:

- Functions, Symbols, Proxies, Promises, WeakMap, WeakSet

**Note**: Transfer semantics (`options.transfer`) are not supported.

## Building

```bash
make  # builds quickjs.wasm and extensions/structured-clone/structured-clone.so
```
