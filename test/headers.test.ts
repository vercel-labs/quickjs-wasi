import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';
import { readFileSync } from 'node:fs';

const headersExtBytes = readFileSync(new URL('../extensions/headers/headers.so', import.meta.url));

async function createVM() {
  return QuickJS.create({
    wasm: wasmBytes,
    extensions: [{ name: 'headers', wasm: headersExtBytes }],
  });
}

async function evalJSON(code: string) {
  using vm = await createVM();
  const result = vm.evalCode(`JSON.stringify(${code})`);
  const parsed = JSON.parse(result.toString());
  result.dispose();
  return parsed;
}

async function evalStr(code: string) {
  using vm = await createVM();
  const result = vm.evalCode(code);
  const str = result.toString();
  result.dispose();
  return str;
}

// ---- Property descriptors (match browser behavior) ----

describe('Headers globalThis property', () => {
  it('should define Headers on globalThis as writable, configurable, non-enumerable', async () => {
    const desc = await evalJSON(`Object.getOwnPropertyDescriptor(globalThis, 'Headers')`);
    expect(desc.writable).toBe(true);
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(true);
  });

  it('Headers.prototype should be non-writable, non-enumerable, non-configurable', async () => {
    const desc = await evalJSON(`(() => {
      const d = Object.getOwnPropertyDescriptor(Headers, 'prototype');
      return { writable: d.writable, enumerable: d.enumerable, configurable: d.configurable };
    })()`);
    expect(desc.writable).toBe(false);
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(false);
  });
});

// ---- WPT: headers-basic ----

describe('WPT headers-basic', () => {
  it('Headers has the expected methods', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers();
      return {
        hasAppend: typeof h.append === 'function',
        hasDelete: typeof h.delete === 'function',
        hasGet: typeof h.get === 'function',
        hasHas: typeof h.has === 'function',
        hasSet: typeof h.set === 'function',
        hasEntries: typeof h.entries === 'function',
        hasKeys: typeof h.keys === 'function',
        hasValues: typeof h.values === 'function',
        hasForEach: typeof h.forEach === 'function',
        hasGetSetCookie: typeof h.getSetCookie === 'function',
      };
    })()`);
    expect(result.hasAppend).toBe(true);
    expect(result.hasDelete).toBe(true);
    expect(result.hasGet).toBe(true);
    expect(result.hasHas).toBe(true);
    expect(result.hasSet).toBe(true);
    expect(result.hasEntries).toBe(true);
    expect(result.hasKeys).toBe(true);
    expect(result.hasValues).toBe(true);
    expect(result.hasForEach).toBe(true);
    expect(result.hasGetSetCookie).toBe(true);
  });

  it('constructor with no args creates empty headers', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers();
      return { has: h.has('test'), get: h.get('test') };
    })()`);
    expect(result.has).toBe(false);
    expect(result.get).toBe(null);
  });

  it('constructor with record init', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers({ 'Content-Type': 'text/html', 'Accept': 'application/json' });
      return { ct: h.get('content-type'), accept: h.get('accept') };
    })()`);
    expect(result.ct).toBe('text/html');
    expect(result.accept).toBe('application/json');
  });

  it('constructor with sequence init', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers([['Content-Type', 'text/html'], ['Accept', 'application/json']]);
      return { ct: h.get('content-type'), accept: h.get('accept') };
    })()`);
    expect(result.ct).toBe('text/html');
    expect(result.accept).toBe('application/json');
  });

  it('constructor with Headers init (copy)', async () => {
    const result = await evalJSON(`(() => {
      const h1 = new Headers({ 'X-Foo': 'bar' });
      const h2 = new Headers(h1);
      h2.set('X-Foo', 'baz');
      return { h1: h1.get('x-foo'), h2: h2.get('x-foo') };
    })()`);
    expect(result.h1).toBe('bar');
    expect(result.h2).toBe('baz');
  });

  it('constructor throws on invalid sequence length', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      try { new Headers([['a']]); 'no error'; } catch(e) { e instanceof TypeError ? 'TypeError' : e.message; }
    `);
    expect(result.toString()).toBe('TypeError');
    result.dispose();
  });
});

// ---- WPT: headers-casing ----

describe('WPT headers-casing', () => {
  it('get is case-insensitive', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers();
      h.set('Content-Type', 'text/html');
      return {
        lower: h.get('content-type'),
        upper: h.get('CONTENT-TYPE'),
        mixed: h.get('Content-Type'),
      };
    })()`);
    expect(result.lower).toBe('text/html');
    expect(result.upper).toBe('text/html');
    expect(result.mixed).toBe('text/html');
  });

  it('has is case-insensitive', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers();
      h.set('X-Custom', 'value');
      return {
        lower: h.has('x-custom'),
        upper: h.has('X-CUSTOM'),
        original: h.has('X-Custom'),
      };
    })()`);
    expect(result.lower).toBe(true);
    expect(result.upper).toBe(true);
    expect(result.original).toBe(true);
  });

  it('delete is case-insensitive', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers();
      h.set('X-Custom', 'value');
      h.delete('x-custom');
      return h.has('X-Custom');
    })()`);
    expect(result).toBe(false);
  });

  it('append is case-insensitive for combining', async () => {
    const result = await evalStr(`(() => {
      const h = new Headers();
      h.append('Accept', 'text/html');
      h.append('accept', 'application/json');
      return h.get('accept');
    })()`);
    expect(result).toBe('text/html, application/json');
  });
});

// ---- WPT: headers-combine ----

describe('WPT headers-combine', () => {
  it('get combines duplicate headers with ", "', async () => {
    const result = await evalStr(`(() => {
      const h = new Headers();
      h.append('Accept', 'text/html');
      h.append('Accept', 'application/json');
      return h.get('Accept');
    })()`);
    expect(result).toBe('text/html, application/json');
  });

  it('set replaces all duplicates', async () => {
    const result = await evalStr(`(() => {
      const h = new Headers();
      h.append('Accept', 'text/html');
      h.append('Accept', 'application/json');
      h.set('Accept', 'text/plain');
      return h.get('Accept');
    })()`);
    expect(result).toBe('text/plain');
  });

  it('append adds to combined value', async () => {
    const result = await evalStr(`(() => {
      const h = new Headers();
      h.set('Accept', 'text/html');
      h.append('Accept', 'text/plain');
      return h.get('Accept');
    })()`);
    expect(result).toBe('text/html, text/plain');
  });
});

// ---- WPT: headers-errors ----

describe('WPT headers-errors', () => {
  it('throws TypeError for invalid header name', async () => {
    using vm = await createVM();
    const names = ['', 'invalid header', 'invalid\x00name', 'invalid\nname', 'in:valid'];
    for (const name of names) {
      const code = `try { new Headers().get(${JSON.stringify(name)}); 'no error'; } catch(e) { e instanceof TypeError ? 'TypeError' : 'other'; }`;
      const result = vm.evalCode(code);
      expect(result.toString(), `name: ${JSON.stringify(name)}`).toBe('TypeError');
      result.dispose();
    }
  });

  it('throws TypeError for invalid header value (NUL, CR, LF in middle)', async () => {
    using vm = await createVM();
    const values = ['val\x00ue', 'val\rue', 'val\nue'];
    for (const value of values) {
      const code = `try { new Headers().set('name', ${JSON.stringify(value)}); 'no error'; } catch(e) { e instanceof TypeError ? 'TypeError' : 'other'; }`;
      const result = vm.evalCode(code);
      expect(result.toString(), `value: ${JSON.stringify(value)}`).toBe('TypeError');
      result.dispose();
    }
  });

  it('forEach throws TypeError for non-callable', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      try { new Headers().forEach(42); 'no error'; } catch(e) { e instanceof TypeError ? 'TypeError' : 'other'; }
    `);
    expect(result.toString()).toBe('TypeError');
    result.dispose();
  });
});

// ---- WPT: headers-normalize ----

describe('WPT headers-normalize', () => {
  it('strips leading/trailing whitespace from values', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers();
      h.set('a', '  value  ');
      h.set('b', '\\tvalue\\t');
      return { a: h.get('a'), b: h.get('b') };
    })()`);
    expect(result.a).toBe('value');
    expect(result.b).toBe('value');
  });

  it('preserves inner whitespace', async () => {
    const result = await evalStr(`(() => {
      const h = new Headers();
      h.set('a', 'hello world');
      return h.get('a');
    })()`);
    expect(result).toBe('hello world');
  });
});

// ---- WPT: header-values ----

describe('WPT header-values', () => {
  it('allows byte values 0x01-0x09, 0x0B-0x0C, 0x0E-0xFF', async () => {
    // NUL (0x00), LF (0x0A), CR (0x0D) are rejected; everything else is valid
    const result = await evalJSON(`(() => {
      const h = new Headers();
      const valid = [];
      const invalid = [];
      for (let i = 1; i < 256; i++) {
        if (i === 0x0A || i === 0x0D) continue; // these are invalid
        try {
          h.set('test', String.fromCharCode(i));
          valid.push(i);
        } catch(e) {
          invalid.push(i);
        }
      }
      return { validCount: valid.length, invalidCount: invalid.length };
    })()`);
    expect(result.validCount).toBe(253); // 255 - 0x00 - 0x0A - 0x0D = 252, but we skip 0x00 in loop
    expect(result.invalidCount).toBe(0);
  });
});

// ---- WPT: header-setcookie ----

describe('WPT header-setcookie', () => {
  it('getSetCookie returns individual Set-Cookie values', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers();
      h.append('Set-Cookie', 'a=1');
      h.append('Set-Cookie', 'b=2');
      return h.getSetCookie();
    })()`);
    expect(result).toEqual(['a=1', 'b=2']);
  });

  it('getSetCookie returns empty array when no Set-Cookie', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers();
      h.set('Content-Type', 'text/html');
      return h.getSetCookie();
    })()`);
    expect(result).toEqual([]);
  });

  it('get combines Set-Cookie with ", " like other headers', async () => {
    const result = await evalStr(`(() => {
      const h = new Headers();
      h.append('Set-Cookie', 'a=1');
      h.append('Set-Cookie', 'b=2');
      return h.get('Set-Cookie');
    })()`);
    expect(result).toBe('a=1, b=2');
  });

  it('Set-Cookie headers are kept separate in iteration', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers();
      h.append('Set-Cookie', 'a=1');
      h.append('Set-Cookie', 'b=2');
      const entries = [];
      for (const [name, value] of h) entries.push([name, value]);
      return entries;
    })()`);
    expect(result).toEqual([['set-cookie', 'a=1'], ['set-cookie', 'b=2']]);
  });
});

// ---- Iteration / sorting ----

describe('iteration', () => {
  it('iterates in sorted order with lowercased names', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers();
      h.set('Zebra', '1');
      h.set('apple', '2');
      h.set('Mango', '3');
      const keys = [];
      for (const [key] of h) keys.push(key);
      return keys;
    })()`);
    expect(result).toEqual(['apple', 'mango', 'zebra']);
  });

  it('entries() yields [name, value] pairs', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers({ 'A': '1', 'B': '2' });
      return [...h.entries()];
    })()`);
    expect(result).toEqual([['a', '1'], ['b', '2']]);
  });

  it('keys() yields names', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers({ 'A': '1', 'B': '2' });
      return [...h.keys()];
    })()`);
    expect(result).toEqual(['a', 'b']);
  });

  it('values() yields values', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers({ 'A': '1', 'B': '2' });
      return [...h.values()];
    })()`);
    expect(result).toEqual(['1', '2']);
  });

  it('forEach calls callback with (value, name, headers)', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers({ 'X-Test': 'hello' });
      const args = [];
      h.forEach((value, name) => args.push([name, value]));
      return args;
    })()`);
    expect(result).toEqual([['x-test', 'hello']]);
  });

  it('Symbol.iterator is entries', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers({ 'A': '1' });
      return h[Symbol.iterator] === h.entries;
    })()`);
    expect(result).toBe(true);
  });

  it('for...of works', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers([['b', '2'], ['a', '1']]);
      const entries = [];
      for (const pair of h) entries.push(pair);
      return entries;
    })()`);
    expect(result).toEqual([['a', '1'], ['b', '2']]);
  });

  it('combines non-set-cookie duplicate headers in iteration', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers();
      h.append('Accept', 'text/html');
      h.append('Accept', 'application/json');
      const entries = [];
      for (const [name, value] of h) entries.push([name, value]);
      return entries;
    })()`);
    expect(result).toEqual([['accept', 'text/html, application/json']]);
  });
});

// ---- Constructor edge cases ----

describe('constructor edge cases', () => {
  it('constructor.name === "Headers"', async () => {
    expect(await evalStr('Headers.name')).toBe('Headers');
  });

  it('instanceof works', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers();
      return h instanceof Headers;
    })()`);
    expect(result).toBe(true);
  });

  it('sequence init with duplicate names appends (does not replace)', async () => {
    const result = await evalStr(`(() => {
      const h = new Headers([['Accept', 'text/html'], ['Accept', 'text/plain']]);
      return h.get('Accept');
    })()`);
    expect(result).toBe('text/html, text/plain');
  });
});

// ---- delete edge cases ----

describe('delete edge cases', () => {
  it('deleting non-existent header is a no-op', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers({ 'A': '1' });
      h.delete('B');
      return { has: h.has('A'), get: h.get('A') };
    })()`);
    expect(result.has).toBe(true);
    expect(result.get).toBe('1');
  });

  it('delete removes all headers with that name', async () => {
    const result = await evalJSON(`(() => {
      const h = new Headers();
      h.append('X', '1');
      h.append('X', '2');
      h.delete('X');
      return { has: h.has('X'), get: h.get('X') };
    })()`);
    expect(result.has).toBe(false);
    expect(result.get).toBe(null);
  });
});

// ---- Snapshot / restore ----

describe('snapshot/restore', () => {
  it('should preserve Headers objects across snapshot/restore', async () => {
    const vm1 = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [{ name: 'headers', wasm: headersExtBytes }],
    });

    vm1.evalCode(`
      globalThis.savedHeaders = new Headers({ 'Content-Type': 'application/json', 'X-Custom': 'test' });
      globalThis.savedHeaders.append('Accept', 'text/html');
    `).dispose();

    const snapshot = vm1.snapshot();
    vm1.dispose();

    const vm2 = await QuickJS.restore(snapshot, {
      wasm: wasmBytes,
      extensions: [{ name: 'headers', wasm: headersExtBytes }],
    });

    const result = vm2.evalCode(`
      JSON.stringify({
        ct: savedHeaders.get('content-type'),
        custom: savedHeaders.get('x-custom'),
        accept: savedHeaders.get('accept'),
      })
    `);
    const parsed = JSON.parse(result.toString());
    result.dispose();
    vm2.dispose();

    expect(parsed.ct).toBe('application/json');
    expect(parsed.custom).toBe('test');
    expect(parsed.accept).toBe('text/html');
  });
});
