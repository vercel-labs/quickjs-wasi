import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

// atob/btoa and Uint8Array base64/hex methods are now native built-ins in
// quickjs-ng v0.15.0+. These tests exercise the native implementation and no
// longer rely on an extension.

async function createVM() {
  return QuickJS.create({ wasm: wasmBytes });
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

/* ==================================================================
 *  Uint8Array.prototype.toBase64 / toHex
 * ================================================================== */

describe('Uint8Array.prototype.toBase64', () => {
  it('should be available as a method', async () => {
    expect(await evalStr('typeof Uint8Array.prototype.toBase64')).toBe('function');
  });

  it('should encode empty array', async () => {
    expect(await evalStr('new Uint8Array([]).toBase64()')).toBe('');
  });

  it('should encode "Hello World"', async () => {
    expect(await evalStr('new Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100]).toBase64()')).toBe('SGVsbG8gV29ybGQ=');
  });

  it('should encode single byte', async () => {
    expect(await evalStr('new Uint8Array([72]).toBase64()')).toBe('SA==');
  });

  it('should encode two bytes', async () => {
    expect(await evalStr('new Uint8Array([72, 101]).toBase64()')).toBe('SGU=');
  });

  it('should encode three bytes (no padding)', async () => {
    expect(await evalStr('new Uint8Array([72, 101, 108]).toBase64()')).toBe('SGVs');
  });

  it('should support base64url alphabet', async () => {
    expect(await evalStr("new Uint8Array([251, 255, 191]).toBase64({ alphabet: 'base64url' })")).toBe('-_-_');
  });

  it('should use standard base64 by default', async () => {
    expect(await evalStr('new Uint8Array([251, 255, 191]).toBase64()')).toBe('+/+/');
  });

  it('should support omitPadding option', async () => {
    expect(await evalStr('new Uint8Array([72]).toBase64({ omitPadding: true })')).toBe('SA');
  });

  it('should include padding by default', async () => {
    expect(await evalStr('new Uint8Array([72]).toBase64()')).toBe('SA==');
  });

  it('should support omitPadding with 2-byte remainder', async () => {
    expect(await evalStr('new Uint8Array([72, 101]).toBase64({ omitPadding: true })')).toBe('SGU');
  });

  it('should throw TypeError for non-Uint8Array', async () => {
    using vm = await createVM();
    expect(() => { vm.evalCode('Uint8Array.prototype.toBase64.call([1, 2, 3])'); }).toThrow();
  });

  it('should throw TypeError for invalid alphabet option', async () => {
    using vm = await createVM();
    expect(() => { vm.evalCode("new Uint8Array([1]).toBase64({ alphabet: 'invalid' })"); }).toThrow();
  });
});

describe('Uint8Array.prototype.toHex', () => {
  it('should be available as a method', async () => {
    expect(await evalStr('typeof Uint8Array.prototype.toHex')).toBe('function');
  });

  it('should encode empty array', async () => {
    expect(await evalStr('new Uint8Array([]).toHex()')).toBe('');
  });

  it('should encode "Hello World"', async () => {
    expect(await evalStr('new Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100]).toHex()')).toBe('48656c6c6f20576f726c64');
  });

  it('should pad single digit hex values', async () => {
    expect(await evalStr('new Uint8Array([0, 1, 15]).toHex()')).toBe('00010f');
  });

  it('should use lowercase hex', async () => {
    expect(await evalStr('new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]).toHex()')).toBe('deadbeef');
  });

  it('should encode all byte values 0-255', async () => {
    const result = await evalStr(`
      var arr = new Uint8Array(256);
      for (var i = 0; i < 256; i++) arr[i] = i;
      arr.toHex().length
    `);
    expect(result).toBe('512');
  });
});

/* ==================================================================
 *  Uint8Array.fromBase64 / fromHex
 * ================================================================== */

describe('Uint8Array.fromBase64', () => {
  it('should be available as a static method', async () => {
    expect(await evalStr('typeof Uint8Array.fromBase64')).toBe('function');
  });

  it('should decode empty string', async () => {
    expect(await evalStr("Uint8Array.fromBase64('').length")).toBe('0');
  });

  it('should decode "Hello World"', async () => {
    expect(await evalStr("Array.from(Uint8Array.fromBase64('SGVsbG8gV29ybGQ=')).join(',')")).toBe('72,101,108,108,111,32,87,111,114,108,100');
  });

  it('should decode without padding (loose)', async () => {
    expect(await evalStr("Array.from(Uint8Array.fromBase64('SGVsbG8gV29ybGQ')).join(',')")).toBe('72,101,108,108,111,32,87,111,114,108,100');
  });

  it('should ignore whitespace', async () => {
    expect(await evalStr("Array.from(Uint8Array.fromBase64('SGVs bG8g\\nV29y bGQ=')).join(',')")).toBe('72,101,108,108,111,32,87,111,114,108,100');
  });

  it('should support base64url alphabet', async () => {
    expect(await evalStr("Array.from(Uint8Array.fromBase64('-_-_', { alphabet: 'base64url' })).join(',')")).toBe('251,255,191');
  });

  it('should reject + and / in base64url mode', async () => {
    using vm = await createVM();
    expect(() => { vm.evalCode("Uint8Array.fromBase64('+/+/', { alphabet: 'base64url' })"); }).toThrow();
  });

  it('should throw for invalid characters', async () => {
    using vm = await createVM();
    expect(() => { vm.evalCode("Uint8Array.fromBase64('not valid!!')"); }).toThrow();
  });

  it('should throw for single character (loose)', async () => {
    using vm = await createVM();
    expect(() => { vm.evalCode("Uint8Array.fromBase64('A')"); }).toThrow();
  });

  it('should throw for non-string input', async () => {
    using vm = await createVM();
    expect(() => { vm.evalCode('Uint8Array.fromBase64(123)'); }).toThrow();
  });

  it('should handle strict lastChunkHandling', async () => {
    // 'SGVsbG8=' has valid padding, strict should accept
    expect(await evalStr("Array.from(Uint8Array.fromBase64('SGVsbG8=', { lastChunkHandling: 'strict' })).join(',')")).toBe('72,101,108,108,111');
  });

  it('should reject overflow bits in strict mode', async () => {
    using vm = await createVM();
    // 'SGVsbG8gV29ybGR=' has non-zero overflow bits in the last chunk
    expect(() => { vm.evalCode("Uint8Array.fromBase64('SGVsbG8gV29ybGR=', { lastChunkHandling: 'strict' })"); }).toThrow();
  });

  it('should reject unpadded input in strict mode', async () => {
    using vm = await createVM();
    expect(() => { vm.evalCode("Uint8Array.fromBase64('SGVsbG8', { lastChunkHandling: 'strict' })"); }).toThrow();
  });

  it('should stop before partial chunk with stop-before-partial', async () => {
    // 'SGVsbG8' = 'SGVs' (4-char chunk -> 3 bytes: H,e,l) + 'bG8' (3-char partial)
    // stop-before-partial stops before the partial chunk
    expect(await evalStr("Array.from(Uint8Array.fromBase64('SGVsbG8', { lastChunkHandling: 'stop-before-partial' })).join(',')")).toBe('72,101,108');
  });
});

describe('Uint8Array.fromHex', () => {
  it('should be available as a static method', async () => {
    expect(await evalStr('typeof Uint8Array.fromHex')).toBe('function');
  });

  it('should decode empty string', async () => {
    expect(await evalStr("Uint8Array.fromHex('').length")).toBe('0');
  });

  it('should decode "Hello World"', async () => {
    expect(await evalStr("Array.from(Uint8Array.fromHex('48656c6c6f20576f726c64')).join(',')")).toBe('72,101,108,108,111,32,87,111,114,108,100');
  });

  it('should decode uppercase hex', async () => {
    expect(await evalStr("Array.from(Uint8Array.fromHex('DEADBEEF')).join(',')")).toBe('222,173,190,239');
  });

  it('should decode mixed case hex', async () => {
    expect(await evalStr("Array.from(Uint8Array.fromHex('DeAdBeEf')).join(',')")).toBe('222,173,190,239');
  });

  it('should throw for odd-length string', async () => {
    using vm = await createVM();
    expect(() => { vm.evalCode("Uint8Array.fromHex('abc')"); }).toThrow();
  });

  it('should throw for invalid hex characters', async () => {
    using vm = await createVM();
    expect(() => { vm.evalCode("Uint8Array.fromHex('gg')"); }).toThrow();
  });

  it('should throw for non-string input', async () => {
    using vm = await createVM();
    expect(() => { vm.evalCode('Uint8Array.fromHex(123)'); }).toThrow();
  });
});

/* ==================================================================
 *  Uint8Array.prototype.setFromBase64 / setFromHex
 * ================================================================== */

describe('Uint8Array.prototype.setFromBase64', () => {
  it('should be available as a method', async () => {
    expect(await evalStr('typeof Uint8Array.prototype.setFromBase64')).toBe('function');
  });

  it('should decode into an existing Uint8Array', async () => {
    const result = await evalStr(`
      var target = new Uint8Array(11);
      var r = target.setFromBase64('SGVsbG8gV29ybGQ=');
      JSON.stringify({ arr: Array.from(target), read: r.read, written: r.written })
    `);
    const parsed = JSON.parse(result);
    expect(parsed.arr).toEqual([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100]);
    expect(parsed.read).toBe(16);
    expect(parsed.written).toBe(11);
  });

  it('should stop when target is full', async () => {
    const result = await evalStr(`
      var target = new Uint8Array(7);
      var r = target.setFromBase64('Zm9vYmFy');
      JSON.stringify({ arr: Array.from(target), read: r.read, written: r.written })
    `);
    const parsed = JSON.parse(result);
    expect(parsed.arr).toEqual([102, 111, 111, 98, 97, 114, 0]);
    expect(parsed.written).toBe(6);
    expect(parsed.read).toBe(8);
  });

  it('should return read and written for empty string', async () => {
    const result = await evalStr(`
      var target = new Uint8Array(5);
      var r = target.setFromBase64('');
      JSON.stringify({ read: r.read, written: r.written })
    `);
    const parsed = JSON.parse(result);
    expect(parsed.read).toBe(0);
    expect(parsed.written).toBe(0);
  });

  it('should support base64url alphabet', async () => {
    const result = await evalStr(`
      var target = new Uint8Array(3);
      var r = target.setFromBase64('-_-_', { alphabet: 'base64url' });
      JSON.stringify({ arr: Array.from(target), read: r.read, written: r.written })
    `);
    const parsed = JSON.parse(result);
    expect(parsed.arr).toEqual([251, 255, 191]);
    expect(parsed.read).toBe(4);
    expect(parsed.written).toBe(3);
  });
});

describe('Uint8Array.prototype.setFromHex', () => {
  it('should be available as a method', async () => {
    expect(await evalStr('typeof Uint8Array.prototype.setFromHex')).toBe('function');
  });

  it('should decode into an existing Uint8Array', async () => {
    const result = await evalStr(`
      var target = new Uint8Array(6);
      var r = target.setFromHex('deadbeef');
      JSON.stringify({ arr: Array.from(target), read: r.read, written: r.written })
    `);
    const parsed = JSON.parse(result);
    expect(parsed.arr).toEqual([222, 173, 190, 239, 0, 0]);
    expect(parsed.read).toBe(8);
    expect(parsed.written).toBe(4);
  });

  it('should stop when target is full', async () => {
    const result = await evalStr(`
      var target = new Uint8Array(2);
      var r = target.setFromHex('deadbeef');
      JSON.stringify({ arr: Array.from(target), read: r.read, written: r.written })
    `);
    const parsed = JSON.parse(result);
    expect(parsed.arr).toEqual([222, 173]);
    expect(parsed.read).toBe(4);
    expect(parsed.written).toBe(2);
  });

  it('should return read and written for empty string', async () => {
    const result = await evalStr(`
      var target = new Uint8Array(5);
      var r = target.setFromHex('');
      JSON.stringify({ read: r.read, written: r.written })
    `);
    const parsed = JSON.parse(result);
    expect(parsed.read).toBe(0);
    expect(parsed.written).toBe(0);
  });

  it('should throw for invalid hex', async () => {
    using vm = await createVM();
    expect(() => { vm.evalCode("new Uint8Array(10).setFromHex('gg')"); }).toThrow();
  });
});

/* ==================================================================
 *  Round-trip tests: toBase64 <-> fromBase64, toHex <-> fromHex
 * ================================================================== */

describe('toBase64/fromBase64 round-trip', () => {
  it('should round-trip empty', async () => {
    expect(await evalStr(`
      var a = new Uint8Array([]);
      var b = Uint8Array.fromBase64(a.toBase64());
      b.length === 0 ? 'ok' : 'fail'
    `)).toBe('ok');
  });

  it('should round-trip all byte values', async () => {
    expect(await evalStr(`
      var a = new Uint8Array(256);
      for (var i = 0; i < 256; i++) a[i] = i;
      var encoded = a.toBase64();
      var decoded = Uint8Array.fromBase64(encoded);
      decoded.length === 256 && decoded[0] === 0 && decoded[255] === 255 ? 'ok' : 'fail'
    `)).toBe('ok');
  });

  it('should round-trip with base64url', async () => {
    expect(await evalStr(`
      var a = new Uint8Array([251, 255, 191]);
      var opts = { alphabet: 'base64url' };
      var encoded = a.toBase64(opts);
      var decoded = Uint8Array.fromBase64(encoded, opts);
      Array.from(decoded).join(',') === '251,255,191' ? 'ok' : 'fail'
    `)).toBe('ok');
  });

  it('should round-trip with omitPadding', async () => {
    expect(await evalStr(`
      var a = new Uint8Array([72, 101]);
      var encoded = a.toBase64({ omitPadding: true });
      var decoded = Uint8Array.fromBase64(encoded);
      Array.from(decoded).join(',') === '72,101' ? 'ok' : 'fail'
    `)).toBe('ok');
  });
});

describe('toHex/fromHex round-trip', () => {
  it('should round-trip empty', async () => {
    expect(await evalStr(`
      var a = new Uint8Array([]);
      var b = Uint8Array.fromHex(a.toHex());
      b.length === 0 ? 'ok' : 'fail'
    `)).toBe('ok');
  });

  it('should round-trip all byte values', async () => {
    expect(await evalStr(`
      var a = new Uint8Array(256);
      for (var i = 0; i < 256; i++) a[i] = i;
      var hex = a.toHex();
      var decoded = Uint8Array.fromHex(hex);
      decoded.length === 256 && decoded[0] === 0 && decoded[255] === 255 ? 'ok' : 'fail'
    `)).toBe('ok');
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
