/**
 * Proof-of-concept: host-side devalue serialization of guest values.
 *
 * Each round trip is:
 *
 *   guest value ──stringify(handle ops)──▶ wire string
 *                            │
 *                            ├─ compared against devalue.stringify of the
 *                            │  equivalent *host* value (wire-format parity)
 *                            │
 *                            └──parse(handle ops)──▶ new guest value
 *                                                          │
 *                                    compared to the original *inside the VM*
 *
 * The serializer never runs in the VM, and the revived value is a real guest
 * value the VM can use directly.
 */

import { describe, expect, it } from 'vitest';
import { parse, stringify, stringifyAsync } from 'devalue';
import { QuickJS, type JSValueHandle } from '../src/index.ts';
import { createDevalueOperations } from './devalue-operations.ts';
import { wasmBytes } from './helpers.ts';

/** Structural comparison, evaluated inside the VM. */
const DEEP_EQUAL = `(function deepEqual(a, b, seen) {
  seen = seen || new Map();
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    // distinguishes NaN (equal to itself here) and -0 from +0
    return Object.is(a, b);
  }
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;

  if (seen.get(a) === b) return true;
  seen.set(a, b);

  const tag = Object.prototype.toString.call(a);
  if (tag !== Object.prototype.toString.call(b)) return false;

  switch (tag) {
    case '[object Date]':
      return Object.is(a.getTime(), b.getTime());
    case '[object RegExp]':
      return a.source === b.source && a.flags === b.flags;
    case '[object Number]':
    case '[object String]':
    case '[object Boolean]':
    case '[object BigInt]':
      return Object.is(a.valueOf(), b.valueOf());
    case '[object Set]': {
      if (a.size !== b.size) return false;
      const left = [...a], right = [...b];
      return left.every((value, index) => deepEqual(value, right[index], seen));
    }
    case '[object Map]': {
      if (a.size !== b.size) return false;
      const left = [...a], right = [...b];
      return left.every(
        ([k, v], index) =>
          deepEqual(k, right[index][0], seen) && deepEqual(v, right[index][1], seen)
      );
    }
    case '[object ArrayBuffer]': {
      const left = new Uint8Array(a), right = new Uint8Array(b);
      return left.length === right.length && left.every((byte, index) => byte === right[index]);
    }
    case '[object Array]': {
      if (a.length !== b.length) return false;
      // compare holes as holes, not as undefined
      const keysA = Object.keys(a), keysB = Object.keys(b);
      if (keysA.length !== keysB.length) return false;
      return keysA.every(
        (key, index) => key === keysB[index] && deepEqual(a[key], b[key], seen)
      );
    }
  }

  if (ArrayBuffer.isView(a)) {
    if (a.byteLength !== b.byteLength || a.byteOffset !== b.byteOffset) return false;
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return left.every((byte, index) => byte === right[index]);
  }

  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

  const keysA = Object.keys(a), keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => keysB.includes(key) && deepEqual(a[key], b[key], seen));
})`;

interface Harness {
  vm: QuickJS;
  /** Serialize a guest value, host-side, without running guest code. */
  serialize(handle: JSValueHandle): string;
  /** Revive a wire string into a new guest value. */
  revive(serialized: string): JSValueHandle;
  /** Ask the VM whether two guest values are structurally equal. */
  equalInVm(a: JSValueHandle, b: JSValueHandle): boolean;
  serializeOperations: ReturnType<typeof createDevalueOperations>['stringifyOperations'];
  reviveOperations: ReturnType<typeof createDevalueOperations>['parseOperations'];
  dispose(): void;
}

async function createHarness(): Promise<Harness> {
  const vm = await QuickJS.create(wasmBytes);
  // captured before any user code runs
  const ops = createDevalueOperations(vm);
  const deepEqual = vm.evalCode(DEEP_EQUAL);

  return {
    vm,
    serialize: (handle) =>
      stringify(handle, undefined, { operations: ops.stringifyOperations }),
    revive: (serialized) =>
      parse(serialized, undefined, { operations: ops.parseOperations }),
    equalInVm: (a, b) =>
      vm.callFunction(deepEqual, vm.undefined, a, b).consume((h) => h.toBoolean()),
    serializeOperations: ops.stringifyOperations,
    reviveOperations: ops.parseOperations,
    dispose() {
      deepEqual.dispose();
      ops.dispose();
      vm.dispose();
    },
  };
}

/**
 * Full round trip for a value constructed by `expression` inside the VM.
 * Asserts wire-format parity against the host equivalent (when given) and
 * that the revived guest value matches the original, as judged by the VM.
 */
async function assertRoundTrip(expression: string, hostEquivalent?: unknown) {
  const harness = await createHarness();
  try {
    using original = harness.vm.evalCode(`(${expression})`);

    const serialized = harness.serialize(original);

    if (arguments.length > 1) {
      expect(serialized, 'wire format should match host devalue').toBe(
        stringify(hostEquivalent)
      );
    }

    using revived = harness.revive(serialized);
    expect(
      harness.equalInVm(original, revived),
      `VM should consider the revived value equal to the original (${serialized})`
    ).toBe(true);

    // the revived value must also survive a second trip unchanged
    expect(harness.serialize(revived)).toBe(serialized);

    return { harness, serialized };
  } finally {
    harness.dispose();
  }
}

describe('host-side devalue: primitives', () => {
  it.each([
    ['42', 42],
    ['-0', -0],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['"hello"', 'hello'],
    ['true', true],
    ['false', false],
    ['null', null],
    ['undefined', undefined],
    ['123n', 123n],
    ['-7n', -7n],
  ])('round-trips %s', async (expression, hostEquivalent) => {
    await assertRoundTrip(expression, hostEquivalent);
  });
});

describe('host-side devalue: objects and containers', () => {
  it.each([
    ['({ a: 1, b: "two", c: true })', { a: 1, b: 'two', c: true }],
    ['({ nested: { deep: { value: 42 } } })', { nested: { deep: { value: 42 } } }],
    ['[1, "two", { three: 3 }]', [1, 'two', { three: 3 }]],
    ['[]', []],
    ['({})', {}],
    ['new Map([["k", { v: 1 }], [2, "two"]])', new Map<any, any>([['k', { v: 1 }], [2, 'two']])],
    ['new Set([1, "two", 3])', new Set([1, 'two', 3])],
    ['new Map()', new Map()],
    ['new Set()', new Set()],
  ])('round-trips %s', async (expression, hostEquivalent) => {
    await assertRoundTrip(expression, hostEquivalent);
  });

  it('round-trips a null-prototype object', async () => {
    await assertRoundTrip(
      'Object.assign(Object.create(null), { x: 1, y: 2 })',
      Object.assign(Object.create(null), { x: 1, y: 2 })
    );
  });

  it('round-trips sparse arrays', async () => {
    // eslint-disable-next-line no-sparse-arrays
    await assertRoundTrip('[1, , 3]', [1, , 3]);
  });

  it('round-trips a very sparse array without allocating', async () => {
    const harness = await createHarness();
    try {
      using original = harness.vm.evalCode('(() => { const a = []; a[5_000_000] = "x"; return a; })()');

      const serialized = harness.serialize(original);
      expect(serialized).toContain('-7'); // sparse encoding

      using revived = harness.revive(serialized);
      expect(harness.equalInVm(original, revived)).toBe(true);

      // and the VM sees the right shape
      harness.vm.setProp(harness.vm.global, 'revived', revived);
      using check = harness.vm.evalCode(
        'revived.length === 5_000_001 && revived[5_000_000] === "x" && Object.keys(revived).length === 1'
      );
      expect(check.toBoolean()).toBe(true);
    } finally {
      harness.dispose();
    }
  });
});

describe('host-side devalue: built-in types', () => {
  it.each([
    ['new Date(1700000000000)', new Date(1700000000000)],
    ['new Date(NaN)', new Date(NaN)],
    ['/ab+c/gi', /ab+c/gi],
    ['/plain/', /plain/],
    ['new Number(42)', new Number(42)],
    ['new String("boxed")', new String('boxed')],
    ['new Boolean(true)', new Boolean(true)],
  ])('round-trips %s', async (expression, hostEquivalent) => {
    await assertRoundTrip(expression, hostEquivalent);
  });
});

describe('host-side devalue: binary data', () => {
  it.each([
    ['new Uint8Array([1, 2, 3, 255]).buffer', new Uint8Array([1, 2, 3, 255]).buffer],
    ['new Uint8Array([1, 2, 3, 255])', new Uint8Array([1, 2, 3, 255])],
    ['new Int16Array([-1, 0, 1])', new Int16Array([-1, 0, 1])],
    ['new Float64Array([1.5, -2.25])', new Float64Array([1.5, -2.25])],
    ['new BigInt64Array([1n, -2n])', new BigInt64Array([1n, -2n])],
  ])('round-trips %s', async (expression, hostEquivalent) => {
    await assertRoundTrip(expression, hostEquivalent);
  });

  it('round-trips typed-array subviews and DataView', async () => {
    const buffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    await assertRoundTrip(
      'new Uint8Array([1,2,3,4,5,6,7,8]).buffer && new Int16Array(new Uint8Array([1,2,3,4,5,6,7,8]).buffer, 2, 2)',
      new Int16Array(buffer, 2, 2)
    );
    await assertRoundTrip(
      'new DataView(new Uint8Array([1,2,3,4,5,6,7,8]).buffer, 1, 4)',
      new DataView(buffer, 1, 4)
    );
  });

  it('shares a buffer between two views after revival', async () => {
    const harness = await createHarness();
    try {
      using original = harness.vm.evalCode(`(() => {
        const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
        return { a: new Uint8Array(buffer), b: new Uint8Array(buffer) };
      })()`);

      using revived = harness.revive(harness.serialize(original));
      harness.vm.setProp(harness.vm.global, 'revived', revived);

      using check = harness.vm.evalCode(`(() => {
        revived.a[0] = 99;
        return revived.a.buffer === revived.b.buffer && revived.b[0] === 99;
      })()`);
      expect(check.toBoolean()).toBe(true);
    } finally {
      harness.dispose();
    }
  });
});

describe('host-side devalue: references and cycles', () => {
  it('preserves shared references as one guest object', async () => {
    const harness = await createHarness();
    try {
      using original = harness.vm.evalCode(
        '(() => { const shared = { x: 1 }; return { first: shared, second: shared }; })()'
      );

      // the host equivalent must share the reference too, otherwise devalue
      // (correctly) emits two entries rather than one back-reference
      const hostShared = { x: 1 };
      const serialized = harness.serialize(original);
      expect(serialized).toBe(stringify({ first: hostShared, second: hostShared }));

      using revived = harness.revive(serialized);
      harness.vm.setProp(harness.vm.global, 'revived', revived);

      using check = harness.vm.evalCode('revived.first === revived.second');
      expect(check.toBoolean()).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it('round-trips a cyclic value', async () => {
    const harness = await createHarness();
    try {
      using original = harness.vm.evalCode(
        '(() => { const o = { name: "cycle" }; o.self = o; o.list = [o]; return o; })()'
      );

      using revived = harness.revive(harness.serialize(original));
      expect(harness.equalInVm(original, revived)).toBe(true);

      harness.vm.setProp(harness.vm.global, 'revived', revived);
      using check = harness.vm.evalCode(
        'revived.self === revived && revived.list[0] === revived && revived.name === "cycle"'
      );
      expect(check.toBoolean()).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it('does not confuse an object identity with a guest number', async () => {
    // Object identities are pointers; if they leaked into the dedup map as
    // raw numbers, a guest number equal to a pointer would alias an object.
    const harness = await createHarness();
    try {
      using original = harness.vm.evalCode(`(() => {
        const shared = { tag: 'object' };
        return { shared, alias: shared, numbers: [1, 2, 3, 4096, 65536, 1048576] };
      })()`);

      using revived = harness.revive(harness.serialize(original));
      expect(harness.equalInVm(original, revived)).toBe(true);

      harness.vm.setProp(harness.vm.global, 'revived', revived);
      using check = harness.vm.evalCode(
        `revived.shared === revived.alias &&
         revived.numbers.every((n, index) => n === [1, 2, 3, 4096, 65536, 1048576][index])`
      );
      expect(check.toBoolean()).toBe(true);
    } finally {
      harness.dispose();
    }
  });
});

describe('host-side devalue: guest code is not executed', () => {
  it('ignores patched prototype methods while serializing', async () => {
    const harness = await createHarness();
    try {
      // Patch everything serialization would classically dispatch through,
      // *after* the intrinsics were captured.
      harness.vm
        .evalCode(`
          globalThis.sideEffects = 0;
          const count = (fn) => function (...args) {
            globalThis.sideEffects++;
            return fn.apply(this, args);
          };
          Date.prototype.toISOString = count(Date.prototype.toISOString);
          Date.prototype.getTime = count(Date.prototype.getTime);
          Map.prototype[Symbol.iterator] = count(Map.prototype[Symbol.iterator]);
          Set.prototype[Symbol.iterator] = count(Set.prototype[Symbol.iterator]);
          Map.prototype.forEach = count(Map.prototype.forEach);
          Object.defineProperty(Object.prototype, Symbol.toStringTag, {
            configurable: true,
            get: count(function () { return undefined; }),
          });
        `)
        .dispose();

      using value = harness.vm.evalCode(`({
        when: new Date(1700000000000),
        map: new Map([['k', 'v']]),
        set: new Set([1, 2]),
        list: [1, 2, 3],
      })`);

      const serialized = harness.serialize(value);
      expect(serialized).toBe(
        stringify({
          when: new Date(1700000000000),
          map: new Map([['k', 'v']]),
          set: new Set([1, 2]),
          list: [1, 2, 3],
        })
      );

      using count = harness.vm.evalCode('globalThis.sideEffects');
      expect(count.toNumber(), 'no patched guest code should have run').toBe(0);
    } finally {
      harness.dispose();
    }
  });

  it('is not fooled by a spoofed brand', async () => {
    const harness = await createHarness();
    try {
      // `Object.prototype.toString` — what devalue classifies with by default
      // — honours `Symbol.toStringTag`, so this object claims to be a Date.
      using spoofed = harness.vm.evalCode(
        'Object.defineProperty({ a: 1 }, Symbol.toStringTag, { value: "Date" })'
      );

      using tag = harness.vm.evalCode(
        'Object.prototype.toString.call(Object.defineProperty({ a: 1 }, Symbol.toStringTag, { value: "Date" }))'
      );
      expect(tag.toString()).toBe('[object Date]');

      // classification is by engine brand, so it serializes as what it is
      expect(harness.serialize(spoofed)).toBe(stringify({ a: 1 }));
    } finally {
      harness.dispose();
    }
  });

  it('rejects an object with enumerable symbol keys, without reading them', async () => {
    const harness = await createHarness();
    try {
      using value = harness.vm.evalCode('({ [Symbol("s")]: 1, ordinary: 2 })');
      expect(() => harness.serialize(value)).toThrow(/symbolic keys/);
    } finally {
      harness.dispose();
    }
  });

  it('refuses to invoke a getter rather than silently running guest code', async () => {
    const harness = await createHarness();
    try {
      using value = harness.vm.evalCode(`(() => {
        globalThis.getterRuns = 0;
        return { get computed() { globalThis.getterRuns++; return 1; } };
      })()`);

      expect(() => harness.serialize(value)).toThrow(/refusing to invoke getter/);

      using runs = harness.vm.evalCode('globalThis.getterRuns');
      expect(runs.toNumber()).toBe(0);
    } finally {
      harness.dispose();
    }
  });

  it('rejects a proxy instead of firing its traps', async () => {
    const harness = await createHarness();
    try {
      using proxy = harness.vm.evalCode(`(() => {
        globalThis.trapRuns = 0;
        const handler = new Proxy({}, { get() { globalThis.trapRuns++; return undefined; } });
        return { wrapped: new Proxy({ a: 1 }, handler) };
      })()`);

      expect(() => harness.serialize(proxy)).toThrow(/non-POJO/);

      using runs = harness.vm.evalCode('globalThis.trapRuns');
      expect(runs.toNumber()).toBe(0);
    } finally {
      harness.dispose();
    }
  });
});

describe('host-side devalue: reducers and revivers', () => {
  it('passes guest handles through reducers and revivers', async () => {
    const harness = await createHarness();
    try {
      harness.vm
        .evalCode('globalThis.Vector = class Vector { constructor(x, y) { this.x = x; this.y = y; } };')
        .dispose();

      using vector = harness.vm.evalCode('new Vector(30, 40)');
      using VectorClass = harness.vm.evalCode('Vector');

      using isVector = harness.vm.evalCode('(value, Class) => value instanceof Class');
      const serialized = stringify(
        vector,
        {
          Vector: (handle: JSValueHandle) => {
            const matches = harness.vm
              .callFunction(isVector, harness.vm.undefined, handle, VectorClass)
              .consume((h) => h.toBoolean());
            if (!matches) return false;
            // reduce to a guest array of the components
            return harness.vm.evalCode('(v) => [v.x, v.y]').consume((fn) =>
              harness.vm.callFunction(fn, harness.vm.undefined, handle)
            );
          },
        },
        { operations: harness.serializeOperations }
      );

      expect(serialized).toBe('[["Vector",1],[2,3],30,40]');

      using makeVector = harness.vm.evalCode('([x, y]) => new Vector(x, y)');
      using revived = parse(
        serialized,
        {
          Vector: (handle: JSValueHandle) =>
            harness.vm.callFunction(makeVector, harness.vm.undefined, handle),
        },
        { operations: harness.reviveOperations }
      );

      harness.vm.setProp(harness.vm.global, 'revived', revived);
      using check = harness.vm.evalCode(
        'revived instanceof Vector && revived.x === 30 && revived.y === 40'
      );
      expect(check.toBoolean()).toBe(true);
    } finally {
      harness.dispose();
    }
  });
});

describe('host-side devalue: async', () => {
  it('round-trips promises through stringifyAsync', async () => {
    const harness = await createHarness();
    try {
      using value = harness.vm.evalCode(
        '({ ready: Promise.resolve({ deep: Promise.resolve(42) }) })'
      );

      const pending = stringifyAsync(value, undefined, {
        operations: harness.serializeOperations,
      });
      // let the VM settle its promises
      harness.vm.executePendingJobs();
      await Promise.resolve();
      harness.vm.executePendingJobs();

      const serialized = await pending;
      expect(serialized).toBe(
        await stringifyAsync({ ready: Promise.resolve({ deep: Promise.resolve(42) }) })
      );

      using revived = harness.revive(serialized);
      harness.vm.setProp(harness.vm.global, 'revived', revived);
      using check = harness.vm.evalCode('revived.ready.deep === 42');
      expect(check.toBoolean()).toBe(true);
    } finally {
      harness.dispose();
    }
  });
});
