import { readFileSync } from 'node:fs';

export const wasmPath = new URL('../quickjs.wasm', import.meta.url);
export const wasmBytes = readFileSync(wasmPath);
