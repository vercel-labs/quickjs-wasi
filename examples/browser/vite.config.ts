import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

// Copy WASM/extension binaries to public/ so Vite serves them as static assets.
const repoRoot = resolve(import.meta.dirname, '../..');
const publicDir = resolve(import.meta.dirname, 'public');
mkdirSync(publicDir, { recursive: true });

copyFileSync(resolve(repoRoot, 'quickjs.wasm'), resolve(publicDir, 'quickjs.wasm'));

const urlExtSrc = resolve(repoRoot, 'extensions/url/url.so');
if (existsSync(urlExtSrc)) {
  copyFileSync(urlExtSrc, resolve(publicDir, 'url.so'));
}

const encodingExtSrc = resolve(repoRoot, 'extensions/encoding/encoding.so');
if (existsSync(encodingExtSrc)) {
  copyFileSync(encodingExtSrc, resolve(publicDir, 'encoding.so'));
}

export default defineConfig({
  plugins: [tailwindcss(), react()],
});
