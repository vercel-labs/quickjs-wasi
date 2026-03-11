import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const base64ExtBytes = readFileSync(resolve(__dirname, '..', 'extensions', 'base64', 'base64.so'));

async function createVM() {
  return QuickJS.create({
    wasm: wasmBytes,
    extensions: [{ name: 'base64', wasm: base64ExtBytes }],
  });
}

async function evalStr(code: string) {
  using vm = await createVM();
  const result = vm.evalCode(code);
  const str = result.toString();
  result.dispose();
  return str;
}

describe('btoa', () => {
  it('should be available as a global function', async () => {
    expect(await evalStr('typeof btoa')).toBe('function');
  });

  it('should encode empty string', async () => {
    expect(await evalStr("btoa('')")).toBe('');
  });

  it('should encode ASCII string', async () => {
    expect(await evalStr("btoa('Hello, world!')")).toBe('SGVsbG8sIHdvcmxkIQ==');
  });

  it('should encode single character', async () => {
    expect(await evalStr("btoa('A')")).toBe('QQ==');
  });

  it('should encode two characters', async () => {
    expect(await evalStr("btoa('AB')")).toBe('QUI=');
  });

  it('should encode three characters (no padding)', async () => {
    expect(await evalStr("btoa('ABC')")).toBe('QUJD');
  });

  it('should encode Latin-1 characters (U+0080-U+00FF)', async () => {
    expect(await evalStr("btoa('\\u00FF')")).toBe('/w==');
  });

  it('should encode null byte', async () => {
    expect(await evalStr("btoa('\\u0000')")).toBe('AA==');
  });

  it('should encode all byte values 0-255', async () => {
    const result = await evalStr(`
      var str = '';
      for (var i = 0; i < 256; i++) str += String.fromCharCode(i);
      btoa(str).length
    `);
    // 256 bytes -> ceil(256/3)*4 = 344 base64 chars
    expect(result).toBe('344');
  });

  it('should throw for characters > U+00FF', async () => {
    using vm = await createVM();
    expect(() => { vm.evalCode("btoa('\\u0100')"); }).toThrow();
  });

  it('should throw for emoji', async () => {
    using vm = await createVM();
    expect(() => { vm.evalCode("btoa('😀')"); }).toThrow();
  });

  it('should throw for multi-byte characters', async () => {
    using vm = await createVM();
    expect(() => { vm.evalCode("btoa('日本')"); }).toThrow();
  });
});

describe('atob', () => {
  it('should be available as a global function', async () => {
    expect(await evalStr('typeof atob')).toBe('function');
  });

  it('should decode empty string', async () => {
    expect(await evalStr("atob('')")).toBe('');
  });

  it('should decode basic base64', async () => {
    expect(await evalStr("atob('SGVsbG8sIHdvcmxkIQ==')")).toBe('Hello, world!');
  });

  it('should decode without padding (2 chars)', async () => {
    // 2 base64 chars = 1 byte
    expect(await evalStr("atob('QQ')")).toBe('A');
  });

  it('should decode without padding (3 chars)', async () => {
    // 3 base64 chars = 2 bytes
    expect(await evalStr("atob('QUI')")).toBe('AB');
  });

  it('should decode with single padding', async () => {
    expect(await evalStr("atob('QUI=')")).toBe('AB');
  });

  it('should decode with double padding', async () => {
    expect(await evalStr("atob('QQ==')")).toBe('A');
  });

  it('should ignore ASCII whitespace', async () => {
    // Per forgiving-base64 decode, whitespace is stripped first
    expect(await evalStr("atob(' S G V s b G 8 = ')")).toBe('Hello');
  });

  it('should ignore tab and newline', async () => {
    expect(await evalStr("atob('\\tSGVsbG8=\\n')")).toBe('Hello');
  });

  it('should throw for invalid characters', async () => {
    using vm = await createVM();
    expect(() => { vm.evalCode("atob('not valid!!')"); }).toThrow();
  });

  it('should throw for single character (length%4 == 1 after cleanup)', async () => {
    using vm = await createVM();
    expect(() => { vm.evalCode("atob('A')"); }).toThrow();
  });

  it('should throw for = in the middle', async () => {
    using vm = await createVM();
    expect(() => { vm.evalCode("atob('QQ==QQ==')"); }).toThrow();
  });

  it('should decode Latin-1 range values', async () => {
    // /w== decodes to 0xFF
    const result = await evalStr("atob('/w==').charCodeAt(0)");
    expect(result).toBe('255');
  });

  it('should decode null byte', async () => {
    const result = await evalStr("atob('AA==').charCodeAt(0)");
    expect(result).toBe('0');
  });
});

describe('btoa/atob round-trip', () => {
  it('should round-trip ASCII', async () => {
    expect(await evalStr("atob(btoa('Hello, world!'))")).toBe('Hello, world!');
  });

  it('should round-trip empty string', async () => {
    expect(await evalStr("atob(btoa(''))")).toBe('');
  });

  it('should round-trip all Latin-1 characters', async () => {
    const result = await evalStr(`
      var str = '';
      for (var i = 0; i < 256; i++) str += String.fromCharCode(i);
      var encoded = btoa(str);
      var decoded = atob(encoded);
      decoded.length === 256 && decoded.charCodeAt(0) === 0 && decoded.charCodeAt(255) === 255 ? 'ok' : 'fail'
    `);
    expect(result).toBe('ok');
  });

  it('should round-trip binary data', async () => {
    const result = await evalStr(`
      var binary = '\\x00\\x01\\x02\\xFD\\xFE\\xFF';
      atob(btoa(binary)) === binary ? 'ok' : 'fail'
    `);
    expect(result).toBe('ok');
  });
});

describe('WPT: base64 edge cases', () => {
  // From web-platform-tests/wpt/html/webappapis/atob/base64.html
  const validPairs: [string, string][] = [
    ['', ''],
    ['abcd', 'YWJjZA=='],
    ['a', 'YQ=='],
    ['ab', 'YWI='],
    ['abc', 'YWJj'],
    ['abcdef', 'YWJjZGVm'],
  ];

  for (const [decoded, encoded] of validPairs) {
    it(`btoa('${decoded}') === '${encoded}'`, async () => {
      expect(await evalStr(`btoa('${decoded}')`)).toBe(encoded);
    });

    it(`atob('${encoded}') === '${decoded}'`, async () => {
      expect(await evalStr(`atob('${encoded}')`)).toBe(decoded);
    });
  }

  // Forgiving decode: whitespace handling
  it('atob with spaces between every char', async () => {
    expect(await evalStr("atob('Y W J j')")).toBe('abc');
  });

  it('atob with trailing whitespace and padding', async () => {
    expect(await evalStr("atob('YQ== ')")).toBe('a');
  });

  // Invalid inputs
  const invalidInputs = [
    'A',        // length % 4 == 1
    'AAAAA',    // length % 4 == 1 after removing =
    '=',        // invalid
    '==',       // invalid
    'A===',     // too many =
  ];

  for (const input of invalidInputs) {
    it(`atob('${input}') should throw`, async () => {
      using vm = await createVM();
      expect(() => {
        vm.evalCode(`atob('${input}')`);
      }).toThrow();
    });
  }
});
