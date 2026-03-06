import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const wasmPath = resolve(__dirname, '..', 'quickjs.wasm');
export const wasmBytes = readFileSync(wasmPath);
