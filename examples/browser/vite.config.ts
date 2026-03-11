import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

// Copy WASM/extension binaries to public/ so Vite serves them as static assets.
// These should have been built by the build script before Vite runs.
const repoRoot = resolve(import.meta.dirname, '../..');
const publicDir = resolve(import.meta.dirname, 'public');
mkdirSync(publicDir, { recursive: true });

copyFileSync(resolve(repoRoot, 'quickjs.wasm'), resolve(publicDir, 'quickjs.wasm'));

const urlExtSrc = resolve(repoRoot, 'extensions/url/url.so');
if (existsSync(urlExtSrc)) {
  copyFileSync(urlExtSrc, resolve(publicDir, 'url.so'));
}

export default defineConfig({
  plugins: [react()],
});
