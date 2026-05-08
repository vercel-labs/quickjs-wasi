import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { QuickJS, type ExtensionDescriptor } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

const urlExtension: ExtensionDescriptor = {
  name: 'url',
  wasm: readFileSync(new URL('../extensions/url/url.so', import.meta.url)),
};
const cryptoExtension: ExtensionDescriptor = {
  name: 'crypto',
  wasm: readFileSync(new URL('../extensions/crypto/crypto.so', import.meta.url)),
};

describe('vm.versions', () => {
  it('should include quickjs-wasi version', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.versions['quickjs-wasi']).toBeDefined();
    expect(vm.versions['quickjs-wasi']).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('should include quickjs version', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(vm.versions.quickjs).toBeDefined();
    expect(vm.versions.quickjs).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('should only have quickjs-wasi and quickjs with no extensions', async () => {
    using vm = await QuickJS.create(wasmBytes);
    expect(Object.keys(vm.versions).sort()).toEqual(['quickjs', 'quickjs-wasi']);
  });

  it('should return the same object on repeated access (cached)', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const v1 = vm.versions;
    const v2 = vm.versions;
    expect(v1).toBe(v2);
  });

  it('should throw if VM is disposed', async () => {
    const vm = await QuickJS.create(wasmBytes);
    vm.dispose();
    expect(() => vm.versions).toThrow();
  });
});

describe('vm.versions with extensions', () => {
  it('should include ada version with url extension', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [urlExtension],
    });
    expect(vm.versions.ada).toBeDefined();
    expect(vm.versions.ada).toMatch(/^\d+\.\d+\.\d+/);
    // Should still have the base entries
    expect(vm.versions['quickjs-wasi']).toBeDefined();
    expect(vm.versions.quickjs).toBeDefined();
  });

  it('should include mbedtls version with crypto extension', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [cryptoExtension],
    });
    expect(vm.versions.mbedtls).toBeDefined();
    expect(vm.versions.mbedtls).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('should merge versions from multiple extensions', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [urlExtension, cryptoExtension],
    });
    expect(vm.versions['quickjs-wasi']).toBeDefined();
    expect(vm.versions.quickjs).toBeDefined();
    expect(vm.versions.ada).toBeDefined();
    expect(vm.versions.mbedtls).toBeDefined();
    expect(Object.keys(vm.versions).length).toBeGreaterThanOrEqual(4);
  });

  it('should work after snapshot restore', async () => {
    const vm1 = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [urlExtension],
    });
    vm1.evalCode('globalThis.x = 1').dispose();
    const snapshot = vm1.snapshot();
    vm1.dispose();

    using vm2 = await QuickJS.restore(snapshot, {
      wasm: wasmBytes,
      extensions: [urlExtension],
    });

    expect(vm2.versions['quickjs-wasi']).toBeDefined();
    expect(vm2.versions.quickjs).toBeDefined();
    expect(vm2.versions.ada).toBeDefined();
  });
});
