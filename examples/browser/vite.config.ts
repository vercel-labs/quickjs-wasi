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

const domExceptionExtSrc = resolve(repoRoot, 'extensions/dom-exception/dom-exception.so');
if (existsSync(domExceptionExtSrc)) {
  copyFileSync(domExceptionExtSrc, resolve(publicDir, 'dom-exception.so'));
}

const queueMicrotaskExtSrc = resolve(repoRoot, 'extensions/queue-microtask/queue-microtask.so');
if (existsSync(queueMicrotaskExtSrc)) {
  copyFileSync(queueMicrotaskExtSrc, resolve(publicDir, 'queue-microtask.so'));
}

export default defineConfig({
  plugins: [tailwindcss(), react()],
});
