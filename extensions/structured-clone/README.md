# Structured Clone Extension

WHATWG HTML Standard compliant `structuredClone()` global function. Deep clones values following the Structured Clone algorithm with circular reference detection.

```typescript
import { structuredCloneExtension } from 'quickjs-wasi/structured-clone';

const vm = await QuickJS.create({
  extensions: [structuredCloneExtension],
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
