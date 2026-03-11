import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const encodingExtBytes = readFileSync(resolve(__dirname, '..', 'extensions', 'encoding', 'encoding.so'));

/** Helper: create a VM with the encoding extension loaded */
async function createVM() {
  return QuickJS.create({
    wasm: wasmBytes,
    extensions: [{ name: 'encoding', wasm: encodingExtBytes }],
  });
}

/** Helper: eval code and return the JSON-parsed result */
async function evalJSON(code: string) {
  using vm = await createVM();
  const result = vm.evalCode(`JSON.stringify(${code})`);
  const parsed = JSON.parse(result.toString());
  result.dispose();
  return parsed;
}

/** Helper: eval code and return raw string */
async function evalStr(code: string) {
  using vm = await createVM();
  const result = vm.evalCode(code);
  const str = result.toString();
  result.dispose();
  return str;
}

describe('TextEncoder', () => {
  it('should be available as a global constructor', async () => {
    expect(await evalStr('typeof TextEncoder')).toBe('function');
  });

  it('should have constructor.name === "TextEncoder"', async () => {
    expect(await evalStr('new TextEncoder().constructor.name')).toBe('TextEncoder');
  });

  it('should have encoding === "utf-8"', async () => {
    expect(await evalStr('new TextEncoder().encoding')).toBe('utf-8');
  });

  it('should encode an empty string to an empty Uint8Array', async () => {
    const result = await evalJSON(`Array.from(new TextEncoder().encode(''))`);
    expect(result).toEqual([]);
  });

  it('should encode with no arguments to an empty Uint8Array', async () => {
    const result = await evalJSON(`Array.from(new TextEncoder().encode())`);
    expect(result).toEqual([]);
  });

  it('should encode undefined to an empty Uint8Array', async () => {
    const result = await evalJSON(`Array.from(new TextEncoder().encode(undefined))`);
    expect(result).toEqual([]);
  });

  it('should encode ASCII text', async () => {
    const result = await evalJSON(`Array.from(new TextEncoder().encode('Hello'))`);
    expect(result).toEqual([0x48, 0x65, 0x6C, 0x6C, 0x6F]);
  });

  it('should encode multi-byte UTF-8 characters', async () => {
    // € = U+20AC = 0xE2 0x82 0xAC
    const result = await evalJSON(`Array.from(new TextEncoder().encode('€'))`);
    expect(result).toEqual([0xE2, 0x82, 0xAC]);
  });

  it('should encode 2-byte UTF-8 characters', async () => {
    // ¢ = U+00A2 = 0xC2 0xA2
    const result = await evalJSON(`Array.from(new TextEncoder().encode('\\u00A2'))`);
    expect(result).toEqual([0xC2, 0xA2]);
  });

  it('should encode 4-byte UTF-8 characters (emoji)', async () => {
    // 💩 = U+1F4A9 = 0xF0 0x9F 0x92 0xA9
    const result = await evalJSON(`Array.from(new TextEncoder().encode('\\uD83D\\uDCA9'))`);
    expect(result).toEqual([0xF0, 0x9F, 0x92, 0xA9]);
  });

  it('should encode non-BMP character G-clef U+1D11E', async () => {
    const result = await evalJSON(`Array.from(new TextEncoder().encode('\\uD834\\uDD1E'))`);
    expect(result).toEqual([0xF0, 0x9D, 0x84, 0x9E]);
  });

  it('should replace lone surrogates with U+FFFD', async () => {
    // Lone high surrogate
    const result = await evalJSON(`Array.from(new TextEncoder().encode('\\uD800'))`);
    expect(result).toEqual([0xEF, 0xBF, 0xBD]); // U+FFFD in UTF-8
  });

  it('should replace lone low surrogate with U+FFFD', async () => {
    const result = await evalJSON(`Array.from(new TextEncoder().encode('\\uDC00'))`);
    expect(result).toEqual([0xEF, 0xBF, 0xBD]);
  });

  it('should encode string with embedded null', async () => {
    const result = await evalJSON(`Array.from(new TextEncoder().encode('a\\u0000b'))`);
    expect(result).toEqual([0x61, 0x00, 0x62]);
  });

  it('should return a Uint8Array', async () => {
    const result = await evalStr(`
      const encoded = new TextEncoder().encode('test');
      encoded instanceof Uint8Array ? 'true' : 'false'
    `);
    expect(result).toBe('true');
  });
});

describe('TextEncoder.encodeInto', () => {
  it('should encode into a Uint8Array and return read/written', async () => {
    const result = await evalJSON(`
      (() => {
        const encoder = new TextEncoder();
        const dest = new Uint8Array(10);
        const result = encoder.encodeInto('Hello', dest);
        return { read: result.read, written: result.written, bytes: Array.from(dest) };
      })()
    `);
    expect(result.read).toBe(5);
    expect(result.written).toBe(5);
    expect(result.bytes.slice(0, 5)).toEqual([0x48, 0x65, 0x6C, 0x6C, 0x6F]);
  });

  it('should handle buffer too small for full output', async () => {
    const result = await evalJSON(`
      (() => {
        const encoder = new TextEncoder();
        const dest = new Uint8Array(3);
        const result = encoder.encodeInto('Hello', dest);
        return { read: result.read, written: result.written };
      })()
    `);
    expect(result.read).toBe(3);
    expect(result.written).toBe(3);
  });

  it('should handle empty destination', async () => {
    const result = await evalJSON(`
      (() => {
        const encoder = new TextEncoder();
        const dest = new Uint8Array(0);
        const result = encoder.encodeInto('Hi', dest);
        return { read: result.read, written: result.written };
      })()
    `);
    expect(result.read).toBe(0);
    expect(result.written).toBe(0);
  });

  it('should count surrogate pairs as 2 read units', async () => {
    const result = await evalJSON(`
      (() => {
        const encoder = new TextEncoder();
        const dest = new Uint8Array(4);
        const result = encoder.encodeInto('\\uD834\\uDD1E', dest);
        return { read: result.read, written: result.written };
      })()
    `);
    expect(result.read).toBe(2);
    expect(result.written).toBe(4);
  });

  it('should not write partial multi-byte sequences', async () => {
    // € (U+20AC) needs 3 bytes. With only 2 bytes available, it should not be written.
    const result = await evalJSON(`
      (() => {
        const encoder = new TextEncoder();
        const dest = new Uint8Array(2);
        const result = encoder.encodeInto('€', dest);
        return { read: result.read, written: result.written };
      })()
    `);
    expect(result.read).toBe(0);
    expect(result.written).toBe(0);
  });

  it('should throw TypeError for non-Uint8Array destination', async () => {
    using vm = await createVM();
    expect(() => {
      vm.evalCode(`new TextEncoder().encodeInto('test', new Int8Array(10))`);
    }).toThrow();
  });
});

describe('TextDecoder', () => {
  it('should be available as a global constructor', async () => {
    expect(await evalStr('typeof TextDecoder')).toBe('function');
  });

  it('should have constructor.name === "TextDecoder"', async () => {
    expect(await evalStr('new TextDecoder().constructor.name')).toBe('TextDecoder');
  });

  it('should default to utf-8 encoding', async () => {
    expect(await evalStr('new TextDecoder().encoding')).toBe('utf-8');
  });

  it('should have fatal default to false', async () => {
    expect(await evalStr('String(new TextDecoder().fatal)')).toBe('false');
  });

  it('should have ignoreBOM default to false', async () => {
    expect(await evalStr('String(new TextDecoder().ignoreBOM)')).toBe('false');
  });

  it('should decode UTF-8 bytes to string', async () => {
    const result = await evalStr(`
      new TextDecoder().decode(new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]))
    `);
    expect(result).toBe('Hello');
  });

  it('should decode multi-byte UTF-8', async () => {
    // € = U+20AC = 0xE2 0x82 0xAC
    const result = await evalStr(`
      new TextDecoder().decode(new Uint8Array([0xE2, 0x82, 0xAC]))
    `);
    expect(result).toBe('€');
  });

  it('should decode 4-byte UTF-8 (emoji)', async () => {
    const result = await evalStr(`
      new TextDecoder().decode(new Uint8Array([0xF0, 0x9F, 0x92, 0xA9]))
    `);
    expect(result).toBe('💩');
  });

  it('should decode with no input to empty string', async () => {
    expect(await evalStr('new TextDecoder().decode()')).toBe('');
  });

  it('should decode undefined input to empty string', async () => {
    expect(await evalStr('new TextDecoder().decode(undefined)')).toBe('');
  });

  it('should replace invalid UTF-8 with U+FFFD in replacement mode', async () => {
    const result = await evalStr(`
      new TextDecoder().decode(new Uint8Array([0xFF]))
    `);
    expect(result).toBe('\uFFFD');
  });

  it('should throw TypeError in fatal mode for invalid UTF-8', async () => {
    using vm = await createVM();
    expect(() => {
      vm.evalCode(`
        new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xFF]))
      `);
    }).toThrow();
  });

  it('should set fatal flag from options', async () => {
    expect(await evalStr("String(new TextDecoder('utf-8', { fatal: true }).fatal)")).toBe('true');
  });

  it('should set ignoreBOM flag from options', async () => {
    expect(await evalStr("String(new TextDecoder('utf-8', { ignoreBOM: true }).ignoreBOM)")).toBe('true');
  });

  it('should strip UTF-8 BOM by default', async () => {
    const result = await evalStr(`
      new TextDecoder().decode(new Uint8Array([0xEF, 0xBB, 0xBF, 0x41]))
    `);
    expect(result).toBe('A');
  });

  it('should keep BOM when ignoreBOM is true', async () => {
    const result = await evalJSON(`
      (() => {
        var str = new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array([0xEF, 0xBB, 0xBF, 0x41]));
        return { len: str.length, code0: str.charCodeAt(0), code1: str.charCodeAt(1) };
      })()
    `);
    expect(result.len).toBe(2);
    expect(result.code0).toBe(0xFEFF); // BOM
    expect(result.code1).toBe(0x41);   // 'A'
  });

  it('should decode ArrayBuffer directly', async () => {
    const result = await evalStr(`
      const buf = new Uint8Array([0x48, 0x69]).buffer;
      new TextDecoder().decode(buf)
    `);
    expect(result).toBe('Hi');
  });

  it('should decode DataView', async () => {
    const result = await evalStr(`
      const buf = new Uint8Array([0x48, 0x69]).buffer;
      new TextDecoder().decode(new DataView(buf))
    `);
    expect(result).toBe('Hi');
  });

  it('should handle empty Uint8Array', async () => {
    expect(await evalStr('new TextDecoder().decode(new Uint8Array([]))')).toBe('');
  });
});

describe('TextDecoder labels', () => {
  it('should accept "utf-8" label', async () => {
    expect(await evalStr("new TextDecoder('utf-8').encoding")).toBe('utf-8');
  });

  it('should accept "utf8" label (alias)', async () => {
    expect(await evalStr("new TextDecoder('utf8').encoding")).toBe('utf-8');
  });

  it('should accept "UTF-8" label (case-insensitive)', async () => {
    expect(await evalStr("new TextDecoder('UTF-8').encoding")).toBe('utf-8');
  });

  it('should accept label with leading/trailing whitespace', async () => {
    expect(await evalStr("new TextDecoder('  utf-8  ').encoding")).toBe('utf-8');
  });

  it('should accept "utf-16le" label', async () => {
    expect(await evalStr("new TextDecoder('utf-16le').encoding")).toBe('utf-16le');
  });

  it('should accept "utf-16be" label', async () => {
    expect(await evalStr("new TextDecoder('utf-16be').encoding")).toBe('utf-16be');
  });

  it('should accept "utf-16" label (maps to utf-16le)', async () => {
    expect(await evalStr("new TextDecoder('utf-16').encoding")).toBe('utf-16le');
  });

  it('should throw RangeError for unsupported encoding', async () => {
    using vm = await createVM();
    expect(() => {
      vm.evalCode("new TextDecoder('windows-1252')");
    }).toThrow();
  });

  it('should throw RangeError for replacement encoding', async () => {
    using vm = await createVM();
    expect(() => {
      vm.evalCode("new TextDecoder('replacement')");
    }).toThrow();
  });

  it('should include the label in the error message for replacement encoding', async () => {
    const result = await evalStr(`
      try {
        new TextDecoder('csiso2022kr');
        'no error';
      } catch(e) {
        e.message;
      }
    `);
    expect(result).toContain('csiso2022kr');
  });

  it('should throw RangeError for completely invalid label', async () => {
    using vm = await createVM();
    expect(() => {
      vm.evalCode("new TextDecoder('not-a-real-encoding')");
    }).toThrow();
  });
});

describe('TextDecoder UTF-16', () => {
  it('should decode UTF-16LE bytes', async () => {
    const result = await evalStr(`
      new TextDecoder('utf-16le').decode(new Uint8Array([0x48, 0x00, 0x69, 0x00]))
    `);
    expect(result).toBe('Hi');
  });

  it('should decode UTF-16BE bytes', async () => {
    const result = await evalStr(`
      new TextDecoder('utf-16be').decode(new Uint8Array([0x00, 0x48, 0x00, 0x69]))
    `);
    expect(result).toBe('Hi');
  });

  it('should decode UTF-16LE with BOM stripping', async () => {
    const result = await evalStr(`
      new TextDecoder('utf-16le').decode(new Uint8Array([0xFF, 0xFE, 0x41, 0x00]))
    `);
    expect(result).toBe('A');
  });

  it('should decode UTF-16BE with BOM stripping', async () => {
    const result = await evalStr(`
      new TextDecoder('utf-16be').decode(new Uint8Array([0xFE, 0xFF, 0x00, 0x41]))
    `);
    expect(result).toBe('A');
  });

  it('should decode UTF-16LE surrogate pair', async () => {
    // U+1D11E (G-clef) as UTF-16LE: D834 DD1E → [0x34, 0xD8, 0x1E, 0xDD]
    const result = await evalStr(`
      new TextDecoder('utf-16le').decode(new Uint8Array([0x34, 0xD8, 0x1E, 0xDD]))
    `);
    expect(result).toBe('\uD834\uDD1E'); // G-clef
  });

  it('should decode UTF-16BE surrogate pair', async () => {
    // U+1D11E as UTF-16BE: D834 DD1E → [0xD8, 0x34, 0xDD, 0x1E]
    const result = await evalStr(`
      new TextDecoder('utf-16be').decode(new Uint8Array([0xD8, 0x34, 0xDD, 0x1E]))
    `);
    expect(result).toBe('\uD834\uDD1E');
  });

  it('should handle truncated UTF-16 code unit', async () => {
    // Only 1 byte (needs 2 for a code unit)
    const result = await evalStr(`
      new TextDecoder('utf-16le').decode(new Uint8Array([0x41]))
    `);
    // Per spec, truncated = error → U+FFFD
    expect(result).toBe('\uFFFD');
  });

  it('should throw in fatal mode for truncated UTF-16', async () => {
    using vm = await createVM();
    expect(() => {
      vm.evalCode(`
        new TextDecoder('utf-16le', { fatal: true }).decode(new Uint8Array([0x41]))
      `);
    }).toThrow();
  });
});

describe('TextDecoder streaming', () => {
  it('should decode streaming UTF-8 across chunks', async () => {
    const result = await evalStr(`
      const decoder = new TextDecoder();
      let out = '';
      // é = U+00E9 = 0xC3 0xA9 — split across two chunks
      out += decoder.decode(new Uint8Array([0xC3]), { stream: true });
      out += decoder.decode(new Uint8Array([0xA9]));
      out
    `);
    expect(result).toBe('é');
  });

  it('should handle streaming with 3-byte sequence split', async () => {
    const result = await evalStr(`
      const decoder = new TextDecoder();
      let out = '';
      // € = U+20AC = 0xE2 0x82 0xAC — split across three chunks
      out += decoder.decode(new Uint8Array([0xE2]), { stream: true });
      out += decoder.decode(new Uint8Array([0x82]), { stream: true });
      out += decoder.decode(new Uint8Array([0xAC]));
      out
    `);
    expect(result).toBe('€');
  });

  it('should handle streaming with 4-byte sequence split', async () => {
    const result = await evalStr(`
      const decoder = new TextDecoder();
      let out = '';
      // 💩 = U+1F4A9 = 0xF0 0x9F 0x92 0xA9
      out += decoder.decode(new Uint8Array([0xF0, 0x9F, 0x92]), { stream: true });
      out += decoder.decode(new Uint8Array([0xA9]));
      out
    `);
    expect(result).toBe('💩');
  });

  it('should emit U+FFFD for incomplete sequence at end of stream', async () => {
    const result = await evalStr(`
      const decoder = new TextDecoder();
      decoder.decode(new Uint8Array([0xC3]), { stream: true });
      decoder.decode()
    `);
    expect(result).toBe('\uFFFD');
  });

  it('should reset decoder state between non-streaming calls', async () => {
    const result = await evalStr(`
      const decoder = new TextDecoder();
      // First call: incomplete, non-streaming
      const r1 = decoder.decode(new Uint8Array([0xC3]));
      // Second call: regular decode
      const r2 = decoder.decode(new Uint8Array([0x41]));
      r1 + '|' + r2
    `);
    expect(result).toBe('\uFFFD|A');
  });
});

describe('TextEncoder + TextDecoder round-trip', () => {
  it('should round-trip ASCII', async () => {
    const result = await evalStr(`
      const encoded = new TextEncoder().encode('Hello, world!');
      new TextDecoder().decode(encoded)
    `);
    expect(result).toBe('Hello, world!');
  });

  it('should round-trip multi-byte characters', async () => {
    const result = await evalStr(`
      const text = 'z\\u00A2\\u6C34\\uD834\\uDD1E';
      const encoded = new TextEncoder().encode(text);
      new TextDecoder().decode(encoded)
    `);
    expect(result).toBe('z\u00A2\u6C34\uD834\uDD1E');
  });

  it('should round-trip emoji', async () => {
    const result = await evalStr(`
      const encoded = new TextEncoder().encode('Hello 🌍!');
      new TextDecoder().decode(encoded)
    `);
    expect(result).toBe('Hello 🌍!');
  });

  it('should round-trip empty string', async () => {
    const result = await evalStr(`
      const encoded = new TextEncoder().encode('');
      new TextDecoder().decode(encoded)
    `);
    expect(result).toBe('');
  });
});
