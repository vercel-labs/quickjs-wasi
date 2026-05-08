# Base64 Extension

WHATWG HTML Standard compliant `atob()` and `btoa()` global functions, plus the [TC39 Uint8Array Base64/Hex proposal](https://github.com/tc39/proposal-arraybuffer-base64) methods on `Uint8Array`. Uses the "forgiving-base64" decode algorithm from the Infra Standard.

```typescript
import { readFile } from 'node:fs/promises';

const wasm = await readFile(new URL(import.meta.resolve('quickjs-wasi/quickjs.wasm')));
const base64So = await readFile(new URL(import.meta.resolve('quickjs-wasi/base64.so')));

const vm = await QuickJS.create({
  wasm,
  extensions: [{ name: 'base64', wasm: base64So }],
});
```

## API

### Global Functions

**`btoa(data)`**: Encodes a binary string (each char code 0-255) to base64. Throws `InvalidCharacterError` DOMException for characters > U+00FF.

**`atob(data)`**: Decodes a base64 string to a binary string. Supports forgiving decode (strips ASCII whitespace, allows missing padding). Throws `InvalidCharacterError` for invalid input.

### `Uint8Array` Static Methods

**`Uint8Array.fromBase64(string [, options])`**: Decodes a base64 string and returns a new `Uint8Array`.

- `options.alphabet` — `"base64"` (default) or `"base64url"`
- `options.lastChunkHandling` — `"loose"` (default), `"strict"`, or `"stop-before-partial"`

**`Uint8Array.fromHex(string)`**: Decodes a hex string and returns a new `Uint8Array`. Throws `SyntaxError` for odd-length or invalid hex strings.

### `Uint8Array.prototype` Methods

**`uint8Array.toBase64([options])`**: Encodes the array contents to a base64 string.

- `options.alphabet` — `"base64"` (default) or `"base64url"`
- `options.omitPadding` — `false` (default) or `true`

**`uint8Array.toHex()`**: Encodes the array contents to a lowercase hex string.

**`uint8Array.setFromBase64(string [, options])`**: Decodes a base64 string into the existing array. Returns `{ read, written }` indicating how much of the input was consumed and how many bytes were written.

- `options.alphabet` — `"base64"` (default) or `"base64url"`
- `options.lastChunkHandling` — `"loose"` (default), `"strict"`, or `"stop-before-partial"`

**`uint8Array.setFromHex(string)`**: Decodes a hex string into the existing array. Returns `{ read, written }`.

## Building

```bash
make  # builds quickjs.wasm and extensions/base64/base64.so
```
