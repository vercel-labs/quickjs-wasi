/**
 * Web Platform Tests (WPT) for URL and URLSearchParams
 *
 * Uses the official WPT urltestdata.json to verify WHATWG URL Standard compliance.
 * The test data is from https://github.com/web-platform-tests/wpt/blob/master/url/resources/urltestdata.json
 *
 * Each WPT entry maps to an individual vitest test case for clear pass/fail reporting.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';
import { readFileSync } from 'node:fs';

const urlExtBytes = readFileSync(new URL('../extensions/url/url.so', import.meta.url));

interface WPTTestEntry {
  input: string;
  base: string | null;
  failure?: boolean;
  href?: string;
  origin?: string;
  protocol?: string;
  username?: string;
  password?: string;
  host?: string;
  hostname?: string;
  port?: string;
  pathname?: string;
  search?: string;
  hash?: string;
}

// Load WPT test data, filtering out comment strings
const wptData: (WPTTestEntry | string)[] = JSON.parse(
  readFileSync(new URL('wpt-urltestdata.json', import.meta.url), 'utf-8')
);
const wptTests = wptData.filter((entry): entry is WPTTestEntry => typeof entry === 'object');
const successTests = wptTests.filter(t => !t.failure);
const failureTests = wptTests.filter(t => t.failure);

// Helper: escape a string for safe embedding in JS
function escapeJS(s: string): string {
  return JSON.stringify(s);
}

// Build a label for a test entry
function testLabel(t: WPTTestEntry): string {
  const input = JSON.stringify(t.input);
  const base = t.base !== null ? ` base=${JSON.stringify(t.base)}` : '';
  // Truncate long labels
  const label = `${input}${base}`;
  return label.length > 120 ? label.slice(0, 117) + '...' : label;
}

// ─── Property descriptors ────────────────────────────────────────────────────

describe('URL property descriptors', () => {
  async function evalJSON(code: string) {
    const vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });
    const result = vm.evalCode(`JSON.stringify(${code})`);
    const parsed = JSON.parse(result.toString());
    result.dispose();
    vm.dispose();
    return parsed;
  }

  it('URL.prototype should be non-writable, non-enumerable, non-configurable', async () => {
    const desc = await evalJSON(`(() => {
      const d = Object.getOwnPropertyDescriptor(URL, 'prototype');
      return { writable: d.writable, enumerable: d.enumerable, configurable: d.configurable };
    })()`);
    expect(desc.writable).toBe(false);
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(false);
  });

  it('URLSearchParams.prototype should be non-writable, non-enumerable, non-configurable', async () => {
    const desc = await evalJSON(`(() => {
      const d = Object.getOwnPropertyDescriptor(URLSearchParams, 'prototype');
      return { writable: d.writable, enumerable: d.enumerable, configurable: d.configurable };
    })()`);
    expect(desc.writable).toBe(false);
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(false);
  });
});

// ─── WPT URL Parsing (success cases) ─────────────────────────────────────────

describe('WPT URL parsing', () => {
  // Pre-compute all results in a single VM to avoid creating 604 VMs
  type ParseResult = {
    href: string; origin: string; protocol: string;
    username: string; password: string; host: string;
    hostname: string; port: string; pathname: string;
    search: string; hash: string;
  } | { error: string };

  let results: ParseResult[];

  beforeAll(async () => {
    const vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    // Run all success tests in batches inside the VM
    results = [];
    const batchSize = 50;
    for (let i = 0; i < successTests.length; i += batchSize) {
      const batch = successTests.slice(i, i + batchSize);
      const js = `(function(){var r=[];${batch.map((t) => {
        const input = escapeJS(t.input);
        const base = t.base !== null ? escapeJS(t.base) : 'undefined';
        return `try{var u=new URL(${input},${base});r.push({href:u.href,origin:u.origin,protocol:u.protocol,username:u.username,password:u.password,host:u.host,hostname:u.hostname,port:u.port,pathname:u.pathname,search:u.search,hash:u.hash})}catch(e){r.push({error:e.message})}`;
      }).join(';')};return JSON.stringify(r)})()`;

      const result = vm.evalCode(js);
      const batchResults: ParseResult[] = JSON.parse(result.toString());
      result.dispose();
      results.push(...batchResults);
    }

    vm.dispose();
  });

  for (let i = 0; i < successTests.length; i++) {
    const t = successTests[i];
    it(`parse: ${testLabel(t)}`, () => {
      const r = results[i];
      expect(r).toBeDefined();

      if ('error' in r) {
        expect.unreachable(`should parse successfully but threw: ${r.error}`);
        return;
      }

      const props = ['href', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'] as const;
      for (const prop of props) {
        if (t[prop] !== undefined) {
          expect(r[prop], `${prop}`).toBe(t[prop]);
        }
      }
      if (t.origin !== undefined) {
        expect(r.origin, 'origin').toBe(t.origin);
      }
    });
  }
});

// ─── WPT URL Parsing (failure cases) ─────────────────────────────────────────

describe('WPT URL rejection', () => {
  type RejectResult = { accepted: true; href: string } | { accepted: false };
  let results: RejectResult[];

  beforeAll(async () => {
    const vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });

    results = [];
    const batchSize = 50;
    for (let i = 0; i < failureTests.length; i += batchSize) {
      const batch = failureTests.slice(i, i + batchSize);
      const js = `(function(){var r=[];${batch.map((t) => {
        const input = escapeJS(t.input);
        const base = t.base !== null ? escapeJS(t.base) : 'undefined';
        return `try{var u=new URL(${input},${base});r.push({accepted:true,href:u.href})}catch(e){r.push({accepted:false})}`;
      }).join(';')};return JSON.stringify(r)})()`;

      const result = vm.evalCode(js);
      const batchResults: RejectResult[] = JSON.parse(result.toString());
      result.dispose();
      results.push(...batchResults);
    }

    vm.dispose();
  });

  for (let i = 0; i < failureTests.length; i++) {
    const t = failureTests[i];
    it(`reject: ${testLabel(t)}`, () => {
      const r = results[i];
      expect(r).toBeDefined();
      expect(r.accepted, r.accepted ? `should reject but got href=${(r as any).href}` : '').toBe(false);
    });
  }
});

// ─── URLSearchParams ─────────────────────────────────────────────────────────

describe('WPT URLSearchParams', () => {
  let vm: QuickJS;

  beforeAll(async () => {
    vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });
  });

  afterAll(() => {
    vm.dispose();
  });

  it('should parse basic key=value pairs', () => {
    const r = vm.evalCode(`
      JSON.stringify([...new URLSearchParams('a=b&c=d').entries()].map(([k,v])=>k+'='+v))
    `);
    expect(JSON.parse(r.toString())).toEqual(['a=b', 'c=d']);
    r.dispose();
  });

  it('should parse empty values', () => {
    const r = vm.evalCode(`
      JSON.stringify([...new URLSearchParams('a=&b=c').entries()].map(([k,v])=>k+'='+v))
    `);
    expect(JSON.parse(r.toString())).toEqual(['a=', 'b=c']);
    r.dispose();
  });

  it('should parse keys without values', () => {
    const r = vm.evalCode(`
      JSON.stringify([...new URLSearchParams('a&b=c').entries()].map(([k,v])=>k+'='+v))
    `);
    expect(JSON.parse(r.toString())).toEqual(['a=', 'b=c']);
    r.dispose();
  });

  it('should decode + as space', () => {
    const r = vm.evalCode(`new URLSearchParams('a=b+c').get('a')`);
    expect(r.toString()).toBe('b c');
    r.dispose();
  });

  it('should decode %20 as space', () => {
    const r = vm.evalCode(`new URLSearchParams('a=%20b').get('a')`);
    expect(r.toString()).toBe(' b');
    r.dispose();
  });

  it('should support multiple same keys via getAll()', () => {
    const r = vm.evalCode(`JSON.stringify(new URLSearchParams('a=1&a=2').getAll('a'))`);
    expect(JSON.parse(r.toString())).toEqual(['1', '2']);
    r.dispose();
  });

  it('should strip leading ?', () => {
    const r = vm.evalCode(`
      JSON.stringify([...new URLSearchParams('?a=1&b=2').entries()].map(([k,v])=>k+'='+v))
    `);
    expect(JSON.parse(r.toString())).toEqual(['a=1', 'b=2']);
    r.dispose();
  });

  it('should handle empty string', () => {
    const r = vm.evalCode(`new URLSearchParams('').size`);
    expect(r.toString()).toBe('0');
    r.dispose();
  });

  it('should encode space as +', () => {
    const r = vm.evalCode(`
      var p=new URLSearchParams();p.set('a','b c');p.toString()
    `);
    expect(r.toString()).toBe('a=b+c');
    r.dispose();
  });

  it('should encode & as %26', () => {
    const r = vm.evalCode(`
      var p=new URLSearchParams();p.set('a','b&c');p.toString()
    `);
    expect(r.toString()).toBe('a=b%26c');
    r.dispose();
  });

  it('should encode = as %3D', () => {
    const r = vm.evalCode(`
      var p=new URLSearchParams();p.set('a','b=c');p.toString()
    `);
    expect(r.toString()).toBe('a=b%3Dc');
    r.dispose();
  });

  it('should encode + as %2B', () => {
    const r = vm.evalCode(`
      var p=new URLSearchParams();p.set('a','b+c');p.toString()
    `);
    expect(r.toString()).toBe('a=b%2Bc');
    r.dispose();
  });

  it('should sort() by key name', () => {
    const r = vm.evalCode(`
      var p=new URLSearchParams('c=3&a=1&b=2&a=0');p.sort();p.toString()
    `);
    expect(r.toString()).toBe('a=1&a=0&b=2&c=3');
    r.dispose();
  });

  it('should delete(key, value) only matching pairs', () => {
    const r = vm.evalCode(`
      var p=new URLSearchParams('a=1&b=2&a=3');p.delete('a','1');p.toString()
    `);
    expect(r.toString()).toBe('b=2&a=3');
    r.dispose();
  });

  it('should has(key, value) check specific values', () => {
    const r = vm.evalCode(`
      var p=new URLSearchParams('a=1&b=2&a=3');
      JSON.stringify([p.has('a','1'),p.has('a','4'),p.has('b'),p.has('c')])
    `);
    expect(JSON.parse(r.toString())).toEqual([true, false, true, false]);
    r.dispose();
  });

  it('should forEach(callback)', () => {
    const r = vm.evalCode(`
      var e=[];new URLSearchParams('x=1&y=2&z=3').forEach(function(v,k){e.push([k,v])});JSON.stringify(e)
    `);
    expect(JSON.parse(r.toString())).toEqual([['x', '1'], ['y', '2'], ['z', '3']]);
    r.dispose();
  });

  it('should iterate via entries()', () => {
    const r = vm.evalCode(`
      var e=[];for(var p of new URLSearchParams('a=1&b=2').entries())e.push(p);JSON.stringify(e)
    `);
    expect(JSON.parse(r.toString())).toEqual([['a', '1'], ['b', '2']]);
    r.dispose();
  });

  it('should iterate via keys()', () => {
    const r = vm.evalCode(`JSON.stringify([...new URLSearchParams('a=1&b=2&c=3').keys()])`);
    expect(JSON.parse(r.toString())).toEqual(['a', 'b', 'c']);
    r.dispose();
  });

  it('should iterate via values()', () => {
    const r = vm.evalCode(`JSON.stringify([...new URLSearchParams('a=1&b=2&c=3').values()])`);
    expect(JSON.parse(r.toString())).toEqual(['1', '2', '3']);
    r.dispose();
  });

  it('should have Symbol.iterator aliased to entries', () => {
    const r = vm.evalCode(`URLSearchParams.prototype[Symbol.iterator] === URLSearchParams.prototype.entries`);
    expect(r.toString()).toBe('true');
    r.dispose();
  });

  it('should be iterable with for...of via Symbol.iterator', () => {
    const r = vm.evalCode(`
      var e=[];for(var p of new URLSearchParams('x=1&y=2'))e.push(p);JSON.stringify(e)
    `);
    expect(JSON.parse(r.toString())).toEqual([['x', '1'], ['y', '2']]);
    r.dispose();
  });

  it('should be iterable with spread via Symbol.iterator', () => {
    const r = vm.evalCode(`JSON.stringify([...new URLSearchParams('a=1&b=2&c=3')])`);
    expect(JSON.parse(r.toString())).toEqual([['a', '1'], ['b', '2'], ['c', '3']]);
    r.dispose();
  });

  it('should be iterable with Array.from via Symbol.iterator', () => {
    const r = vm.evalCode(`JSON.stringify(Array.from(new URLSearchParams('k=v')))`);
    expect(JSON.parse(r.toString())).toEqual([['k', 'v']]);
    r.dispose();
  });

  it('should destructure via Symbol.iterator', () => {
    const r = vm.evalCode(`
      const [[k1,v1],[k2,v2]] = new URLSearchParams('a=1&b=2');
      JSON.stringify({k1,v1,k2,v2})
    `);
    expect(JSON.parse(r.toString())).toEqual({k1:'a',v1:'1',k2:'b',v2:'2'});
    r.dispose();
  });
});

// ─── URL property setters ────────────────────────────────────────────────────

describe('URL property setters', () => {
  let vm: QuickJS;

  beforeAll(async () => {
    vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });
  });

  afterAll(() => {
    vm.dispose();
  });

  it('protocol setter', () => {
    const r = vm.evalCode(`var u=new URL('https://example.com/path');u.protocol='http:';u.protocol+' '+u.href`);
    const [protocol, href] = r.toString().split(' ');
    r.dispose();
    expect(protocol).toBe('http:');
    expect(href).toContain('http://');
  });

  it('hostname setter', () => {
    const r = vm.evalCode(`var u=new URL('https://example.com/path');u.hostname='other.com';u.href`);
    expect(r.toString()).toBe('https://other.com/path');
    r.dispose();
  });

  it('port setter', () => {
    const r = vm.evalCode(`var u=new URL('https://example.com/path');u.port='8080';u.host`);
    expect(r.toString()).toBe('example.com:8080');
    r.dispose();
  });

  it('pathname setter', () => {
    const r = vm.evalCode(`var u=new URL('https://example.com/old');u.pathname='/new/path';u.pathname`);
    expect(r.toString()).toBe('/new/path');
    r.dispose();
  });

  it('search setter', () => {
    const r = vm.evalCode(`var u=new URL('https://example.com/path');u.search='?key=value';u.search`);
    expect(r.toString()).toBe('?key=value');
    r.dispose();
  });

  it('hash setter', () => {
    const r = vm.evalCode(`var u=new URL('https://example.com/path');u.hash='#section';u.hash`);
    expect(r.toString()).toBe('#section');
    r.dispose();
  });

  it('username and password setters', () => {
    const r = vm.evalCode(`var u=new URL('https://example.com/path');u.username='user';u.password='pass';u.href`);
    expect(r.toString()).toContain('user:pass@');
    r.dispose();
  });

  it('href setter', () => {
    const r = vm.evalCode(`
      var u=new URL('https://example.com');u.href='https://other.com:8080/new?q=1#frag';
      JSON.stringify({h:u.hostname,po:u.port,pa:u.pathname,s:u.search,ha:u.hash})
    `);
    const p = JSON.parse(r.toString());
    r.dispose();
    expect(p.h).toBe('other.com');
    expect(p.po).toBe('8080');
    expect(p.pa).toBe('/new');
    expect(p.s).toBe('?q=1');
    expect(p.ha).toBe('#frag');
  });
});

// ─── URL.canParse() ──────────────────────────────────────────────────────────

describe('URL.canParse()', () => {
  let vm: QuickJS;

  beforeAll(async () => {
    vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });
  });

  afterAll(() => {
    vm.dispose();
  });

  it('returns true for valid absolute URLs', () => {
    const r = vm.evalCode(`JSON.stringify([URL.canParse('https://example.com'),URL.canParse('http://localhost:8080'),URL.canParse('ftp://files.example.com/path')])`);
    expect(JSON.parse(r.toString())).toEqual([true, true, true]);
    r.dispose();
  });

  it('returns false for invalid URLs', () => {
    const r = vm.evalCode(`JSON.stringify([URL.canParse('not a url'),URL.canParse(''),URL.canParse('://missing-scheme')])`);
    expect(JSON.parse(r.toString())).toEqual([false, false, false]);
    r.dispose();
  });

  it('supports base URL parameter', () => {
    const r = vm.evalCode(`JSON.stringify([URL.canParse('/path','https://example.com'),URL.canParse('relative','https://example.com/base/'),URL.canParse('/path')])`);
    expect(JSON.parse(r.toString())).toEqual([true, true, false]);
    r.dispose();
  });
});

// ─── WHATWG URL edge cases ───────────────────────────────────────────────────

describe('WHATWG URL edge cases', () => {
  let vm: QuickJS;

  beforeAll(async () => {
    vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'url', wasm: urlExtBytes }],
    });
  });

  afterAll(() => {
    vm.dispose();
  });

  it('strips default port 80 for http', () => {
    const r = vm.evalCode(`new URL('http://example.com:80').port`);
    expect(r.toString()).toBe('');
    r.dispose();
  });

  it('strips default port 443 for https', () => {
    const r = vm.evalCode(`new URL('https://example.com:443').port`);
    expect(r.toString()).toBe('');
    r.dispose();
  });

  it('strips default port 21 for ftp', () => {
    const r = vm.evalCode(`new URL('ftp://example.com:21').port`);
    expect(r.toString()).toBe('');
    r.dispose();
  });

  it('preserves non-default ports', () => {
    const r = vm.evalCode(`new URL('http://example.com:8080').port`);
    expect(r.toString()).toBe('8080');
    r.dispose();
  });

  it('normalizes hostnames to lowercase', () => {
    const r = vm.evalCode(`new URL('https://EXAMPLE.COM').hostname`);
    expect(r.toString()).toBe('example.com');
    r.dispose();
  });

  it('percent-encodes spaces in paths', () => {
    const r = vm.evalCode(`new URL('https://example.com/path with spaces').pathname`);
    expect(r.toString()).toBe('/path%20with%20spaces');
    r.dispose();
  });

  it('preserves already-encoded paths', () => {
    const r = vm.evalCode(`new URL('https://example.com/path%20already%20encoded').pathname`);
    expect(r.toString()).toBe('/path%20already%20encoded');
    r.dispose();
  });

  it('resolves absolute path against base', () => {
    const r = vm.evalCode(`new URL('/absolute','https://example.com/base/').href`);
    expect(r.toString()).toBe('https://example.com/absolute');
    r.dispose();
  });

  it('resolves relative path against base', () => {
    const r = vm.evalCode(`new URL('relative','https://example.com/base/').href`);
    expect(r.toString()).toBe('https://example.com/base/relative');
    r.dispose();
  });

  it('resolves .. path traversal against base', () => {
    const r = vm.evalCode(`new URL('../up','https://example.com/a/b/c').href`);
    expect(r.toString()).toBe('https://example.com/a/up');
    r.dispose();
  });

  it('resolves query-only against base', () => {
    const r = vm.evalCode(`new URL('?query','https://example.com/path').href`);
    expect(r.toString()).toBe('https://example.com/path?query');
    r.dispose();
  });

  it('resolves hash-only against base', () => {
    const r = vm.evalCode(`new URL('#hash','https://example.com/path').href`);
    expect(r.toString()).toBe('https://example.com/path#hash');
    r.dispose();
  });

  it('resolves protocol-relative URL against base', () => {
    const r = vm.evalCode(`new URL('//other.com/path','https://example.com/').href`);
    expect(r.toString()).toBe('https://other.com/path');
    r.dispose();
  });

  it('handles IPv6 addresses', () => {
    const r = vm.evalCode(`JSON.stringify({h:new URL('https://[::1]:8080/path').hostname,ho:new URL('https://[::1]:8080/path').host})`);
    const p = JSON.parse(r.toString());
    r.dispose();
    expect(p.h).toBe('[::1]');
    expect(p.ho).toBe('[::1]:8080');
  });

  it('handles data: URLs', () => {
    const r = vm.evalCode(`JSON.stringify({p:new URL('data:text/html,<h1>Hello</h1>').protocol,o:new URL('data:text/html,<h1>Hello</h1>').origin})`);
    const p = JSON.parse(r.toString());
    r.dispose();
    expect(p.p).toBe('data:');
    expect(p.o).toBe('null');
  });

  it('handles blob: URLs', () => {
    const r = vm.evalCode(`new URL('blob:https://example.com/550e8400-e29b-41d4-a716-446655440000').protocol`);
    expect(r.toString()).toBe('blob:');
    r.dispose();
  });

  it('handles file: URLs', () => {
    const r = vm.evalCode(`JSON.stringify({p:new URL('file:///tmp/test.txt').protocol,pa:new URL('file:///tmp/test.txt').pathname})`);
    const p = JSON.parse(r.toString());
    r.dispose();
    expect(p.p).toBe('file:');
    expect(p.pa).toBe('/tmp/test.txt');
  });
});
