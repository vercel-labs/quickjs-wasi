# Encoding extension

A WHATWG Encoding Standard compliant implementation of `TextEncoder` and `TextDecoder`. Supports UTF-8 encoding/decoding, and UTF-16LE/UTF-16BE decoding.

```typescript
import { readFile } from 'node:fs/promises';

const wasm = await readFile(new URL(import.meta.resolve('quickjs-wasi/quickjs.wasm')));
const encodingSo = await readFile(new URL(import.meta.resolve('quickjs-wasi/encoding.so')));

const vm = await QuickJS.create({
  wasm,
  extensions: [{ name: 'encoding', wasm: encodingSo }],
});
```

## API

### `TextEncoder`

- Constructor: `new TextEncoder()`, always UTF-8 (per spec, the encoding argument is ignored)
- Property: `encoding` (always `"utf-8"`)
- Methods: `encode(input)` returns `Uint8Array`, `encodeInto(source, destination)` returns `{ read, written }`
- USVString semantics: lone surrogates are replaced with U+FFFD

### `TextDecoder`

- Constructor: `new TextDecoder(label?, options?)` (supports UTF-8, UTF-16LE, UTF-16BE)
- Options: `{ fatal: boolean, ignoreBOM: boolean }`
- Properties: `encoding`, `fatal`, `ignoreBOM`
- Method: `decode(input?, options?)` (supports streaming via `{ stream: true }`)
- Accepts `ArrayBuffer`, `TypedArray`, and `DataView` as input
- BOM handling: UTF-8 BOM (EF BB BF), UTF-16LE BOM (FF FE), UTF-16BE BOM (FE FF) are stripped by default
- Fatal mode: throws `TypeError` on invalid byte sequences
- Replacement mode (default): invalid sequences produce U+FFFD
- All UTF-8 label aliases: `utf-8`, `utf8`, `unicode-1-1-utf-8`, etc.
- All UTF-16 label aliases: `utf-16le`, `utf-16`, `utf-16be`, `ucs-2`, etc.
- Unsupported encoding labels throw `RangeError`

## Building

```bash
make  # builds quickjs.wasm and extensions/encoding/encoding.so
```
