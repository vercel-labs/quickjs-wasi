import { defineConfig } from 'vite';
import { copyFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

// Copy quickjs.wasm to public/ so Vite serves it as a static asset.
// The WASM file should have been built by the build script before Vite runs.
const wasmSrc = resolve(import.meta.dirname, '../../quickjs.wasm');
const publicDir = resolve(import.meta.dirname, 'public');
mkdirSync(publicDir, { recursive: true });
copyFileSync(wasmSrc, resolve(publicDir, 'quickjs.wasm'));

export default defineConfig({});
