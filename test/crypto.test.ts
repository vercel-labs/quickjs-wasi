import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';
import { readFileSync } from 'node:fs';

const cryptoExtBytes = readFileSync(new URL('../extensions/crypto/crypto.so', import.meta.url));
const encodingExtBytes = readFileSync(new URL('../extensions/encoding/encoding.so', import.meta.url));

// We load both crypto and encoding extensions so TextEncoder is available
// for creating test data from strings.
async function createVM() {
  return QuickJS.create({
    wasm: wasmBytes,
    extensions: [
      { name: 'encoding', wasm: encodingExtBytes },
      { name: 'crypto', wasm: cryptoExtBytes },
    ],
  });
}

async function evalStr(code: string) {
  using vm = await createVM();
  // For async code: store result in a global, then read it after executePendingJobs
  vm.evalCode(`
    globalThis.__testResult__ = undefined;
    const __p__ = (${code.trim()});
    if (__p__ && typeof __p__ === 'object' && typeof __p__.then === 'function') {
      __p__.then(v => { globalThis.__testResult__ = String(v); },
                 e => { globalThis.__testResult__ = 'ERROR: ' + (e && e.message || e); });
    } else {
      globalThis.__testResult__ = String(__p__);
    }
  `).dispose();
  vm.executePendingJobs();
  const result = vm.evalCode('globalThis.__testResult__');
  const str = result.toString();
  result.dispose();
  return str;
}

async function evalJSON(code: string) {
  using vm = await createVM();
  vm.evalCode(`
    globalThis.__testResult__ = undefined;
    const __p__ = (${code.trim()});
    if (__p__ && typeof __p__ === 'object' && typeof __p__.then === 'function') {
      __p__.then(v => { globalThis.__testResult__ = JSON.stringify(v); },
                 e => { globalThis.__testResult__ = 'ERROR: ' + (e && e.message || e); });
    } else {
      globalThis.__testResult__ = JSON.stringify(__p__);
    }
  `).dispose();
  vm.executePendingJobs();
  const result = vm.evalCode('globalThis.__testResult__');
  const str = result.toString();
  result.dispose();
  return JSON.parse(str);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Crypto interface existence
// ═══════════════════════════════════════════════════════════════════════════════

describe('Crypto global constructor', () => {
  it('should define Crypto on globalThis as a function', async () => {
    expect(await evalStr('typeof Crypto')).toBe('function');
  });

  it('Crypto should be writable, non-enumerable, configurable on globalThis', async () => {
    const desc = await evalJSON(`Object.getOwnPropertyDescriptor(globalThis, 'Crypto')`);
    expect(desc.writable).toBe(true);
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(true);
  });

  it('Crypto.prototype should be non-writable, non-enumerable, non-configurable', async () => {
    const desc = await evalJSON(`(() => {
      const d = Object.getOwnPropertyDescriptor(Crypto, 'prototype');
      return { writable: d.writable, enumerable: d.enumerable, configurable: d.configurable };
    })()`);
    expect(desc.writable).toBe(false);
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(false);
  });

  it('new Crypto() should throw TypeError', async () => {
    expect(await evalStr('(() => { try { new Crypto(); return "no error"; } catch(e) { return e.constructor.name + ": " + e.message; } })()')).toBe('TypeError: Illegal constructor');
  });

  it('crypto instanceof Crypto should be true', async () => {
    expect(await evalStr('crypto instanceof Crypto')).toBe('true');
  });
});

describe('SubtleCrypto global constructor', () => {
  it('should define SubtleCrypto on globalThis as a function', async () => {
    expect(await evalStr('typeof SubtleCrypto')).toBe('function');
  });

  it('SubtleCrypto should be writable, non-enumerable, configurable on globalThis', async () => {
    const desc = await evalJSON(`Object.getOwnPropertyDescriptor(globalThis, 'SubtleCrypto')`);
    expect(desc.writable).toBe(true);
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(true);
  });

  it('SubtleCrypto.prototype should be non-writable, non-enumerable, non-configurable', async () => {
    const desc = await evalJSON(`(() => {
      const d = Object.getOwnPropertyDescriptor(SubtleCrypto, 'prototype');
      return { writable: d.writable, enumerable: d.enumerable, configurable: d.configurable };
    })()`);
    expect(desc.writable).toBe(false);
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(false);
  });

  it('new SubtleCrypto() should throw TypeError', async () => {
    expect(await evalStr('(() => { try { new SubtleCrypto(); return "no error"; } catch(e) { return e.constructor.name + ": " + e.message; } })()')).toBe('TypeError: Illegal constructor');
  });

  it('crypto.subtle instanceof SubtleCrypto should be true', async () => {
    expect(await evalStr('crypto.subtle instanceof SubtleCrypto')).toBe('true');
  });
});

describe('CryptoKey property descriptors', () => {
  it('CryptoKey should be writable, non-enumerable, configurable on globalThis', async () => {
    const desc = await evalJSON(`Object.getOwnPropertyDescriptor(globalThis, 'CryptoKey')`);
    expect(desc.writable).toBe(true);
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(true);
  });

  it('CryptoKey.prototype should be non-writable, non-enumerable, non-configurable', async () => {
    const desc = await evalJSON(`(() => {
      const d = Object.getOwnPropertyDescriptor(CryptoKey, 'prototype');
      return { writable: d.writable, enumerable: d.enumerable, configurable: d.configurable };
    })()`);
    expect(desc.writable).toBe(false);
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(false);
  });

  it('new CryptoKey() should throw TypeError', async () => {
    expect(await evalStr('(() => { try { new CryptoKey(); return "no error"; } catch(e) { return e.constructor.name + ": " + e.message; } })()')).toBe('TypeError: Illegal constructor');
  });
});

describe('crypto global', () => {
  it('should define crypto on globalThis', async () => {
    expect(await evalStr('typeof crypto')).toBe('object');
  });

  it('should have getRandomValues as a function', async () => {
    expect(await evalStr('typeof crypto.getRandomValues')).toBe('function');
  });

  it('should have randomUUID as a function', async () => {
    expect(await evalStr('typeof crypto.randomUUID')).toBe('function');
  });

  it('should have subtle as an object', async () => {
    expect(await evalStr('typeof crypto.subtle')).toBe('object');
  });

  it('should have Symbol.toStringTag = "Crypto"', async () => {
    expect(await evalStr('Object.prototype.toString.call(crypto)')).toBe('[object Crypto]');
  });

  it('should have SubtleCrypto with correct toStringTag', async () => {
    expect(await evalStr('Object.prototype.toString.call(crypto.subtle)')).toBe('[object SubtleCrypto]');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// crypto.getRandomValues()
// WPT: WebCryptoAPI/getRandomValues.any.js
// ═══════════════════════════════════════════════════════════════════════════════

describe('crypto.getRandomValues()', () => {
  it('should fill a Uint8Array with random bytes', async () => {
    const result = await evalJSON(`(() => {
      const arr = new Uint8Array(16);
      const returned = crypto.getRandomValues(arr);
      return {
        isSame: returned === arr,
        length: arr.length,
        hasNonZero: arr.some(b => b !== 0),
      };
    })()`);
    expect(result.isSame).toBe(true);
    expect(result.length).toBe(16);
    // All 16 random bytes being zero has probability 2^-128
    expect(result.hasNonZero).toBe(true);
  });

  it('should fill Uint16Array', async () => {
    const result = await evalJSON(`(() => {
      const arr = new Uint16Array(8);
      crypto.getRandomValues(arr);
      return { length: arr.length, hasNonZero: arr.some(v => v !== 0) };
    })()`);
    expect(result.length).toBe(8);
    expect(result.hasNonZero).toBe(true);
  });

  it('should fill Uint32Array', async () => {
    const result = await evalJSON(`(() => {
      const arr = new Uint32Array(4);
      crypto.getRandomValues(arr);
      return { length: arr.length, hasNonZero: arr.some(v => v !== 0) };
    })()`);
    expect(result.length).toBe(4);
    expect(result.hasNonZero).toBe(true);
  });

  it('should fill Int8Array', async () => {
    expect(await evalStr(`(() => {
      const arr = new Int8Array(16);
      crypto.getRandomValues(arr);
      return arr.some(v => v !== 0) ? 'ok' : 'fail';
    })()`)).toBe('ok');
  });

  it('should fill Int32Array', async () => {
    expect(await evalStr(`(() => {
      const arr = new Int32Array(4);
      crypto.getRandomValues(arr);
      return arr.some(v => v !== 0) ? 'ok' : 'fail';
    })()`)).toBe('ok');
  });

  it('should return the same array instance', async () => {
    expect(await evalStr(`(() => {
      const arr = new Uint8Array(8);
      return crypto.getRandomValues(arr) === arr ? 'ok' : 'fail';
    })()`)).toBe('ok');
  });

  it('should work with zero-length array', async () => {
    expect(await evalStr(`(() => {
      const arr = new Uint8Array(0);
      crypto.getRandomValues(arr);
      return arr.length === 0 ? 'ok' : 'fail';
    })()`)).toBe('ok');
  });

  it('should throw for arrays exceeding 65536 bytes (WPT)', async () => {
    using vm = await createVM();
    expect(() => {
      vm.evalCode('crypto.getRandomValues(new Uint8Array(65537))');
    }).toThrow();
  });

  it('should accept exactly 65536 bytes', async () => {
    expect(await evalStr(`(() => {
      const arr = new Uint8Array(65536);
      crypto.getRandomValues(arr);
      return 'ok';
    })()`)).toBe('ok');
  });

  it('should produce different values on successive calls', async () => {
    expect(await evalStr(`(() => {
      const a = new Uint8Array(32);
      const b = new Uint8Array(32);
      crypto.getRandomValues(a);
      crypto.getRandomValues(b);
      let same = true;
      for (let i = 0; i < 32; i++) if (a[i] !== b[i]) { same = false; break; }
      return same ? 'fail' : 'ok';
    })()`)).toBe('ok');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WASI overrides: custom random_get flows to crypto extension
// ═══════════════════════════════════════════════════════════════════════════════

describe('WASI overrides', () => {
  it('custom random_get flows to crypto.getRandomValues', async () => {
    // Create a VM where random_get always fills with 0xAB
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      wasi: (memory) => ({
        random_get(bufPtr: number, bufLen: number): number {
          new Uint8Array(memory.buffer, bufPtr, bufLen).fill(0xAB);
          return 0;
        },
      }),
      extensions: [
        { name: 'crypto', wasm: cryptoExtBytes },
      ],
    });

    // getRandomValues should produce all 0xAB bytes
    const result = vm.evalCode(`
      (() => {
        const arr = new Uint8Array(16);
        crypto.getRandomValues(arr);
        return arr.every(b => b === 0xAB) ? 'ok' : 'fail: ' + Array.from(arr).join(',');
      })()
    `);
    const str = result.toString();
    result.dispose();
    expect(str).toBe('ok');
  });

  it('custom random_get produces deterministic randomUUID', async () => {
    // Fill with a known repeatable sequence
    let counter = 0;
    const makeVm = () => QuickJS.create({
      wasm: wasmBytes,
      wasi: (memory) => ({
        random_get(bufPtr: number, bufLen: number): number {
          const bytes = new Uint8Array(memory.buffer, bufPtr, bufLen);
          for (let i = 0; i < bufLen; i++) bytes[i] = (counter++) & 0xFF;
          return 0;
        },
      }),
      extensions: [
        { name: 'crypto', wasm: cryptoExtBytes },
      ],
    });

    // Two VMs with the same deterministic RNG should produce the same UUID
    counter = 0;
    using vm1 = await makeVm();
    const uuid1 = vm1.evalCode('crypto.randomUUID()').consume(h => h.toString());

    counter = 0;
    using vm2 = await makeVm();
    const uuid2 = vm2.evalCode('crypto.randomUUID()').consume(h => h.toString());

    expect(uuid1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuid1).toBe(uuid2);
  });

  it('custom random_get flows through to SubtleCrypto digest (PSA init)', async () => {
    // Verify that a VM with custom random_get still has working crypto.subtle
    // (PSA crypto init internally may use random_get)
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      wasi: (memory) => ({
        random_get(bufPtr: number, bufLen: number): number {
          const bytes = new Uint8Array(memory.buffer, bufPtr, bufLen);
          if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            crypto.getRandomValues(bytes);
          } else {
            for (let i = 0; i < bufLen; i++) bytes[i] = Math.floor(Math.random() * 256);
          }
          return 0;
        },
      }),
      extensions: [
        { name: 'encoding', wasm: encodingExtBytes },
        { name: 'crypto', wasm: cryptoExtBytes },
      ],
    });

    // SHA-256("abc") should still produce the correct hash
    vm.evalCode(`
      globalThis.__testResult__ = undefined;
      (async () => {
        const data = new TextEncoder().encode('abc');
        const buf = await crypto.subtle.digest('SHA-256', data);
        globalThis.__testResult__ = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      })();
    `).dispose();
    vm.executePendingJobs();
    const result = vm.evalCode('globalThis.__testResult__');
    const hash = result.toString();
    result.dispose();
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// crypto.randomUUID()
// WPT: WebCryptoAPI/randomUUID.any.js
// ═══════════════════════════════════════════════════════════════════════════════

describe('crypto.randomUUID()', () => {
  it('should return a string', async () => {
    expect(await evalStr('typeof crypto.randomUUID()')).toBe('string');
  });

  it('should return a 36-character string', async () => {
    expect(await evalStr('crypto.randomUUID().length')).toBe('36');
  });

  it('should match the v4 UUID format', async () => {
    expect(await evalStr(`(() => {
      const uuid = crypto.randomUUID();
      const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      return re.test(uuid) ? 'ok' : 'fail: ' + uuid;
    })()`)).toBe('ok');
  });

  it('should produce unique UUIDs on successive calls', async () => {
    expect(await evalStr(`(() => {
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      return a !== b ? 'ok' : 'fail';
    })()`)).toBe('ok');
  });

  it('should set version nibble to 4', async () => {
    expect(await evalStr(`(() => {
      const uuid = crypto.randomUUID();
      return uuid[14] === '4' ? 'ok' : 'fail: ' + uuid[14];
    })()`)).toBe('ok');
  });

  it('should set variant bits correctly (8, 9, a, or b)', async () => {
    expect(await evalStr(`(() => {
      const uuid = crypto.randomUUID();
      return '89ab'.includes(uuid[19]) ? 'ok' : 'fail: ' + uuid[19];
    })()`)).toBe('ok');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SubtleCrypto interface methods
// ═══════════════════════════════════════════════════════════════════════════════

describe('SubtleCrypto methods existence', () => {
  const methods = [
    'digest', 'generateKey', 'importKey', 'exportKey',
    'sign', 'verify', 'encrypt', 'decrypt',
    'deriveBits', 'deriveKey', 'wrapKey', 'unwrapKey',
  ];

  for (const m of methods) {
    it(`should have ${m}() as a function`, async () => {
      expect(await evalStr(`typeof crypto.subtle.${m}`)).toBe('function');
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SubtleCrypto.digest()
// WPT: WebCryptoAPI/digest/digest.https.any.js
// ═══════════════════════════════════════════════════════════════════════════════

describe('SubtleCrypto.digest()', () => {
  // Known SHA-256 test vector: SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  it('should compute SHA-256 of empty input', async () => {
    expect(await evalStr(`(async () => {
      const buf = await crypto.subtle.digest('SHA-256', new Uint8Array(0));
      const arr = new Uint8Array(buf);
      return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
    })()`)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
  it('should compute SHA-256 of "abc"', async () => {
    expect(await evalStr(`(async () => {
      const data = new TextEncoder().encode('abc');
      const buf = await crypto.subtle.digest('SHA-256', data);
      const arr = new Uint8Array(buf);
      return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
    })()`)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  // SHA-1("abc") = a9993e364706816aba3e25717850c26c9cd0d89d
  it('should compute SHA-1 of "abc"', async () => {
    expect(await evalStr(`(async () => {
      const data = new TextEncoder().encode('abc');
      const buf = await crypto.subtle.digest('SHA-1', data);
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    })()`)).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  // SHA-384("abc")
  it('should compute SHA-384 of "abc"', async () => {
    expect(await evalStr(`(async () => {
      const data = new TextEncoder().encode('abc');
      const buf = await crypto.subtle.digest('SHA-384', data);
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    })()`)).toBe('cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7');
  });

  // SHA-512("abc")
  it('should compute SHA-512 of "abc"', async () => {
    expect(await evalStr(`(async () => {
      const data = new TextEncoder().encode('abc');
      const buf = await crypto.subtle.digest('SHA-512', data);
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    })()`)).toBe('ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');
  });

  it('should return an ArrayBuffer', async () => {
    expect(await evalStr(`(async () => {
      const buf = await crypto.subtle.digest('SHA-256', new Uint8Array(0));
      return buf instanceof ArrayBuffer ? 'ok' : 'fail';
    })()`)).toBe('ok');
  });

  it('should accept algorithm as {name: "SHA-256"} object', async () => {
    expect(await evalStr(`(async () => {
      const buf = await crypto.subtle.digest({name: 'SHA-256'}, new Uint8Array(0));
      return new Uint8Array(buf).length === 32 ? 'ok' : 'fail';
    })()`)).toBe('ok');
  });

  it('should reject for unsupported algorithm', async () => {
    expect(await evalStr(`(async () => {
      try {
        await crypto.subtle.digest('MD5', new Uint8Array(0));
        return 'no error';
      } catch(e) { return 'error'; }
    })()`)).toBe('error');
  });

  it('should return correct hash length for each algorithm', async () => {
    const result = await evalJSON(`(async () => {
      const lens = {};
      for (const alg of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']) {
        const buf = await crypto.subtle.digest(alg, new Uint8Array(0));
        lens[alg] = new Uint8Array(buf).length;
      }
      return lens;
    })()`);
    expect(result['SHA-1']).toBe(20);
    expect(result['SHA-256']).toBe(32);
    expect(result['SHA-384']).toBe(48);
    expect(result['SHA-512']).toBe(64);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SubtleCrypto.generateKey(): HMAC
// WPT: WebCryptoAPI/generateKey/successes_HMAC.https.any.js
// ═══════════════════════════════════════════════════════════════════════════════

describe('SubtleCrypto.generateKey() - HMAC', () => {
  it('should generate an HMAC key with SHA-256', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' }, true, ['sign', 'verify']
      );
      return key.type;
    })()`)).toBe('secret');
  });

  it('should set algorithm.name = "HMAC"', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' }, true, ['sign', 'verify']
      );
      return key.algorithm.name;
    })()`)).toBe('HMAC');
  });

  it('should have correct extractable and usages', async () => {
    const result = await evalJSON(`(async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' }, true, ['sign', 'verify']
      );
      return { extractable: key.extractable, usages: key.usages };
    })()`);
    expect(result.extractable).toBe(true);
    expect(result.usages).toContain('sign');
    expect(result.usages).toContain('verify');
  });

  it('should be exportable as raw', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' }, true, ['sign', 'verify']
      );
      const raw = await crypto.subtle.exportKey('raw', key);
      return raw.byteLength > 0 ? 'ok' : 'fail';
    })()`)).toBe('ok');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SubtleCrypto.generateKey(): AES
// WPT: WebCryptoAPI/generateKey/successes_AES-GCM.https.any.js
// ═══════════════════════════════════════════════════════════════════════════════

describe('SubtleCrypto.generateKey() - AES', () => {
  for (const bits of [128, 256]) {
    it(`should generate an AES-GCM ${bits}-bit key`, async () => {
      expect(await evalStr(`(async () => {
        const key = await crypto.subtle.generateKey(
          { name: 'AES-GCM', length: ${bits} }, true, ['encrypt', 'decrypt']
        );
        return key.type + '/' + key.algorithm.length;
      })()`)).toBe(`secret/${bits}`);
    });
  }

  for (const alg of ['AES-CBC', 'AES-CTR', 'AES-GCM']) {
    it(`should generate ${alg} key`, async () => {
      expect(await evalStr(`(async () => {
        const key = await crypto.subtle.generateKey(
          { name: '${alg}', length: 256 }, true, ['encrypt', 'decrypt']
        );
        return key.algorithm.name;
      })()`)).toBe(alg);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SubtleCrypto.generateKey(): ECDSA key pair
// WPT: WebCryptoAPI/generateKey/successes_ECDSA.https.any.js
// ═══════════════════════════════════════════════════════════════════════════════

describe('SubtleCrypto.generateKey() - ECDSA', () => {
  it('should return a CryptoKeyPair for ECDSA P-256', async () => {
    const result = await evalJSON(`(async () => {
      const pair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
      );
      return {
        hasPrivate: !!pair.privateKey,
        hasPublic: !!pair.publicKey,
        privType: pair.privateKey.type,
        pubType: pair.publicKey.type,
        privAlg: pair.privateKey.algorithm.name,
        pubAlg: pair.publicKey.algorithm.name,
        curve: pair.privateKey.algorithm.namedCurve,
      };
    })()`);
    expect(result.hasPrivate).toBe(true);
    expect(result.hasPublic).toBe(true);
    expect(result.privType).toBe('private');
    expect(result.pubType).toBe('public');
    expect(result.privAlg).toBe('ECDSA');
    expect(result.pubAlg).toBe('ECDSA');
    expect(result.curve).toBe('P-256');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SubtleCrypto.sign() / verify(): HMAC
// WPT: WebCryptoAPI/sign_verify/hmac.https.any.js
// ═══════════════════════════════════════════════════════════════════════════════

describe('SubtleCrypto.sign() / verify() - HMAC', () => {
  it('should sign and verify with HMAC-SHA-256', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
      );
      const data = new TextEncoder().encode('test message');
      const sig = await crypto.subtle.sign('HMAC', key, data);
      const valid = await crypto.subtle.verify('HMAC', key, sig, data);
      return valid ? 'ok' : 'fail';
    })()`)).toBe('ok');
  });

  it('should fail verification with tampered data', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
      );
      const data = new TextEncoder().encode('original');
      const sig = await crypto.subtle.sign('HMAC', key, data);
      const tampered = new TextEncoder().encode('tampered');
      const valid = await crypto.subtle.verify('HMAC', key, sig, tampered);
      return valid ? 'fail' : 'ok';
    })()`)).toBe('ok');
  });

  it('HMAC signature should be 32 bytes for SHA-256', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
      );
      const sig = await crypto.subtle.sign('HMAC', key, new Uint8Array(10));
      return new Uint8Array(sig).length.toString();
    })()`)).toBe('32');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SubtleCrypto.sign() / verify(): ECDSA
// WPT: WebCryptoAPI/sign_verify/ecdsa.https.any.js
// ═══════════════════════════════════════════════════════════════════════════════

describe('SubtleCrypto.sign() / verify() - ECDSA', () => {
  it('should sign and verify with ECDSA P-256 SHA-256', async () => {
    expect(await evalStr(`(async () => {
      const pair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']
      );
      const data = new TextEncoder().encode('hello ECDSA');
      const sig = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data
      );
      const valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, sig, data
      );
      return valid ? 'ok' : 'fail';
    })()`)).toBe('ok');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SubtleCrypto.encrypt() / decrypt(): AES-GCM
// WPT: WebCryptoAPI/encrypt_decrypt/aes_gcm.https.any.js
// ═══════════════════════════════════════════════════════════════════════════════

describe('SubtleCrypto.encrypt() / decrypt() - AES-GCM', () => {
  it('should encrypt and decrypt with AES-GCM-256', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = new TextEncoder().encode('secret message');
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      const decoded = new TextDecoder().decode(pt);
      return decoded;
    })()`)).toBe('secret message');
  });

  it('ciphertext should be longer than plaintext (tag appended)', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );
      const iv = new Uint8Array(12);
      const data = new Uint8Array(16);
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
      return ct.byteLength > data.byteLength ? 'ok' : 'fail';
    })()`)).toBe('ok');
  });

  it('should reject decryption with wrong IV', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );
      const iv1 = crypto.getRandomValues(new Uint8Array(12));
      const iv2 = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv1 }, key, new Uint8Array(8));
      try {
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv2 }, key, ct);
        return 'no error';
      } catch(e) { return 'error'; }
    })()`)).toBe('error');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SubtleCrypto.encrypt() / decrypt(): AES-CBC
// WPT: WebCryptoAPI/encrypt_decrypt/aes_cbc.https.any.js
// ═══════════════════════════════════════════════════════════════════════════════

describe('SubtleCrypto.encrypt() / decrypt() - AES-CBC', () => {
  it('should encrypt and decrypt with AES-CBC-256', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'AES-CBC', length: 256 }, false, ['encrypt', 'decrypt']
      );
      const iv = crypto.getRandomValues(new Uint8Array(16));
      const data = new TextEncoder().encode('AES-CBC test');
      const ct = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, data);
      const pt = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ct);
      return new TextDecoder().decode(pt);
    })()`)).toBe('AES-CBC test');
  });

  it('AES-CBC ciphertext should be block-aligned (PKCS7)', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'AES-CBC', length: 256 }, false, ['encrypt', 'decrypt']
      );
      const iv = new Uint8Array(16);
      const data = new Uint8Array(10); // 10 bytes -> padded to 16
      const ct = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, data);
      return (ct.byteLength % 16 === 0) ? 'ok' : 'fail: ' + ct.byteLength;
    })()`)).toBe('ok');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SubtleCrypto.encrypt() / decrypt(): AES-CTR
// WPT: WebCryptoAPI/encrypt_decrypt/aes_ctr.https.any.js
// ═══════════════════════════════════════════════════════════════════════════════

describe('SubtleCrypto.encrypt() / decrypt() - AES-CTR', () => {
  it('should encrypt and decrypt with AES-CTR-256', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'AES-CTR', length: 256 }, false, ['encrypt', 'decrypt']
      );
      const counter = crypto.getRandomValues(new Uint8Array(16));
      const data = new TextEncoder().encode('AES-CTR test');
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-CTR', counter, length: 64 }, key, data
      );
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-CTR', counter, length: 64 }, key, ct
      );
      return new TextDecoder().decode(pt);
    })()`)).toBe('AES-CTR test');
  });

  it('AES-CTR ciphertext length equals plaintext length (stream cipher)', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'AES-CTR', length: 256 }, false, ['encrypt', 'decrypt']
      );
      const counter = new Uint8Array(16);
      const data = new Uint8Array(13); // arbitrary non-block-aligned length
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-CTR', counter, length: 64 }, key, data
      );
      return ct.byteLength === 13 ? 'ok' : 'fail: ' + ct.byteLength;
    })()`)).toBe('ok');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SubtleCrypto.importKey() / exportKey(): raw AES round-trip
// WPT: WebCryptoAPI/import_export/symmetric_importKey.https.any.js
// ═══════════════════════════════════════════════════════════════════════════════

describe('SubtleCrypto.importKey() / exportKey() - AES raw', () => {
  it('should import and re-export a raw AES-GCM key', async () => {
    expect(await evalStr(`(async () => {
      const rawKey = crypto.getRandomValues(new Uint8Array(32));
      const key = await crypto.subtle.importKey(
        'raw', rawKey, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']
      );
      const exported = new Uint8Array(await crypto.subtle.exportKey('raw', key));
      let same = rawKey.length === exported.length;
      for (let i = 0; same && i < rawKey.length; i++) same = rawKey[i] === exported[i];
      return same ? 'ok' : 'fail';
    })()`)).toBe('ok');
  });

  it('should reject export of non-extractable key', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 }, false, ['encrypt']
      );
      try {
        await crypto.subtle.exportKey('raw', key);
        return 'no error';
      } catch(e) { return 'error'; }
    })()`)).toBe('error');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SubtleCrypto.importKey() / exportKey(): HMAC raw round-trip
// ═══════════════════════════════════════════════════════════════════════════════

describe('SubtleCrypto.importKey() / exportKey() - HMAC raw', () => {
  it('should import and sign with raw HMAC key', async () => {
    expect(await evalStr(`(async () => {
      const rawKey = crypto.getRandomValues(new Uint8Array(32));
      const key = await crypto.subtle.importKey(
        'raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      );
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('test'));
      return new Uint8Array(sig).length === 32 ? 'ok' : 'fail';
    })()`)).toBe('ok');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SubtleCrypto.deriveBits() / deriveKey(): HKDF
// WPT: WebCryptoAPI/derive_bits_keys/hkdf.https.any.js
// ═══════════════════════════════════════════════════════════════════════════════

describe('SubtleCrypto.deriveBits() - HKDF', () => {
  it('should derive 256 bits with HKDF-SHA-256', async () => {
    expect(await evalStr(`(async () => {
      const ikm = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode('input keying material'),
        { name: 'HKDF' }, false, ['deriveBits']
      );
      const bits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(16), info: new Uint8Array(0) },
        ikm, 256
      );
      return new Uint8Array(bits).length === 32 ? 'ok' : 'fail';
    })()`)).toBe('ok');
  });

  it('should produce deterministic output for same inputs', async () => {
    expect(await evalStr(`(async () => {
      const rawIkm = new TextEncoder().encode('deterministic');
      const salt = new TextEncoder().encode('salt');
      const info = new TextEncoder().encode('info');
      async function derive() {
        const ikm = await crypto.subtle.importKey('raw', rawIkm, {name:'HKDF'}, false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits({name:'HKDF', hash:'SHA-256', salt, info}, ikm, 256);
        return Array.from(new Uint8Array(bits)).join(',');
      }
      const a = await derive();
      const b = await derive();
      return a === b ? 'ok' : 'fail';
    })()`)).toBe('ok');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SubtleCrypto.deriveKey(): PBKDF2
// WPT: WebCryptoAPI/derive_bits_keys/pbkdf2.https.any.js
// ═══════════════════════════════════════════════════════════════════════════════

describe('SubtleCrypto.deriveKey() - PBKDF2', () => {
  it('should derive an AES-GCM key from a password via PBKDF2', async () => {
    expect(await evalStr(`(async () => {
      const password = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode('password123'),
        { name: 'PBKDF2' }, false, ['deriveKey']
      );
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(16), iterations: 1000 },
        password,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );
      return key.type + '/' + key.algorithm.name + '/' + key.algorithm.length;
    })()`)).toBe('secret/AES-GCM/256');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CryptoKey properties
// WPT: WebCryptoAPI/cryptokey.any.js
// ═══════════════════════════════════════════════════════════════════════════════

describe('CryptoKey properties', () => {
  it('CryptoKey.type should be "secret" for symmetric keys', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 }, true, ['encrypt']
      );
      return key.type;
    })()`)).toBe('secret');
  });

  it('CryptoKey.extractable should reflect the value passed to generateKey', async () => {
    const result = await evalJSON(`(async () => {
      const k1 = await crypto.subtle.generateKey({name:'AES-GCM',length:256}, true, ['encrypt']);
      const k2 = await crypto.subtle.generateKey({name:'AES-GCM',length:256}, false, ['encrypt']);
      return { k1: k1.extractable, k2: k2.extractable };
    })()`);
    expect(result.k1).toBe(true);
    expect(result.k2).toBe(false);
  });

  it('CryptoKey.algorithm should be a frozen object', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256}, true, ['encrypt']);
      const alg = key.algorithm;
      try { alg.name = 'CHANGED'; } catch(e) {}
      return alg.name;
    })()`)).toBe('AES-GCM');
  });

  it('CryptoKey.usages should be a frozen array', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256}, true, ['encrypt','decrypt']);
      const u = key.usages;
      try { u.push('sign'); } catch(e) {}
      return u.length.toString();
    })()`)).toBe('2');
  });

  it('CryptoKey should have Symbol.toStringTag = "CryptoKey"', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256}, true, ['encrypt']);
      return Object.prototype.toString.call(key);
    })()`)).toBe('[object CryptoKey]');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Full encrypt/decrypt round-trip with imported key (WPT-style)
// ═══════════════════════════════════════════════════════════════════════════════

describe('WPT-style encrypt/decrypt round-trips', () => {
  it('AES-GCM with additionalData', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256}, false, ['encrypt','decrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ad = new TextEncoder().encode('associated data');
      const pt = new TextEncoder().encode('plaintext');
      const ct = await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData: ad}, key, pt);
      const dec = await crypto.subtle.decrypt({name:'AES-GCM', iv, additionalData: ad}, key, ct);
      return new TextDecoder().decode(dec);
    })()`)).toBe('plaintext');
  });

  it('AES-GCM should fail with wrong additionalData on decrypt', async () => {
    expect(await evalStr(`(async () => {
      const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256}, false, ['encrypt','decrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData: new Uint8Array([1])}, key, new Uint8Array(5));
      try {
        await crypto.subtle.decrypt({name:'AES-GCM', iv, additionalData: new Uint8Array([2])}, key, ct);
        return 'no error';
      } catch(e) { return 'error'; }
    })()`)).toBe('error');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SubtleCrypto.wrapKey() / unwrapKey()
// WPT: WebCryptoAPI/wrapKey_unwrapKey/wrapKey_unwrapKey.https.any.js
// ═══════════════════════════════════════════════════════════════════════════════

describe('SubtleCrypto.wrapKey() / unwrapKey()', () => {
  it('should wrap and unwrap an AES key with AES-GCM', async () => {
    expect(await evalStr(`(async () => {
      // Key to wrap
      const innerKey = await crypto.subtle.generateKey(
        {name:'AES-GCM', length:128}, true, ['encrypt','decrypt']
      );
      // Wrapping key
      const wrapKey = await crypto.subtle.generateKey(
        {name:'AES-GCM', length:256}, false, ['wrapKey','unwrapKey']
      );
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const wrapped = await crypto.subtle.wrapKey('raw', innerKey, wrapKey, {name:'AES-GCM', iv});
      const unwrapped = await crypto.subtle.unwrapKey(
        'raw', wrapped, wrapKey, {name:'AES-GCM', iv},
        {name:'AES-GCM'}, true, ['encrypt','decrypt']
      );
      // Verify the unwrapped key works
      const testIv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({name:'AES-GCM', iv:testIv}, unwrapped, new Uint8Array(8));
      const pt = await crypto.subtle.decrypt({name:'AES-GCM', iv:testIv}, unwrapped, ct);
      return pt.byteLength === 8 ? 'ok' : 'fail';
    })()`)).toBe('ok');
  });
});
