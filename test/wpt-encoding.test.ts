/**
 * Web Platform Tests for the Encoding API (TextEncoder / TextDecoder)
 *
 * Ported from:
 *   https://github.com/nicolo-ribaudo/nicolo-ribaudo.github.io - NO
 *   https://github.com/nicolo-ribaudo/nicolo-ribaudo.github.io - NO
 *   https://github.com/web-platform-tests/wpt/tree/master/encoding
 *
 * Each WPT test case is mapped to an individual vitest test for clear
 * pass/fail reporting. Tests that require legacy encodings not supported
 * by our implementation (only UTF-8, UTF-16LE, UTF-16BE) are skipped.
 *
 * Reference: https://encoding.spec.whatwg.org/
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const encodingExtBytes = readFileSync(
  resolve(__dirname, '..', 'extensions', 'encoding', 'encoding.so')
);

/** Create a VM with the encoding extension */
async function createVM() {
  return QuickJS.create({
    wasm: wasmBytes,
    extensions: [{ name: 'encoding', wasm: encodingExtBytes }],
  });
}

// ========================================================================
// WPT: api-basics.any.js
// ========================================================================
describe('WPT: api-basics', () => {
  it('Default encodings', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`JSON.stringify({
      encoder: new TextEncoder().encoding,
      decoder: new TextDecoder().encoding,
    })`);
    const r = JSON.parse(result.toString());
    result.dispose();
    expect(r.encoder).toBe('utf-8');
    expect(r.decoder).toBe('utf-8');
  });

  it('Default inputs - encode() with no args', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`JSON.stringify(Array.from(new TextEncoder().encode()))`);
    expect(JSON.parse(result.toString())).toEqual([]);
    result.dispose();
  });

  it('Default inputs - encode(undefined)', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`JSON.stringify(Array.from(new TextEncoder().encode(undefined)))`);
    expect(JSON.parse(result.toString())).toEqual([]);
    result.dispose();
  });

  it('Encode/decode round trip: utf-8', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var sample = 'z\\xA2\\u6C34\\uD834\\uDD1E\\uF8FF\\uDBFF\\uDFFD\\uFFFE';
      var bytes = [0x7A, 0xC2, 0xA2, 0xE6, 0xB0, 0xB4, 0xF0, 0x9D, 0x84, 0x9E,
                   0xEF, 0xA3, 0xBF, 0xF4, 0x8F, 0xBF, 0xBD, 0xEF, 0xBF, 0xBE];
      var encoded = new TextEncoder().encode(sample);
      var decoded = new TextDecoder('utf-8').decode(new Uint8Array(bytes));
      JSON.stringify({
        encodedMatch: JSON.stringify(Array.from(encoded)) === JSON.stringify(bytes),
        decodedMatch: decoded === sample,
      })
    `);
    const r = JSON.parse(result.toString());
    result.dispose();
    expect(r.encodedMatch).toBe(true);
    expect(r.decodedMatch).toBe(true);
  });

  it('Decode sample: utf-16le', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var sample = 'z\\xA2\\u6C34\\uD834\\uDD1E\\uF8FF\\uDBFF\\uDFFD\\uFFFE';
      var bytes = [0x7A, 0x00, 0xA2, 0x00, 0x34, 0x6C, 0x34, 0xD8, 0x1E, 0xDD,
                   0xFF, 0xF8, 0xFF, 0xDB, 0xFD, 0xDF, 0xFE, 0xFF];
      var decoded1 = new TextDecoder('utf-16le').decode(new Uint8Array(bytes));
      var decoded2 = new TextDecoder('utf-16le').decode(new Uint8Array(bytes).buffer);
      JSON.stringify({ match1: decoded1 === sample, match2: decoded2 === sample })
    `);
    const r = JSON.parse(result.toString());
    result.dispose();
    expect(r.match1).toBe(true);
    expect(r.match2).toBe(true);
  });

  it('Decode sample: utf-16be', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var sample = 'z\\xA2\\u6C34\\uD834\\uDD1E\\uF8FF\\uDBFF\\uDFFD\\uFFFE';
      var bytes = [0x00, 0x7A, 0x00, 0xA2, 0x6C, 0x34, 0xD8, 0x34, 0xDD, 0x1E,
                   0xF8, 0xFF, 0xDB, 0xFF, 0xDF, 0xFD, 0xFF, 0xFE];
      var decoded = new TextDecoder('utf-16be').decode(new Uint8Array(bytes));
      String(decoded === sample)
    `);
    expect(result.toString()).toBe('true');
    result.dispose();
  });

  it('Decode sample: utf-16 (alias for utf-16le)', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var sample = 'z\\xA2\\u6C34\\uD834\\uDD1E\\uF8FF\\uDBFF\\uDFFD\\uFFFE';
      var bytes = [0x7A, 0x00, 0xA2, 0x00, 0x34, 0x6C, 0x34, 0xD8, 0x1E, 0xDD,
                   0xFF, 0xF8, 0xFF, 0xDB, 0xFD, 0xDF, 0xFE, 0xFF];
      String(new TextDecoder('utf-16').decode(new Uint8Array(bytes)) === sample)
    `);
    expect(result.toString()).toBe('true');
    result.dispose();
  });
});

// ========================================================================
// WPT: api-surrogates-utf8.any.js
// ========================================================================
describe('WPT: api-surrogates-utf8', () => {
  const badStrings = [
    {
      input: 'abc123',
      expected: [0x61, 0x62, 0x63, 0x31, 0x32, 0x33],
      decoded: 'abc123',
      name: 'Sanity check',
    },
    {
      input: '\\uD800',
      expected: [0xef, 0xbf, 0xbd],
      decoded: '\\uFFFD',
      name: 'Surrogate half (low)',
    },
    {
      input: '\\uDC00',
      expected: [0xef, 0xbf, 0xbd],
      decoded: '\\uFFFD',
      name: 'Surrogate half (high)',
    },
    {
      input: 'abc\\uD800123',
      expected: [0x61, 0x62, 0x63, 0xef, 0xbf, 0xbd, 0x31, 0x32, 0x33],
      decoded: 'abc\\uFFFD123',
      name: 'Surrogate half (low), in a string',
    },
    {
      input: 'abc\\uDC00123',
      expected: [0x61, 0x62, 0x63, 0xef, 0xbf, 0xbd, 0x31, 0x32, 0x33],
      decoded: 'abc\\uFFFD123',
      name: 'Surrogate half (high), in a string',
    },
    {
      input: '\\uDC00\\uD800',
      expected: [0xef, 0xbf, 0xbd, 0xef, 0xbf, 0xbd],
      decoded: '\\uFFFD\\uFFFD',
      name: 'Wrong order',
    },
  ];

  for (const t of badStrings) {
    it(`Invalid surrogates encoded into UTF-8: ${t.name}`, async () => {
      using vm = await createVM();
      const result = vm.evalCode(`
        var encoded = new TextEncoder().encode('${t.input}');
        var decoded = new TextDecoder('utf-8').decode(encoded);
        JSON.stringify({
          bytes: Array.from(encoded),
          decoded: decoded,
          expectedDecoded: '${t.decoded}',
        })
      `);
      const r = JSON.parse(result.toString());
      result.dispose();
      expect(r.bytes).toEqual(t.expected);
      expect(r.decoded).toBe(r.expectedDecoded);
    });
  }
});

// ========================================================================
// WPT: textencoder-utf16-surrogates.any.js
// ========================================================================
describe('WPT: textencoder-utf16-surrogates', () => {
  const cases = [
    { input: '\\uD800', expected: '\\uFFFD', name: 'lone surrogate lead' },
    { input: '\\uDC00', expected: '\\uFFFD', name: 'lone surrogate trail' },
    { input: '\\uD800\\u0000', expected: '\\uFFFD\\u0000', name: 'unmatched surrogate lead' },
    { input: '\\uDC00\\u0000', expected: '\\uFFFD\\u0000', name: 'unmatched surrogate trail' },
    { input: '\\uDC00\\uD800', expected: '\\uFFFD\\uFFFD', name: 'swapped surrogate pair' },
    { input: '\\uD834\\uDD1E', expected: '\\uD834\\uDD1E', name: 'properly encoded MUSICAL SYMBOL G CLEF' },
  ];

  for (const t of cases) {
    it(`USVString handling: ${t.name}`, async () => {
      using vm = await createVM();
      const result = vm.evalCode(`
        var encoded = new TextEncoder().encode('${t.input}');
        var decoded = new TextDecoder().decode(encoded);
        String(decoded === '${t.expected}')
      `);
      expect(result.toString()).toBe('true');
      result.dispose();
    });
  }

  it('USVString default', async () => {
    using vm = await createVM();
    const result = vm.evalCode('String(new TextEncoder().encode().length)');
    expect(result.toString()).toBe('0');
    result.dispose();
  });
});

// ========================================================================
// WPT: textencoder-constructor-non-utf.any.js
// ========================================================================
describe('WPT: textencoder-constructor-non-utf', () => {
  // Per spec, TextEncoder constructor ignores the encoding argument
  // and always produces UTF-8.
  const labels = ['utf-8', 'UTF-8', 'utf8', 'iso-8859-1', 'windows-1252', 'ascii'];

  for (const label of labels) {
    it(`Encoding argument not considered for encode: ${label}`, async () => {
      using vm = await createVM();
      const result = vm.evalCode(`new TextEncoder('${label}').encoding`);
      expect(result.toString()).toBe('utf-8');
      result.dispose();
    });
  }
});

// ========================================================================
// WPT: textdecoder-byte-order-marks.any.js
// ========================================================================
describe('WPT: textdecoder-byte-order-marks', () => {
  const string = 'z\\xA2\\u6C34\\uD834\\uDD1E\\uDBFF\\uDFFD';

  const testCases = [
    {
      encoding: 'utf-8',
      bom: [0xEF, 0xBB, 0xBF],
      bytes: [0x7A, 0xC2, 0xA2, 0xE6, 0xB0, 0xB4, 0xF0, 0x9D, 0x84, 0x9E, 0xF4, 0x8F, 0xBF, 0xBD],
    },
    {
      encoding: 'utf-16le',
      bom: [0xff, 0xfe],
      bytes: [0x7A, 0x00, 0xA2, 0x00, 0x34, 0x6C, 0x34, 0xD8, 0x1E, 0xDD, 0xFF, 0xDB, 0xFD, 0xDF],
    },
    {
      encoding: 'utf-16be',
      bom: [0xfe, 0xff],
      bytes: [0x00, 0x7A, 0x00, 0xA2, 0x6C, 0x34, 0xD8, 0x34, 0xDD, 0x1E, 0xDB, 0xFF, 0xDF, 0xFD],
    },
  ];

  for (const t of testCases) {
    it(`Byte-order marks: ${t.encoding} - without BOM`, async () => {
      using vm = await createVM();
      const result = vm.evalCode(`
        var expected = '${string}';
        var decoder = new TextDecoder('${t.encoding}');
        String(decoder.decode(new Uint8Array(${JSON.stringify(t.bytes)})) === expected)
      `);
      expect(result.toString()).toBe('true');
      result.dispose();
    });

    it(`Byte-order marks: ${t.encoding} - with BOM stripped`, async () => {
      using vm = await createVM();
      const bomAndBytes = JSON.stringify([...t.bom, ...t.bytes]);
      const result = vm.evalCode(`
        var expected = '${string}';
        var decoder = new TextDecoder('${t.encoding}');
        String(decoder.decode(new Uint8Array(${bomAndBytes})) === expected)
      `);
      expect(result.toString()).toBe('true');
      result.dispose();
    });
  }
});

// ========================================================================
// WPT: textdecoder-fatal.any.js
// ========================================================================
describe('WPT: textdecoder-fatal', () => {
  const bad = [
    { encoding: 'utf-8', input: [0xFF], name: 'invalid code' },
    { encoding: 'utf-8', input: [0xC0], name: 'ends early' },
    { encoding: 'utf-8', input: [0xE0], name: 'ends early 2' },
    { encoding: 'utf-8', input: [0xC0, 0x00], name: 'invalid trail' },
    { encoding: 'utf-8', input: [0xC0, 0xC0], name: 'invalid trail 2' },
    { encoding: 'utf-8', input: [0xE0, 0x00], name: 'invalid trail 3' },
    { encoding: 'utf-8', input: [0xE0, 0xC0], name: 'invalid trail 4' },
    { encoding: 'utf-8', input: [0xE0, 0x80, 0x00], name: 'invalid trail 5' },
    { encoding: 'utf-8', input: [0xE0, 0x80, 0xC0], name: 'invalid trail 6' },
    { encoding: 'utf-8', input: [0xFC, 0x80, 0x80, 0x80, 0x80, 0x80], name: '> 0x10FFFF' },
    { encoding: 'utf-8', input: [0xFE, 0x80, 0x80, 0x80, 0x80, 0x80], name: 'obsolete lead byte' },
    // Overlong encodings
    { encoding: 'utf-8', input: [0xC0, 0x80], name: 'overlong U+0000 - 2 bytes' },
    { encoding: 'utf-8', input: [0xE0, 0x80, 0x80], name: 'overlong U+0000 - 3 bytes' },
    { encoding: 'utf-8', input: [0xF0, 0x80, 0x80, 0x80], name: 'overlong U+0000 - 4 bytes' },
    { encoding: 'utf-8', input: [0xC1, 0xBF], name: 'overlong U+007F - 2 bytes' },
    { encoding: 'utf-8', input: [0xE0, 0x81, 0xBF], name: 'overlong U+007F - 3 bytes' },
    { encoding: 'utf-8', input: [0xE0, 0x9F, 0xBF], name: 'overlong U+07FF - 3 bytes' },
    { encoding: 'utf-8', input: [0xF0, 0x8F, 0xBF, 0xBF], name: 'overlong U+FFFF - 4 bytes' },
    // UTF-16 surrogates encoded as code points in UTF-8
    { encoding: 'utf-8', input: [0xED, 0xA0, 0x80], name: 'lead surrogate' },
    { encoding: 'utf-8', input: [0xED, 0xB0, 0x80], name: 'trail surrogate' },
    { encoding: 'utf-8', input: [0xED, 0xA0, 0x80, 0xED, 0xB0, 0x80], name: 'surrogate pair' },
    // UTF-16
    { encoding: 'utf-16le', input: [0x00], name: 'truncated code unit' },
  ];

  for (const t of bad) {
    it(`Fatal flag: ${t.encoding} - ${t.name}`, async () => {
      using vm = await createVM();
      expect(() => {
        vm.evalCode(`
          new TextDecoder('${t.encoding}', { fatal: true })
            .decode(new Uint8Array(${JSON.stringify(t.input)}))
        `);
      }).toThrow();
    });
  }

  it('The fatal attribute should exist and default to false', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`JSON.stringify({
      exists: 'fatal' in new TextDecoder(),
      type: typeof new TextDecoder().fatal,
      defaultValue: new TextDecoder().fatal,
      canSet: new TextDecoder('utf-8', { fatal: true }).fatal,
    })`);
    const r = JSON.parse(result.toString());
    result.dispose();
    expect(r.exists).toBe(true);
    expect(r.type).toBe('boolean');
    expect(r.defaultValue).toBe(false);
    expect(r.canSet).toBe(true);
  });

  it('Error seen with fatal does not prevent future decodes', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var bytes = new Uint8Array([226, 153, 165]);
      var decoder = new TextDecoder('utf-8', { fatal: true });
      var r1 = decoder.decode(new DataView(bytes.buffer, 0, 3));
      var threw = false;
      try {
        decoder.decode(new DataView(bytes.buffer, 0, 2));
      } catch(e) { threw = true; }
      var r3 = decoder.decode(new DataView(bytes.buffer, 0, 3));
      JSON.stringify({ r1: r1, threw: threw, r3: r3 })
    `);
    const r = JSON.parse(result.toString());
    result.dispose();
    expect(r.r1).toBe('\u2665');
    expect(r.threw).toBe(true);
    expect(r.r3).toBe('\u2665');
  });
});

// ========================================================================
// WPT: textdecoder-ignorebom.any.js
// ========================================================================
describe('WPT: textdecoder-ignorebom', () => {
  const cases = [
    { encoding: 'utf-8', bytes: [0xEF, 0xBB, 0xBF, 0x61, 0x62, 0x63] },
    { encoding: 'utf-16le', bytes: [0xFF, 0xFE, 0x61, 0x00, 0x62, 0x00, 0x63, 0x00] },
    { encoding: 'utf-16be', bytes: [0xFE, 0xFF, 0x00, 0x61, 0x00, 0x62, 0x00, 0x63] },
  ];

  for (const t of cases) {
    it(`BOM is ignored if ignoreBOM option is specified: ${t.encoding}`, async () => {
      using vm = await createVM();
      const bytesStr = JSON.stringify(t.bytes);
      const result = vm.evalCode(`
        var BOM = '\\uFEFF';
        var bytes = new Uint8Array(${bytesStr});

        var d1 = new TextDecoder('${t.encoding}', { ignoreBOM: true });
        var r1 = d1.decode(bytes);
        var r2 = d1.decode(bytes);

        var d2 = new TextDecoder('${t.encoding}', { ignoreBOM: false });
        var r3 = d2.decode(bytes);
        var r4 = d2.decode(bytes);

        var d3 = new TextDecoder('${t.encoding}');
        var r5 = d3.decode(bytes);
        var r6 = d3.decode(bytes);

        JSON.stringify({
          ignoreBOM_first: r1 === BOM + 'abc',
          ignoreBOM_reused: r2 === BOM + 'abc',
          notIgnored_first: r3 === 'abc',
          notIgnored_reused: r4 === 'abc',
          default_first: r5 === 'abc',
          default_reused: r6 === 'abc',
        })
      `);
      const r = JSON.parse(result.toString());
      result.dispose();
      expect(r.ignoreBOM_first).toBe(true);
      expect(r.ignoreBOM_reused).toBe(true);
      expect(r.notIgnored_first).toBe(true);
      expect(r.notIgnored_reused).toBe(true);
      expect(r.default_first).toBe(true);
      expect(r.default_reused).toBe(true);
    });
  }

  it('The ignoreBOM attribute of TextDecoder', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`JSON.stringify({
      exists: 'ignoreBOM' in new TextDecoder(),
      type: typeof new TextDecoder().ignoreBOM,
      defaultValue: new TextDecoder().ignoreBOM,
      canSet: new TextDecoder('utf-8', { ignoreBOM: true }).ignoreBOM,
    })`);
    const r = JSON.parse(result.toString());
    result.dispose();
    expect(r.exists).toBe(true);
    expect(r.type).toBe('boolean');
    expect(r.defaultValue).toBe(false);
    expect(r.canSet).toBe(true);
  });
});

// ========================================================================
// WPT: textdecoder-arguments.any.js
// ========================================================================
describe('WPT: textdecoder-arguments', () => {
  it('TextDecoder decode() with explicit undefined', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var decoder = new TextDecoder();
      var r1 = decoder.decode(undefined);
      decoder.decode(new Uint8Array([0xc9]), { stream: true });
      var r2 = decoder.decode(undefined);
      JSON.stringify({ r1: r1, r2: r2 })
    `);
    const r = JSON.parse(result.toString());
    result.dispose();
    expect(r.r1).toBe('');
    expect(r.r2).toBe('\uFFFD');
  });

  it('TextDecoder decode() with undefined and undefined', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var decoder = new TextDecoder();
      var r1 = decoder.decode(undefined, undefined);
      decoder.decode(new Uint8Array([0xc9]), { stream: true });
      var r2 = decoder.decode(undefined, undefined);
      JSON.stringify({ r1: r1, r2: r2 })
    `);
    const r = JSON.parse(result.toString());
    result.dispose();
    expect(r.r1).toBe('');
    expect(r.r2).toBe('\uFFFD');
  });

  it('TextDecoder decode() with undefined and options', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var decoder = new TextDecoder();
      var r1 = decoder.decode(undefined, {});
      decoder.decode(new Uint8Array([0xc9]), { stream: true });
      var r2 = decoder.decode(undefined, {});
      JSON.stringify({ r1: r1, r2: r2 })
    `);
    const r = JSON.parse(result.toString());
    result.dispose();
    expect(r.r1).toBe('');
    expect(r.r2).toBe('\uFFFD');
  });
});

// ========================================================================
// WPT: textdecoder-streaming.any.js
// ========================================================================
describe('WPT: textdecoder-streaming', () => {
  const string = '\x00123ABCabc\x80\xFF\u0100\u1000\uFFFD\uD800\uDC00\uDBFF\uDFFF';
  const octets: Record<string, number[]> = {
    'utf-8': [
      0x00, 0x31, 0x32, 0x33, 0x41, 0x42, 0x43, 0x61, 0x62, 0x63, 0xc2, 0x80,
      0xc3, 0xbf, 0xc4, 0x80, 0xe1, 0x80, 0x80, 0xef, 0xbf, 0xbd, 0xf0, 0x90,
      0x80, 0x80, 0xf4, 0x8f, 0xbf, 0xbf,
    ],
    'utf-16le': [
      0x00, 0x00, 0x31, 0x00, 0x32, 0x00, 0x33, 0x00, 0x41, 0x00, 0x42, 0x00,
      0x43, 0x00, 0x61, 0x00, 0x62, 0x00, 0x63, 0x00, 0x80, 0x00, 0xFF, 0x00,
      0x00, 0x01, 0x00, 0x10, 0xFD, 0xFF, 0x00, 0xD8, 0x00, 0xDC, 0xFF, 0xDB,
      0xFF, 0xDF,
    ],
    'utf-16be': [
      0x00, 0x00, 0x00, 0x31, 0x00, 0x32, 0x00, 0x33, 0x00, 0x41, 0x00, 0x42,
      0x00, 0x43, 0x00, 0x61, 0x00, 0x62, 0x00, 0x63, 0x00, 0x80, 0x00, 0xFF,
      0x01, 0x00, 0x10, 0x00, 0xFF, 0xFD, 0xD8, 0x00, 0xDC, 0x00, 0xDB, 0xFF,
      0xDF, 0xFF,
    ],
  };

  for (const encoding of Object.keys(octets)) {
    for (let len = 1; len <= 5; len++) {
      it(`Streaming decode: ${encoding}, ${len} byte window`, async () => {
        using vm = await createVM();
        const encoded = octets[encoding];
        const result = vm.evalCode(`
          var encoded = ${JSON.stringify(encoded)};
          var expected = '${string.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}';
          var out = '';
          var decoder = new TextDecoder('${encoding}');
          for (var i = 0; i < encoded.length; i += ${len}) {
            var sub = encoded.slice(i, i + ${len});
            out += decoder.decode(new Uint8Array(sub), { stream: true });
          }
          out += decoder.decode();
          String(out === expected)
        `);
        expect(result.toString()).toBe('true');
        result.dispose();
      });
    }
  }

  // UTF-8 specific chunk tests
  it('Streaming decode: UTF-8 chunk tests - invalid lead bytes', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var decoder = new TextDecoder();
      var results = [];

      // 0xC1 is invalid lead byte -> immediate U+FFFD
      results.push(decoder.decode(new Uint8Array([0xC1]), { stream: true }) === '\\uFFFD');
      results.push(decoder.decode() === '');

      // 0xF5 is invalid lead byte -> immediate U+FFFD
      results.push(decoder.decode(new Uint8Array([0xF5]), { stream: true }) === '\\uFFFD');
      results.push(decoder.decode() === '');

      JSON.stringify(results)
    `);
    expect(JSON.parse(result.toString())).toEqual([true, true, true, true]);
    result.dispose();
  });

  it('Streaming decode: UTF-8 chunk tests - invalid continuation', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var decoder = new TextDecoder();
      var results = [];

      // 0xE0 0x41: E0 expects continuation >= 0xA0, gets ASCII -> U+FFFD + 'A'
      results.push(decoder.decode(new Uint8Array([0xE0, 0x41]), { stream: true }) === '\\uFFFDA');
      results.push(decoder.decode(new Uint8Array([0x42])) === 'B');

      // 0xE0 0x80: E0 expects continuation >= 0xA0, gets 0x80 -> U+FFFD, then 0x80 is also invalid
      results.push(decoder.decode(new Uint8Array([0xE0, 0x80]), { stream: true }) === '\\uFFFD\\uFFFD');
      results.push(decoder.decode(new Uint8Array([0x80])) === '\\uFFFD');

      JSON.stringify(results)
    `);
    expect(JSON.parse(result.toString())).toEqual([true, true, true, true]);
    result.dispose();
  });

  it('Streaming decode: UTF-8 chunk tests - surrogate range rejection', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var decoder = new TextDecoder();
      var results = [];

      // 0xED 0xA0: ED expects continuation <= 0x9F, gets 0xA0 -> surrogate range
      results.push(decoder.decode(new Uint8Array([0xED, 0xA0]), { stream: true }) === '\\uFFFD\\uFFFD');
      results.push(decoder.decode(new Uint8Array([0x80])) === '\\uFFFD');

      JSON.stringify(results)
    `);
    expect(JSON.parse(result.toString())).toEqual([true, true]);
    result.dispose();
  });

  it('Streaming decode: UTF-8 chunk tests - 4-byte sequences', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var decoder = new TextDecoder();
      var results = [];

      // F0 41: F0 expects continuation >= 0x90, gets ASCII
      results.push(decoder.decode(new Uint8Array([0xF0, 0x41]), { stream: true }) === '\\uFFFDA');
      results.push(decoder.decode(new Uint8Array([0x42]), { stream: true }) === 'B');
      results.push(decoder.decode(new Uint8Array([0x43])) === 'C');

      // F0 80: F0 expects continuation >= 0x90, gets 0x80
      results.push(decoder.decode(new Uint8Array([0xF0, 0x80]), { stream: true }) === '\\uFFFD\\uFFFD');
      results.push(decoder.decode(new Uint8Array([0x80]), { stream: true }) === '\\uFFFD');
      results.push(decoder.decode(new Uint8Array([0x80])) === '\\uFFFD');

      // F4 A0: F4 expects continuation <= 0x8F, gets 0xA0
      results.push(decoder.decode(new Uint8Array([0xF4, 0xA0]), { stream: true }) === '\\uFFFD\\uFFFD');
      results.push(decoder.decode(new Uint8Array([0x80]), { stream: true }) === '\\uFFFD');
      results.push(decoder.decode(new Uint8Array([0x80])) === '\\uFFFD');

      // F0 90 41: valid start but ASCII interrupts
      results.push(decoder.decode(new Uint8Array([0xF0, 0x90, 0x41]), { stream: true }) === '\\uFFFDA');
      results.push(decoder.decode(new Uint8Array([0x42])) === 'B');

      JSON.stringify(results)
    `);
    expect(JSON.parse(result.toString())).toEqual([
      true, true, true, true, true, true, true, true, true, true, true,
    ]);
    result.dispose();
  });

  it('Streaming decode: 4-byte UTF-8 emits only on last byte', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var decoder = new TextDecoder();
      // U+1F4A9 = F0 9F 92 A9
      var r1 = decoder.decode(new Uint8Array([0xF0, 0x9F, 0x92]), { stream: true });
      var r2 = decoder.decode(new Uint8Array([0xA9]));
      JSON.stringify({ r1: r1, r2: r2 })
    `);
    const r = JSON.parse(result.toString());
    result.dispose();
    expect(r.r1).toBe('');
    expect(r.r2).toBe('\u{1F4A9}');
  });
});

// ========================================================================
// WPT: textdecoder-labels.any.js (UTF-8 and UTF-16 labels only)
// ========================================================================
describe('WPT: textdecoder-labels', () => {
  const whitespace = [' ', '\t', '\n', '\f', '\r'];

  const supportedEncodings = [
    {
      name: 'UTF-8',
      labels: ['unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'utf-8', 'utf8', 'x-unicode20utf8'],
      canonical: 'utf-8',
    },
    {
      name: 'UTF-16LE',
      labels: ['csunicode', 'iso-10646-ucs-2', 'ucs-2', 'unicode', 'unicodefeff', 'utf-16', 'utf-16le'],
      canonical: 'utf-16le',
    },
    {
      name: 'UTF-16BE',
      labels: ['unicodefffe', 'utf-16be'],
      canonical: 'utf-16be',
    },
  ];

  for (const enc of supportedEncodings) {
    for (const label of enc.labels) {
      it(`${label} => ${enc.name}`, async () => {
        using vm = await createVM();
        const result = vm.evalCode(`JSON.stringify({
          direct: new TextDecoder('${label}').encoding,
          upper: new TextDecoder('${label.toUpperCase()}').encoding,
        })`);
        const r = JSON.parse(result.toString());
        result.dispose();
        expect(r.direct).toBe(enc.canonical);
        expect(r.upper).toBe(enc.canonical);
      });

      // Test with leading/trailing whitespace
      it(`${label} with whitespace => ${enc.name}`, async () => {
        using vm = await createVM();
        const result = vm.evalCode(`JSON.stringify({
          leading: new TextDecoder(' ${label}').encoding,
          trailing: new TextDecoder('${label} ').encoding,
          both: new TextDecoder(' ${label} ').encoding,
        })`);
        const r = JSON.parse(result.toString());
        result.dispose();
        expect(r.leading).toBe(enc.canonical);
        expect(r.trailing).toBe(enc.canonical);
        expect(r.both).toBe(enc.canonical);
      });
    }
  }
});

// ========================================================================
// WPT: api-invalid-label.any.js (subset)
// ========================================================================
describe('WPT: api-invalid-label', () => {
  it('should reject completely invalid label', async () => {
    using vm = await createVM();
    expect(() => {
      vm.evalCode("new TextDecoder('invalid-invalidLabel')");
    }).toThrow();
  });

  // Labels with embedded non-ASCII whitespace chars that look like
  // whitespace but are NOT ASCII whitespace per the spec
  const invalidWSChars = ['\\u0000', '\\u000b', '\\u00a0', '\\u2028', '\\u2029'];

  for (const ws of invalidWSChars) {
    it(`should reject label with embedded ${ws}`, async () => {
      using vm = await createVM();
      expect(() => {
        vm.evalCode(`new TextDecoder('${ws}utf-8')`);
      }).toThrow();
    });

    it(`should reject label with trailing ${ws}`, async () => {
      using vm = await createVM();
      expect(() => {
        vm.evalCode(`new TextDecoder('utf-8${ws}')`);
      }).toThrow();
    });
  }
});

// ========================================================================
// WPT: api-replacement-encodings.any.js
// ========================================================================
describe('WPT: api-replacement-encodings', () => {
  const replacementLabels = [
    'csiso2022kr',
    'hz-gb-2312',
    'iso-2022-cn',
    'iso-2022-cn-ext',
    'iso-2022-kr',
    'replacement',
  ];

  for (const label of replacementLabels) {
    it(`Replacement encoding label "${label}" should throw RangeError`, async () => {
      using vm = await createVM();
      expect(() => {
        vm.evalCode(`new TextDecoder('${label}')`);
      }).toThrow();
    });
  }
});

// ========================================================================
// WPT: encodeInto.any.js
// ========================================================================
describe('WPT: encodeInto', () => {
  const testData = [
    { input: 'Hi', read: 0, destinationLength: 0, written: [] as number[] },
    { input: 'A', read: 1, destinationLength: 10, written: [0x41] },
    { input: '\\u{1D306}', read: 2, destinationLength: 4, written: [0xF0, 0x9D, 0x8C, 0x86] },
    { input: '\\u{1D306}A', read: 0, destinationLength: 3, written: [] as number[] },
    {
      input: '\\uD834A\\uDF06A\\u00A5Hi',
      read: 5,
      destinationLength: 10,
      written: [0xEF, 0xBF, 0xBD, 0x41, 0xEF, 0xBF, 0xBD, 0x41, 0xC2, 0xA5],
    },
    { input: 'A\\uDF06', read: 2, destinationLength: 4, written: [0x41, 0xEF, 0xBF, 0xBD] },
    { input: '\\u00A5\\u00A5', read: 2, destinationLength: 4, written: [0xC2, 0xA5, 0xC2, 0xA5] },
  ];

  for (const td of testData) {
    it(`encodeInto() with "${td.input}" and destination length ${td.destinationLength}`, async () => {
      using vm = await createVM();
      const result = vm.evalCode(`
        var encoder = new TextEncoder();
        var view = new Uint8Array(${td.destinationLength});
        var result = encoder.encodeInto('${td.input}', view);
        JSON.stringify({
          read: result.read,
          written: result.written,
          bytes: Array.from(view),
        })
      `);
      const r = JSON.parse(result.toString());
      result.dispose();
      expect(r.read).toBe(td.read);
      expect(r.written).toBe(td.written.length);
      // Check that written bytes match
      for (let i = 0; i < td.written.length; i++) {
        expect(r.bytes[i]).toBe(td.written[i]);
      }
      // Check remaining bytes are zero
      for (let i = td.written.length; i < td.destinationLength; i++) {
        expect(r.bytes[i]).toBe(0);
      }
    });
  }

  // Invalid destination types
  const invalidTypes = [
    'Int8Array', 'Int16Array', 'Int32Array',
    'Uint16Array', 'Uint32Array', 'Uint8ClampedArray',
    'Float32Array', 'Float64Array',
  ];

  for (const type of invalidTypes) {
    it(`Invalid encodeInto() destination: ${type}`, async () => {
      using vm = await createVM();
      expect(() => {
        vm.evalCode(`new TextEncoder().encodeInto('', new ${type}(0))`);
      }).toThrow();
    });
  }
});

// ========================================================================
// WPT: textdecoder-utf16-surrogates.any.js
// ========================================================================
describe('WPT: textdecoder-utf16-surrogates', () => {
  it('should handle lone lead surrogate in UTF-16LE', async () => {
    using vm = await createVM();
    // D800 with no trail: [0x00, 0xD8] in LE = D800
    // Should produce U+FFFD
    const result = vm.evalCode(`
      var decoder = new TextDecoder('utf-16le');
      var r = decoder.decode(new Uint8Array([0x00, 0xD8]));
      String(r === '\\uFFFD')
    `);
    expect(result.toString()).toBe('true');
    result.dispose();
  });

  it('should handle lone trail surrogate in UTF-16LE', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var decoder = new TextDecoder('utf-16le');
      var r = decoder.decode(new Uint8Array([0x00, 0xDC]));
      String(r === '\\uFFFD')
    `);
    expect(result.toString()).toBe('true');
    result.dispose();
  });

  it('should handle valid surrogate pair in UTF-16LE', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var decoder = new TextDecoder('utf-16le');
      // D800 DC00 in LE = [0x00, 0xD8, 0x00, 0xDC] -> U+10000
      var r = decoder.decode(new Uint8Array([0x00, 0xD8, 0x00, 0xDC]));
      String(r === '\\uD800\\uDC00')
    `);
    expect(result.toString()).toBe('true');
    result.dispose();
  });

  it('should handle swapped surrogates in UTF-16LE', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var decoder = new TextDecoder('utf-16le');
      // DC00 D800 in LE = [0x00, 0xDC, 0x00, 0xD8]
      var r = decoder.decode(new Uint8Array([0x00, 0xDC, 0x00, 0xD8]));
      // DC00 is lone trail -> U+FFFD, D800 is lone lead -> U+FFFD
      String(r === '\\uFFFD\\uFFFD')
    `);
    expect(result.toString()).toBe('true');
    result.dispose();
  });

  it('should handle lead surrogate followed by BMP in UTF-16LE', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var decoder = new TextDecoder('utf-16le');
      // D800 0041 in LE = [0x00, 0xD8, 0x41, 0x00]
      var r = decoder.decode(new Uint8Array([0x00, 0xD8, 0x41, 0x00]));
      // D800 is unmatched lead -> U+FFFD, then 0041 -> 'A'
      String(r === '\\uFFFDA')
    `);
    expect(result.toString()).toBe('true');
    result.dispose();
  });
});

// ========================================================================
// WPT: textdecoder-fatal-streaming.any.js (subset)
// ========================================================================
describe('WPT: textdecoder-fatal-streaming', () => {
  it('fatal flag with streaming: incomplete sequence at end', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var decoder = new TextDecoder('utf-8', { fatal: true });
      var r1 = decoder.decode(new Uint8Array([0xC3]), { stream: true });
      var threw = false;
      try {
        decoder.decode(); // flush - incomplete sequence should throw
      } catch(e) { threw = true; }
      JSON.stringify({ r1: r1, threw: threw })
    `);
    const r = JSON.parse(result.toString());
    result.dispose();
    expect(r.r1).toBe('');
    expect(r.threw).toBe(true);
  });

  it('fatal flag with streaming: valid sequence split across chunks', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var decoder = new TextDecoder('utf-8', { fatal: true });
      var r1 = decoder.decode(new Uint8Array([0xC3]), { stream: true });
      var r2 = decoder.decode(new Uint8Array([0xA9]));
      JSON.stringify({ r1: r1, r2: r2 })
    `);
    const r = JSON.parse(result.toString());
    result.dispose();
    expect(r.r1).toBe('');
    expect(r.r2).toBe('\u00E9'); // é
  });
});

// ========================================================================
// WPT: textdecoder-eof.any.js (subset - EOF/truncated sequence tests)
// ========================================================================
describe('WPT: textdecoder-eof', () => {
  it('truncated 2-byte sequence at EOF produces U+FFFD', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      new TextDecoder().decode(new Uint8Array([0xC2]))
    `);
    expect(result.toString()).toBe('\uFFFD');
    result.dispose();
  });

  it('truncated 3-byte sequence (1 byte) at EOF produces U+FFFD', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      new TextDecoder().decode(new Uint8Array([0xE0]))
    `);
    expect(result.toString()).toBe('\uFFFD');
    result.dispose();
  });

  it('truncated 3-byte sequence (2 bytes) at EOF produces U+FFFD', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      new TextDecoder().decode(new Uint8Array([0xE0, 0xA0]))
    `);
    expect(result.toString()).toBe('\uFFFD');
    result.dispose();
  });

  it('truncated 4-byte sequence (1 byte) at EOF produces U+FFFD', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      new TextDecoder().decode(new Uint8Array([0xF0]))
    `);
    expect(result.toString()).toBe('\uFFFD');
    result.dispose();
  });

  it('truncated 4-byte sequence (2 bytes) at EOF produces U+FFFD', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      new TextDecoder().decode(new Uint8Array([0xF0, 0x90]))
    `);
    expect(result.toString()).toBe('\uFFFD');
    result.dispose();
  });

  it('truncated 4-byte sequence (3 bytes) at EOF produces U+FFFD', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      new TextDecoder().decode(new Uint8Array([0xF0, 0x90, 0x80]))
    `);
    expect(result.toString()).toBe('\uFFFD');
    result.dispose();
  });
});

// ========================================================================
// Additional UTF-8 replacement mode correctness tests
// ========================================================================
describe('WPT: UTF-8 replacement patterns', () => {
  it('invalid byte 0xFF produces single U+FFFD', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      new TextDecoder().decode(new Uint8Array([0xFF]))
    `);
    expect(result.toString()).toBe('\uFFFD');
    result.dispose();
  });

  it('invalid byte 0xFE produces single U+FFFD', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      new TextDecoder().decode(new Uint8Array([0xFE]))
    `);
    expect(result.toString()).toBe('\uFFFD');
    result.dispose();
  });

  it('overlong 2-byte for U+0000: C0 80 produces 2x U+FFFD', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var r = new TextDecoder().decode(new Uint8Array([0xC0, 0x80]));
      JSON.stringify(Array.from(r).map(c => c.charCodeAt(0)))
    `);
    const cps = JSON.parse(result.toString());
    result.dispose();
    // C0 is invalid lead byte (< C2) → U+FFFD, then 0x80 is invalid continuation → U+FFFD
    expect(cps).toEqual([0xFFFD, 0xFFFD]);
  });

  it('overlong 3-byte for U+0000: E0 80 80 produces 3x U+FFFD', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var r = new TextDecoder().decode(new Uint8Array([0xE0, 0x80, 0x80]));
      JSON.stringify(Array.from(r).map(c => c.charCodeAt(0)))
    `);
    const cps = JSON.parse(result.toString());
    result.dispose();
    // E0 expects >= A0, gets 0x80 → error + restore → U+FFFD, 0x80 → U+FFFD, 0x80 → U+FFFD
    expect(cps).toEqual([0xFFFD, 0xFFFD, 0xFFFD]);
  });

  it('surrogate in UTF-8: ED A0 80 produces 3x U+FFFD', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      var r = new TextDecoder().decode(new Uint8Array([0xED, 0xA0, 0x80]));
      JSON.stringify(Array.from(r).map(c => c.charCodeAt(0)))
    `);
    const cps = JSON.parse(result.toString());
    result.dispose();
    // ED expects <= 9F, gets A0 → error + restore → U+FFFD, A0 → U+FFFD, 80 → U+FFFD
    expect(cps).toEqual([0xFFFD, 0xFFFD, 0xFFFD]);
  });

  it('valid byte surrounded by invalid: FF 41 FF', async () => {
    using vm = await createVM();
    const result = vm.evalCode(`
      new TextDecoder().decode(new Uint8Array([0xFF, 0x41, 0xFF]))
    `);
    expect(result.toString()).toBe('\uFFFDA\uFFFD');
    result.dispose();
  });
});
