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

const base64ExtSrc = resolve(repoRoot, 'extensions/base64/base64.so');
if (existsSync(base64ExtSrc)) {
  copyFileSync(base64ExtSrc, resolve(publicDir, 'base64.so'));
}

const headersExtSrc = resolve(repoRoot, 'extensions/headers/headers.so');
if (existsSync(headersExtSrc)) {
  copyFileSync(headersExtSrc, resolve(publicDir, 'headers.so'));
}

const structuredCloneExtSrc = resolve(repoRoot, 'extensions/structured-clone/structured-clone.so');
if (existsSync(structuredCloneExtSrc)) {
  copyFileSync(structuredCloneExtSrc, resolve(publicDir, 'structured-clone.so'));
}

const cryptoExtSrc = resolve(repoRoot, 'extensions/crypto/crypto.so');
if (existsSync(cryptoExtSrc)) {
  copyFileSync(cryptoExtSrc, resolve(publicDir, 'crypto.so'));
}

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, './src'),
    },
  },
});
