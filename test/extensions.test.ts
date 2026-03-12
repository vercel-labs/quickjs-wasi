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

  it('should have correct constructor.name on URL and URLSearchParams instances', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      JSON.stringify({
        urlCtorName: new URL('https://example.com').constructor.name,
        urlInstanceOf: new URL('https://example.com') instanceof URL,
        spCtorName: new URLSearchParams('a=1').constructor.name,
        spInstanceOf: new URLSearchParams('a=1') instanceof URLSearchParams,
      })
    `);
    const parsed = JSON.parse(result.toString());
    result.dispose();

    expect(parsed.urlCtorName).toBe('URL');
    expect(parsed.urlInstanceOf).toBe(true);
    expect(parsed.spCtorName).toBe('URLSearchParams');
    expect(parsed.spInstanceOf).toBe(true);
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

  // --- New ada-backed feature tests ---

  it('should support base URL resolution', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      const url = new URL('/api/data', 'https://example.com:3000');
      JSON.stringify({
        href: url.href,
        hostname: url.hostname,
        port: url.port,
        pathname: url.pathname,
      })
    `);
    const parsed = JSON.parse(result.toString());
    result.dispose();

    expect(parsed.href).toBe('https://example.com:3000/api/data');
    expect(parsed.hostname).toBe('example.com');
    expect(parsed.port).toBe('3000');
    expect(parsed.pathname).toBe('/api/data');
  });

  it('should support URL.canParse() static method', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      JSON.stringify({
        valid: URL.canParse('https://example.com'),
        invalid: URL.canParse('not a url'),
        withBase: URL.canParse('/path', 'https://example.com'),
      })
    `);
    const parsed = JSON.parse(result.toString());
    result.dispose();

    expect(parsed.valid).toBe(true);
    expect(parsed.invalid).toBe(false);
    expect(parsed.withBase).toBe(true);
  });

  it('should support URL property setters', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      const url = new URL('https://example.com/old');
      url.pathname = '/new';
      url.hash = '#section';
      url.search = '?key=val';
      JSON.stringify({
        pathname: url.pathname,
        hash: url.hash,
        search: url.search,
        href: url.href,
      })
    `);
    const parsed = JSON.parse(result.toString());
    result.dispose();

    expect(parsed.pathname).toBe('/new');
    expect(parsed.hash).toBe('#section');
    expect(parsed.search).toBe('?key=val');
    expect(parsed.href).toBe('https://example.com/new?key=val#section');
  });

  it('should strip default ports (WHATWG compliance)', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      const url = new URL('https://example.com:443/path');
      JSON.stringify({
        port: url.port,
        host: url.host,
        origin: url.origin,
      })
    `);
    const parsed = JSON.parse(result.toString());
    result.dispose();

    // WHATWG URL standard: default port for https (443) should be stripped
    expect(parsed.port).toBe('');
    expect(parsed.host).toBe('example.com');
    expect(parsed.origin).toBe('https://example.com');
  });

  it('should handle percent-encoding in URLs', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      const url = new URL('https://example.com/path with spaces?q=hello world');
      JSON.stringify({
        pathname: url.pathname,
        search: url.search,
      })
    `);
    const parsed = JSON.parse(result.toString());
    result.dispose();

    expect(parsed.pathname).toBe('/path%20with%20spaces');
    expect(parsed.search).toBe('?q=hello%20world');
  });

  it('should support URLSearchParams.sort()', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      const params = new URLSearchParams('c=3&a=1&b=2');
      params.sort();
      params.toString()
    `);
    expect(result.toString()).toBe('a=1&b=2&c=3');
    result.dispose();
  });

  it('should support URLSearchParams.getAll()', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      const params = new URLSearchParams('foo=1&bar=2&foo=3');
      JSON.stringify(params.getAll('foo'))
    `);
    expect(JSON.parse(result.toString())).toEqual(['1', '3']);
    result.dispose();
  });

  it('should support URLSearchParams.forEach()', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      const params = new URLSearchParams('a=1&b=2');
      const entries = [];
      params.forEach((value, key) => {
        entries.push(key + '=' + value);
      });
      JSON.stringify(entries)
    `);
    expect(JSON.parse(result.toString())).toEqual(['a=1', 'b=2']);
    result.dispose();
  });

  it('should support URLSearchParams iterator methods', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      const params = new URLSearchParams('a=1&b=2');
      const keys = [...params.keys()];
      const values = [...params.values()];
      const entries = [...params.entries()].map(([k, v]) => k + '=' + v);
      JSON.stringify({ keys, values, entries })
    `);
    const parsed = JSON.parse(result.toString());
    result.dispose();

    expect(parsed.keys).toEqual(['a', 'b']);
    expect(parsed.values).toEqual(['1', '2']);
    expect(parsed.entries).toEqual(['a=1', 'b=2']);
  });

  it('should handle URLSearchParams percent-encoding', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      const params = new URLSearchParams();
      params.set('key', 'hello world');
      params.set('special', 'a&b=c');
      params.toString()
    `);
    // WHATWG URL standard encodes spaces as + in search params
    expect(result.toString()).toBe('key=hello+world&special=a%26b%3Dc');
    result.dispose();
  });

  it('should define URL on globalThis as writable, configurable, non-enumerable', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      JSON.stringify(Object.getOwnPropertyDescriptor(globalThis, 'URL'))
    `);
    const desc = JSON.parse(result.toString());
    result.dispose();

    expect(desc.writable).toBe(true);
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(true);
  });

  it('should define URLSearchParams on globalThis as writable, configurable, non-enumerable', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      JSON.stringify(Object.getOwnPropertyDescriptor(globalThis, 'URLSearchParams'))
    `);
    const desc = JSON.parse(result.toString());
    result.dispose();

    expect(desc.writable).toBe(true);
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(true);
  });

  it('should normalize hostnames to lowercase', async () => {
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    const result = vm.evalCode(`
      const url = new URL('https://EXAMPLE.COM/Path');
      url.hostname
    `);
    expect(result.toString()).toBe('example.com');
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
