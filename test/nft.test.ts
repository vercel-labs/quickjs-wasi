import { describe, it, expect } from 'vitest';
import { nodeFileTrace } from '@vercel/nft';
import { fileURLToPath } from 'node:url';

const dist = (...parts: string[]) => fileURLToPath(new URL(['../dist', ...parts].join('/'), import.meta.url));

describe('@vercel/nft', () => {
  it('should trace quickjs.wasm as a dependency of dist/index.js', async () => {
    const { fileList } = await nodeFileTrace([dist('index.js')]);
    const wasmFiles = [...fileList].filter((f) => f.endsWith('quickjs.wasm'));
    expect(wasmFiles.length).toBeGreaterThan(0);
  });

  it.each([
    ['url', 'extensions/url/url.so'],
    ['encoding', 'extensions/encoding/encoding.so'],
    ['base64', 'extensions/base64/base64.so'],
    ['headers', 'extensions/headers/headers.so'],
    ['crypto', 'extensions/crypto/crypto.so'],
    ['structured-clone', 'extensions/structured-clone/structured-clone.so'],
  ])('should trace %s extension .so file', async (name, soPath) => {
    const { fileList } = await nodeFileTrace([dist(`${name}.js`)]);
    const soFiles = [...fileList].filter((f) => f.endsWith(soPath));
    expect(soFiles.length).toBeGreaterThan(0);
  });
});
