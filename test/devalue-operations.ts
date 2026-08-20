/**
 * Proof-of-concept: devalue serialization that runs entirely on the host,
 * operating on `JSValueHandle`s instead of on guest values.
 *
 * This is the architecture that lets a serialization layer live *outside*
 * the WASM VM (matching how it works for `node:vm`, where the serializer is
 * host code reaching into the sandbox realm) rather than being bundled into
 * the guest.
 *
 * Two halves, mirroring devalue's two pluggable operation sets:
 *
 * - `stringifyOperations` reads a handle without executing guest code:
 *   the engine's class table for classification (`handle.className`, with no
 *   sample instances needed, not even at boot), boot-captured intrinsics
 *   for extraction, and descriptor reads instead of `[[Get]]`.
 * - `parseOperations` builds values inside the VM through boot-captured
 *   factories, returning a handle the guest can use directly.
 *
 * "Boot-captured" means the intrinsics and factories are taken from the VM
 * before any user code runs, and are held only on the host, so patching
 * `Date.prototype.toISOString` (or anything else) inside the VM afterwards
 * cannot influence serialization.
 */

import {
  filterArrayIndices,
  type ParseOperations,
  type StringifyOperations,
} from 'devalue';
import { QuickJS, type JSValueHandle } from '../src/index.ts';

/**
 * The tags devalue classifies values by. QuickJS registers each of these
 * classes under exactly this name, so `handle.className`, a trap-free
 * read of the engine's class table (`JS_GetClassName`, fixed in
 * quickjs-ng 0.16.2), classifies values directly. No sample instances,
 * no guest code, not even at boot: a VM built without some of these
 * intrinsics classifies the rest just fine.
 */
const BRANDED_TAGS = new Set([
  'Number',
  'String',
  'Boolean',
  'BigInt',
  'Date',
  'RegExp',
  'Array',
  'Set',
  'Map',
  'ArrayBuffer',
  'DataView',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
]);

/**
 * Everything the host needs from the guest realm, captured once at boot.
 *
 * Accessors are captured as functions and invoked with an explicit receiver
 * via `vm.callFunction`, so no property lookup happens on the value being
 * serialized.
 */
const CAPTURE_INTRINSICS = `(() => {
  const descriptor = (object, key) =>
    Object.getOwnPropertyDescriptor(object, key);
  const getter = (object, key) => descriptor(object, key).get;
  const TypedArray = Object.getPrototypeOf(Int8Array.prototype);

  return {
    // --- reading (stringify) ---
    dateGetTime: Date.prototype.getTime,
    dateToISOString: Date.prototype.toISOString,
    regExpSource: getter(RegExp.prototype, 'source'),
    regExpFlags: getter(RegExp.prototype, 'flags'),
    numberValueOf: Number.prototype.valueOf,
    stringValueOf: String.prototype.valueOf,
    booleanValueOf: Boolean.prototype.valueOf,
    bigIntValueOf: BigInt.prototype.valueOf,
    setForEach: Set.prototype.forEach,
    mapForEach: Map.prototype.forEach,
    viewBuffer: getter(TypedArray, 'buffer'),
    viewByteOffset: getter(TypedArray, 'byteOffset'),
    viewByteLength: getter(TypedArray, 'byteLength'),
    viewLength: getter(TypedArray, 'length'),
    dataViewBuffer: getter(DataView.prototype, 'buffer'),
    dataViewByteOffset: getter(DataView.prototype, 'byteOffset'),
    dataViewByteLength: getter(DataView.prototype, 'byteLength'),
    arrayBufferByteLength: getter(ArrayBuffer.prototype, 'byteLength'),
    objectPrototype: Object.prototype,

    // --- building (parse) ---
    // Real constructors, invoked from the host with \`vm.construct()\`.
    Date,
    RegExp,
    Set,
    Map,
    Array,
    Object,
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
    DataView,
    // Captured methods, invoked with an explicit receiver.
    setAdd: Set.prototype.add,
    mapSet: Map.prototype.set,
    objectCreate: Object.create,
    // \`defineProperty\` is used for assignment so that a poisoned setter
    // inherited from a prototype cannot intercept it.
    defineProperty: Object.defineProperty,
    // The sparse-array dance has no host-callable equivalent: it needs a
    // real \`delete\` and a \`length\` assignment.
    makeSparseArray: (length) => {
      const array = [];
      // force dictionary-elements mode before declaring a large length, so an
      // untrusted length cannot trigger a huge contiguous allocation
      array[4294967294] = undefined;
      delete array[4294967294];
      array.length = length;
      return array;
    },
  };
})()`;

export interface DevalueOperations {
  stringifyOperations: StringifyOperations;
  parseOperations: ParseOperations;
  dispose(): void;
}

/**
 * Build host-side devalue operations for a VM. Call immediately after
 * `QuickJS.create()`, before evaluating any user code.
 */
export function createDevalueOperations(vm: QuickJS): DevalueOperations {
  const disposables: JSValueHandle[] = [];

  /** Capture a guest value and keep it alive for the lifetime of the ops. */
  const keep = (handle: JSValueHandle): JSValueHandle => {
    disposables.push(handle);
    return handle;
  };

  // --- boot-time capture -------------------------------------------------

  const intrinsics = keep(vm.evalCode(CAPTURE_INTRINSICS));
  const at = (name: string) => keep(intrinsics.getProp(name));

  const i = {
    dateGetTime: at('dateGetTime'),
    dateToISOString: at('dateToISOString'),
    regExpSource: at('regExpSource'),
    regExpFlags: at('regExpFlags'),
    numberValueOf: at('numberValueOf'),
    stringValueOf: at('stringValueOf'),
    booleanValueOf: at('booleanValueOf'),
    bigIntValueOf: at('bigIntValueOf'),
    setForEach: at('setForEach'),
    mapForEach: at('mapForEach'),
    viewBuffer: at('viewBuffer'),
    viewByteOffset: at('viewByteOffset'),
    viewByteLength: at('viewByteLength'),
    viewLength: at('viewLength'),
    dataViewBuffer: at('dataViewBuffer'),
    dataViewByteOffset: at('dataViewByteOffset'),
    dataViewByteLength: at('dataViewByteLength'),
    arrayBufferByteLength: at('arrayBufferByteLength'),
    objectPrototype: at('objectPrototype'),
    Date: at('Date'),
    RegExp: at('RegExp'),
    Set: at('Set'),
    Map: at('Map'),
    Array: at('Array'),
    Object: at('Object'),
    DataView: at('DataView'),
    setAdd: at('setAdd'),
    mapSet: at('mapSet'),
    objectCreate: at('objectCreate'),
    defineProperty: at('defineProperty'),
    makeSparseArray: at('makeSparseArray'),
  };

  /** Typed-array constructors, captured by name. */
  const typedArrayConstructors = new Map<string, JSValueHandle>();
  for (const name of [
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float32Array',
    'Float64Array',
    'BigInt64Array',
    'BigUint64Array',
    'DataView',
  ]) {
    typedArrayConstructors.set(name, at(name));
  }

  /** Invoke a captured function with an explicit receiver. */
  const call = (
    fn: JSValueHandle,
    thisValue: JSValueHandle,
    ...args: JSValueHandle[]
  ): JSValueHandle => vm.callFunction(fn, thisValue, ...args);

  /** Invoke a captured free function (no receiver). */
  const invoke = (fn: JSValueHandle, ...args: JSValueHandle[]): JSValueHandle =>
    vm.callFunction(fn, vm.undefined, ...args);

  /**
   * Define an own data property. Uses `Object.defineProperty` rather than
   * assignment so that an inherited setter cannot intercept the write: the
   * revived value is built exactly as the payload describes it.
   */
  const define = (
    target: JSValueHandle,
    key: string,
    value: JSValueHandle
  ): void => {
    using descriptor = vm.newObject();
    descriptor.setProp('value', value);
    descriptor.setProp('writable', vm.true);
    descriptor.setProp('enumerable', vm.true);
    descriptor.setProp('configurable', vm.true);
    using keyHandle = vm.newString(key);
    call(i.defineProperty, vm.undefined, target, keyHandle, descriptor).dispose();
  };

  // --- identity ----------------------------------------------------------

  // Object identities must be unforgeable: devalue compares them against the
  // keys of *every* value in the payload, including primitives, so returning
  // the raw pointer (a number) would let a guest number collide with an
  // object's identity and produce a bogus back-reference. Mapping each
  // pointer to a unique host object avoids that entirely.
  const identities = new Map<number, object>();
  const identityOf = (pointer: number): object => {
    let identity = identities.get(pointer);
    if (!identity) {
      identity = { pointer };
      identities.set(pointer, identity);
    }
    return identity;
  };

  // --- stringify ---------------------------------------------------------

  const typeOf = (handle: JSValueHandle): ReturnType<StringifyOperations['typeOf']> => {
    if (handle.isNull) return 'null';
    return handle.typeof as ReturnType<StringifyOperations['typeOf']>;
  };

  const primitive = (handle: JSValueHandle) => {
    if (handle.isUndefined) return undefined;
    if (handle.isNull) return null;
    if (handle.isBool) return handle.toBoolean();
    if (handle.isNumber) return handle.toNumber();
    if (handle.isBigInt) return handle.toBigInt();
    return handle.toString();
  };

  const tag = (handle: JSValueHandle): string => {
    // Trap-free and unspoofable: the engine's registered class name.
    // Everything unbranded (including proxies, whose class is registered
    // as "Object") reports as a plain-object candidate, which `shapeOf`
    // then accepts or rejects without firing traps.
    const name = handle.className;
    return name !== undefined && BRANDED_TAGS.has(name) ? name : 'Object';
  };

  /** Collect the elements a Set/Map yields, via captured `forEach`. */
  const collect = (
    forEach: JSValueHandle,
    collection: JSValueHandle,
    arity: 1 | 2
  ): any[] => {
    const collected: any[] = [];
    // Ephemeral: the callback is unregistered when the handle is disposed, so
    // a serialization pass over many Maps/Sets doesn't accumulate callbacks.
    using visitor = vm.newEphemeralFunction((value, key) => {
      collected.push(arity === 1 ? value.dup() : [key.dup(), value.dup()]);
      return vm.undefined;
    });
    call(forEach, collection, visitor).dispose();
    return collected;
  };

  // Typed as the *complete* interface (not Partial): if devalue adds a hook
  // this implementation is missing, compilation fails, which is exactly the
  // gap-detection this POC exists to provide.
  const stringifyOperations: StringifyOperations = {
    identify: (handle: JSValueHandle) => {
      const pointer = handle.identity;
      // primitives are deduplicated by value, exactly like host devalue
      if (pointer === 0 || handle.isString) return primitive(handle);
      return identityOf(pointer);
    },

    typeOf,
    toPrimitive: primitive,
    tagOf: tag,

    isThenable: (handle: JSValueHandle) => handle.isPromise,

    toPromise: async (handle: JSValueHandle) => {
      const settled = await vm.resolvePromise(handle);
      if ('error' in settled) throw settled.error;
      return settled.value;
    },

    unbox: (handle: JSValueHandle) => {
      switch (tag(handle)) {
        case 'Number':
          return call(i.numberValueOf, handle);
        case 'String':
          return call(i.stringValueOf, handle);
        case 'Boolean':
          return call(i.booleanValueOf, handle);
        default:
          return call(i.bigIntValueOf, handle);
      }
    },

    toISOString: (handle: JSValueHandle) =>
      vm.withScope(() => {
        if (Number.isNaN(call(i.dateGetTime, handle).toNumber())) return '';
        return call(i.dateToISOString, handle).toString();
      }),

    // Only reached for URL / URLSearchParams / Temporal.*, none of which
    // exist in the base VM. `handle.toString()` would execute guest code
    // (the value's own `toString`), so this deliberately refuses rather than
    // silently running it; a VM with those types would capture the relevant
    // prototype methods the same way the intrinsics above are captured.
    toStringValue: (handle: JSValueHandle) => {
      throw new Error(
        `no captured string conversion for ${tag(handle)} in this VM`
      );
    },

    regExpInfo: (handle: JSValueHandle) =>
      vm.withScope(() => ({
        source: call(i.regExpSource, handle).toString(),
        flags: call(i.regExpFlags, handle).toString(),
      })),

    valuesOf: (handle: JSValueHandle) => collect(i.setForEach, handle, 1),
    entriesOf: (handle: JSValueHandle) => collect(i.mapForEach, handle, 2),

    viewInfo: (handle: JSValueHandle) =>
      // Every intermediate here is a number read through a captured getter;
      // only the buffer handle needs to outlive the scope.
      vm.withScope((scope) => {
        const isDataView = handle.isDataView;
        const buffer = call(isDataView ? i.dataViewBuffer : i.viewBuffer, handle);
        const info = {
          buffer: scope.escape(buffer),
          byteOffset: call(
            isDataView ? i.dataViewByteOffset : i.viewByteOffset,
            handle
          ).toNumber(),
          byteLength: call(
            isDataView ? i.dataViewByteLength : i.viewByteLength,
            handle
          ).toNumber(),
          bufferByteLength: call(i.arrayBufferByteLength, buffer).toNumber(),
          length: 0,
        };
        if (!isDataView) {
          info.length = call(i.viewLength, handle).toNumber();
        }
        return info;
      }),

    toArrayBuffer: (handle: JSValueHandle) => handle.toArrayBuffer(),

    lengthOf: (handle: JSValueHandle) => {
      const descriptor = handle.getOwnPropertyDescriptor('length');
      // `length` is an own data property on arrays, so no getter runs
      return descriptor?.value?.consume((h) => h.toNumber()) ?? 0;
    },

    hasOwn: (handle: JSValueHandle, key: string | number) =>
      handle.hasOwnProperty(String(key)),

    // `keys()` is own enumerable string keys in property order, which is
    // exactly what devalue's filtering helper expects
    indicesOf: (handle: JSValueHandle) => filterArrayIndices(handle.keys()),

    shapeOf: (handle: JSValueHandle) => {
      // A proxy would run trap code for every question asked below.
      if (handle.isProxy) return { kind: 'not-plain' as const };

      using prototype = handle.getPrototypeOf();
      const isPlain =
        prototype.isNull || prototype.identity === i.objectPrototype.identity;
      if (!isPlain) return { kind: 'not-plain' as const };

      const keys: string[] = [];
      for (const key of handle.getOwnPropertyKeys()) {
        if (typeof key !== 'string') {
          const enumerable = handle
            .getOwnPropertyDescriptor(key)
            ?.enumerable;
          key.dispose();
          if (enumerable) return { kind: 'symbol-keys' as const };
          continue;
        }
        if (handle.propertyIsEnumerable(key)) keys.push(key);
      }

      return {
        kind: prototype.isNull ? ('null-proto' as const) : ('plain' as const),
        keys,
      };
    },

    get: (handle: JSValueHandle, key: string | number) => {
      const descriptor = handle.getOwnPropertyDescriptor(String(key));
      if (!descriptor) return vm.undefined;
      if (descriptor.get) {
        // Reading through the accessor would execute guest code; a production
        // implementation would de-opt or report taint here.
        descriptor.get.dispose();
        descriptor.set?.dispose();
        throw new Error(`refusing to invoke getter for "${key}"`);
      }
      return descriptor.value ?? vm.undefined;
    },
  };

  // --- parse -------------------------------------------------------------

  const parseOperations: ParseOperations = {
    // host bigints arrive here too; devalue converts the decimal string
    // host-side, mirroring `toPrimitive`'s domain
    fromPrimitive: (value) =>
      typeof value === 'bigint' ? vm.newBigInt(value) : vm.hostToHandle(value),

    fromISOString: (iso) => {
      // an empty ISO string represents an invalid date
      using argument = iso === '' ? vm.newNumber(NaN) : vm.newString(iso);
      return vm.construct(i.Date, argument);
    },

    // URL / URLSearchParams / Temporal.*: none exist in the base VM
    fromStringValue: (tag) => {
      throw new Error(`${tag} is not available in this VM`);
    },

    fromArrayBuffer: (buffer) => vm.newArrayBuffer(buffer),

    fromRegExpInfo: (source, flags) => {
      using sourceHandle = vm.newString(source);
      if (!flags) return vm.construct(i.RegExp, sourceHandle);
      using flagsHandle = vm.newString(flags);
      return vm.construct(i.RegExp, sourceHandle, flagsHandle);
    },

    fromViewInfo: (tag, buffer, byteOffset, length) => {
      const Constructor = typedArrayConstructors.get(tag);
      if (!Constructor) throw new Error(`${tag} is not available in this VM`);
      if (byteOffset === undefined) return vm.construct(Constructor, buffer);
      using offsetHandle = vm.newNumber(byteOffset);
      using lengthHandle = vm.newNumber(length ?? 0);
      return vm.construct(Constructor, buffer, offsetHandle, lengthHandle);
    },

    box: (value: JSValueHandle) => vm.construct(i.Object, value),

    createArray: (length) => {
      // `new Array(n)` with a single numeric argument creates n holes
      using lengthHandle = vm.newNumber(length);
      return vm.construct(i.Array, lengthHandle);
    },

    createSparseArray: (length) => {
      using lengthHandle = vm.newNumber(length);
      return invoke(i.makeSparseArray, lengthHandle);
    },

    createObject: () => vm.newObject(),
    createNullPrototypeObject: () =>
      call(i.objectCreate, vm.undefined, vm.null),

    createSet: () => vm.construct(i.Set),
    createMap: () => vm.construct(i.Map),

    // serves arrays and objects alike, the inverse of `get`
    set: (target: JSValueHandle, key, value: JSValueHandle) =>
      define(target, String(key), value),

    addValue: (set: JSValueHandle, value: JSValueHandle) => {
      call(i.setAdd, set, value).dispose();
    },

    addEntry: (map: JSValueHandle, key: JSValueHandle, value: JSValueHandle) => {
      call(i.mapSet, map, key, value).dispose();
    },
  };

  return {
    stringifyOperations,
    parseOperations,
    dispose() {
      for (const handle of disposables.reverse()) handle.dispose();
      disposables.length = 0;
    },
  };
}
