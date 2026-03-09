import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const urlExtBytes = readFileSync(resolve(__dirname, '..', 'extensions', 'url', 'url.so'));

describe('native WASM extensions', () => {
  it('should load the URL extension and parse a URL', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      const url = new URL('https://example.com:8080/path?query=value#hash');
      JSON.stringify({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        pathname: url.pathname,
        search: url.search,
        hash: url.hash,
        href: url.href,
        origin: url.origin,
        host: url.host,
      })
    `);
    const parsed = JSON.parse(result.toString());
    result.dispose();

    expect(parsed.protocol).toBe('https:');
    expect(parsed.hostname).toBe('example.com');
    expect(parsed.port).toBe('8080');
    expect(parsed.pathname).toBe('/path');
    expect(parsed.search).toBe('?query=value');
    expect(parsed.hash).toBe('#hash');
    expect(parsed.origin).toBe('https://example.com:8080');
    expect(parsed.host).toBe('example.com:8080');
  });

  it('should load the URLSearchParams extension', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      const params = new URLSearchParams('foo=bar&baz=qux&foo=two');
      JSON.stringify({
        foo: params.get('foo'),
        baz: params.get('baz'),
        hasFoo: params.has('foo'),
        hasNope: params.has('nope'),
        size: params.size,
        str: params.toString(),
      })
    `);
    const parsed = JSON.parse(result.toString());
    result.dispose();

    expect(parsed.foo).toBe('bar');
    expect(parsed.baz).toBe('qux');
    expect(parsed.hasFoo).toBe(true);
    expect(parsed.hasNope).toBe(false);
    expect(parsed.size).toBe(3);
    expect(parsed.str).toBe('foo=bar&baz=qux&foo=two');
  });

  it('should handle URL.toString() and URL.toJSON()', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      const url = new URL('https://user:pass@example.com/path');
      JSON.stringify({
        toString: url.toString(),
        toJSON: url.toJSON(),
        username: url.username,
        password: url.password,
      })
    `);
    const parsed = JSON.parse(result.toString());
    result.dispose();

    expect(parsed.username).toBe('user');
    expect(parsed.password).toBe('pass');
    expect(parsed.toString).toBe(parsed.toJSON);
    expect(parsed.toString).toContain('example.com');
  });

  it('should throw on invalid URL', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      try { new URL('not a url'); 'no error' } catch(e) { e.message }
    `);
    expect(result.toString()).toBe('Invalid URL');
    result.dispose();
  });

  it('should support URLSearchParams.set and delete', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      const params = new URLSearchParams('a=1&b=2&c=3');
      params.set('b', '20');
      params.delete('c');
      params.append('d', '4');
      params.toString()
    `);
    expect(result.toString()).toBe('a=1&b=20&d=4');
    result.dispose();
  });
});

describe('extension snapshot/restore', () => {
  it('should preserve URL objects across snapshot/restore', async () => {
    // Create VM with URL extension, create URL object, snapshot
    const vm1 = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    vm1.evalCode(`
      globalThis.savedUrl = new URL('https://example.com:3000/api?key=value#section');
    `).dispose();

    const snapshot = vm1.snapshot();
    vm1.dispose();

    // Restore with the same extension
    const vm2 = await QuickJS.restore(snapshot, {
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    // Access the URL object that was created before the snapshot
    const result = vm2.evalCode(`
      JSON.stringify({
        hostname: savedUrl.hostname,
        port: savedUrl.port,
        pathname: savedUrl.pathname,
        search: savedUrl.search,
        hash: savedUrl.hash,
      })
    `);
    const parsed = JSON.parse(result.toString());
    result.dispose();
    vm2.dispose();

    expect(parsed.hostname).toBe('example.com');
    expect(parsed.port).toBe('3000');
    expect(parsed.pathname).toBe('/api');
    expect(parsed.search).toBe('?key=value');
    expect(parsed.hash).toBe('#section');
  });

  it('should create new URL objects after restore', async () => {
    const vm1 = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    vm1.evalCode('globalThis.x = 1').dispose();
    const snapshot = vm1.snapshot();
    vm1.dispose();

    const vm2 = await QuickJS.restore(snapshot, {
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    // Create a NEW URL object in the restored VM
    const result = vm2.evalCode(`
      const url = new URL('http://localhost:8080/test');
      url.hostname
    `);
    expect(result.toString()).toBe('localhost');
    result.dispose();
    vm2.dispose();
  });

  it('should serialize/deserialize snapshots with extensions', async () => {
    const vm1 = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    vm1.evalCode(`
      globalThis.myUrl = new URL('https://test.com/page');
    `).dispose();

    const snapshot = vm1.snapshot();
    vm1.dispose();

    // Serialize and deserialize
    const bytes = QuickJS.serializeSnapshot(snapshot);
    const restored = QuickJS.deserializeSnapshot(bytes);

    // Verify extension metadata survived round-trip
    expect(restored.extensions).toHaveLength(1);
    expect(restored.extensions[0].name).toBe('url');
    expect(restored.extensions[0].memoryBase).toBe(snapshot.extensions[0].memoryBase);
    expect(restored.extensions[0].tableBase).toBe(snapshot.extensions[0].tableBase);

    // Restore and verify functionality
    const vm2 = await QuickJS.restore(restored, {
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm2.evalCode('myUrl.hostname');
    expect(result.toString()).toBe('test.com');
    result.dispose();
    vm2.dispose();
  });

  it('should handle full lifecycle: create -> eval -> snapshot -> serialize -> deserialize -> restore -> eval', async () => {
    // Create with extension
    const vm1 = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    // Use extension
    vm1.evalCode(`
      globalThis.urls = [
        new URL('https://a.com/1'),
        new URL('https://b.com/2'),
      ];
      globalThis.params = new URLSearchParams('x=1&y=2');
    `).dispose();

    // Snapshot
    const snapshot1 = vm1.snapshot();
    vm1.dispose();

    // Serialize
    const serialized = QuickJS.serializeSnapshot(snapshot1);

    // Deserialize
    const snapshot2 = QuickJS.deserializeSnapshot(serialized);

    // Restore
    const vm2 = await QuickJS.restore(snapshot2, {
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    // Verify state survived
    const result = vm2.evalCode(`
      JSON.stringify({
        url0: urls[0].hostname,
        url1: urls[1].hostname,
        paramX: params.get('x'),
        paramY: params.get('y'),
        newUrl: new URL('https://c.com/3').hostname,
      })
    `);
    const parsed = JSON.parse(result.toString());
    result.dispose();
    vm2.dispose();

    expect(parsed.url0).toBe('a.com');
    expect(parsed.url1).toBe('b.com');
    expect(parsed.paramX).toBe('1');
    expect(parsed.paramY).toBe('2');
    expect(parsed.newUrl).toBe('c.com');
  });
});
