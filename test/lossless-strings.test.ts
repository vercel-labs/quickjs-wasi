import { describe, expect, it } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

/**
 * Lossless string transport across the WASM boundary.
 *
 * Guest→host previously read strings through NUL-terminated
 * `JS_ToCString`: embedded U+0000 truncated the string, and lone
 * surrogates were replaced with U+FFFD — and the two corruptions can
 * cancel each other's length changes, so no length check downstream can
 * detect the loss. Host→guest previously encoded with TextEncoder, which
 * replaces lone surrogates with U+FFFD before the guest ever sees them
 * (and can mask the guest→host loss in tests by corrupting both sides
 * identically).
 *
 * Now: guest→host reads length-aware WTF-8 (`qjs_get_string_len`), and
 * host→guest writes WTF-8 (`writeString`), so every JS string — a
 * sequence of arbitrary UTF-16 code units — round-trips exactly. Keys are
 * covered by routing string keys that C strings cannot express (NULs,
 * unpaired surrogates) through length-aware guest string values.
 */

// Escape source so the guest receives exact code units regardless of the
// transport under test (avoids the both-sides-corrupted trap).
// NOTE: iterate by CODE UNIT (index), not by code point — Array.from /
// for..of iterate code points and would collapse surrogate pairs.
const guestLiteral = (s: string) => {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    out += `\\u${s.charCodeAt(i).toString(16).padStart(4, '0')}`;
  }
  return `${out}"`;
};

const CASES: [string, string][] = [
  ['embedded NUL', 'ab\u0000cd'],
  ['leading NUL', '\u0000x'],
  ['trailing NUL', 'x\u0000'],
  ['bare lone high surrogate', '\ud800'],
  ['bare lone low surrogate', '\udfff'],
  ['length-canceling surrogate + NUL', '\ud800\u0000a'],
  ['legit replacement char', 'already\ufffdhere'],
  ['well-formed pair (emoji)', 'emoji \u{1F600} pair'],
  ['mixed', 'a\u0000\ud800\u{1F600}\udc00z'],
];

describe('guest→host: toString is lossless', () => {
  it.each(CASES)('%s', async (_name, value) => {
    using vm = await QuickJS.create(wasmBytes);
    using handle = vm.evalCode(guestLiteral(value));
    expect(handle.toString()).toBe(value);
    expect(handle.length).toBe(value.length);
  });
});

describe('host→guest: newString / evalCode sources are lossless', () => {
  it.each(CASES)('newString: %s', async (_name, value) => {
    using vm = await QuickJS.create(wasmBytes);
    using handle = vm.newString(value);
    vm.setProp(vm.global, 'probe', handle);
    using match = vm.evalCode(`probe === ${guestLiteral(value)}`);
    expect(match.toBoolean()).toBe(true);
  });

  it('full host→guest→host round trip', async () => {
    using vm = await QuickJS.create(wasmBytes);
    for (const [, value] of CASES) {
      using handle = vm.newString(value);
      expect(handle.toString()).toBe(value);
    }
  });
});

describe('property keys with NULs / lone surrogates', () => {
  const KEY_OBJ = `({
    ${guestLiteral('a\u0000b')}: 1,
    ${guestLiteral('\ud800k')}: 2,
    ${guestLiteral('mix\ud800\u0000ed')}: 3,
    plain: 4,
  })`;

  it('enumeration APIs return exact keys', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode(KEY_OBJ);
    expect(obj.keys()).toEqual(['a\u0000b', '\ud800k', 'mix\ud800\u0000ed', 'plain']);
    expect(obj.getOwnPropertyNames()).toEqual([
      'a\u0000b',
      '\ud800k',
      'mix\ud800\u0000ed',
      'plain',
    ]);
  });

  it('getProp / setProp round-trip mangled keys', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode(KEY_OBJ);
    expect(obj.getProp('a\u0000b').consume((h) => h.toNumber())).toBe(1);
    expect(obj.getProp('\ud800k').consume((h) => h.toNumber())).toBe(2);
    expect(obj.getProp('mix\ud800\u0000ed').consume((h) => h.toNumber())).toBe(3);

    using value = vm.newNumber(9);
    obj.setProp('new\u0000\ud800key', value);
    using read = obj.getProp('new\u0000\ud800key');
    expect(read.toNumber()).toBe(9);
  });

  it('hasOwnProperty / propertyIsEnumerable / defineProp handle mangled keys', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode(KEY_OBJ);
    expect(obj.hasOwnProperty('a\u0000b')).toBe(true);
    expect(obj.hasOwnProperty('\ud800k')).toBe(true);
    expect(obj.hasOwnProperty('a')).toBe(false); // NOT the truncated form
    expect(obj.propertyIsEnumerable('\ud800k')).toBe(true);

    using target = vm.newObject();
    using v = vm.newNumber(5);
    target.defineProp('def\u0000\ud800', v, { enumerable: true });
    expect(target.getProp('def\u0000\ud800').consume((h) => h.toNumber())).toBe(5);
    expect(target.keys()).toEqual(['def\u0000\ud800']);
  });

  it('getOwnPropertyDescriptor resolves mangled string keys', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using obj = vm.evalCode(KEY_OBJ);
    const desc = obj.getOwnPropertyDescriptor('mix\ud800\u0000ed');
    expect(desc).toBeDefined();
    expect(desc?.value?.consume((h) => h.toNumber())).toBe(3);
    desc?.get?.dispose();
    desc?.set?.dispose();
  });
});
