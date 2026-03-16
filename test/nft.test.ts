import { describe, it, expect } from 'vitest';
import { nodeFileTrace } from '@vercel/nft';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('@vercel/nft', () => {
  it('should trace quickjs.wasm as a dependency of dist/index.js', async () => {
    const distIndex = resolve(__dirname, '..', 'dist', 'index.js');
    const { fileList } = await nodeFileTrace([distIndex]);
    const wasmFiles = [...fileList].filter((f) => f.endsWith('quickjs.wasm'));
    expect(wasmFiles.length).toBeGreaterThan(0);
  });
});
