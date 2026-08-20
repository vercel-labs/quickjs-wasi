import { useState, useRef, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ObjectInspector,
  chromeDark,
  type DataAccessor,
  type InspectedPropertyDescriptor,
} from 'react-inspector';
import {
  QuickJS,
  JSException,
  EvalFlags,
  type JSValueHandle,
} from 'quickjs-wasi';
import Editor, { type OnMount, type BeforeMount } from '@monaco-editor/react';
import { initVimMode } from 'monaco-vim';
import {
  Play,
  Loader2,
  Globe,
  Terminal,
  Type,
  FileText,
  Copy,
  Github,
  Lock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import '@/index.css';

// ─── JSValue DataAccessor for react-inspector ───────────────────────────────

/**
 * Guest values the inspector needs in order to render without executing
 * guest code, captured once per VM.
 *
 * Rendering is the same problem shape as side-effect-free serialization: the
 * host inspects values the guest built, so any dynamic lookup —
 * `value.toString()`, `Symbol.iterator`, `.constructor.name` — dispatches
 * through guest-patchable prototypes and runs guest code *while drawing the
 * UI*. Capturing the methods up front and invoking them with an explicit
 * receiver keeps the display identical while making the lookup unpatchable.
 *
 * `captureInspectorIntrinsics` is called immediately after the VM is created
 * (before any user code runs); the lazy path is a fallback.
 */
interface InspectorIntrinsics {
  objectPrototypeIdentity: number;
  symbolIterator: JSValueHandle;
  dateToString: JSValueHandle;
  regExpToString: JSValueHandle;
  symbolToString: JSValueHandle;
  mapForEach: JSValueHandle;
  setForEach: JSValueHandle;
}

const intrinsicsCache = new WeakMap<QuickJS, InspectorIntrinsics>();

function captureInspectorIntrinsics(vm: QuickJS): InspectorIntrinsics {
  const captured = vm.evalCode(`({
    objectPrototype: Object.prototype,
    symbolIterator: Symbol.iterator,
    dateToString: Date.prototype.toString,
    regExpToString: RegExp.prototype.toString,
    symbolToString: Symbol.prototype.toString,
    mapForEach: Map.prototype.forEach,
    setForEach: Set.prototype.forEach,
  })`);
  const at = (name: string) => captured.getProp(name);
  const objectPrototype = at('objectPrototype');
  const intrinsics: InspectorIntrinsics = {
    // Identity, not `.ptr`: every handle is its own heap box, so two
    // handles to one object never share a `.ptr`.
    objectPrototypeIdentity: objectPrototype.identity,
    symbolIterator: at('symbolIterator'),
    dateToString: at('dateToString'),
    regExpToString: at('regExpToString'),
    symbolToString: at('symbolToString'),
    mapForEach: at('mapForEach'),
    setForEach: at('setForEach'),
  };
  objectPrototype.dispose();
  captured.dispose();
  intrinsicsCache.set(vm, intrinsics);
  return intrinsics;
}

function intrinsics(vm: QuickJS): InspectorIntrinsics {
  return intrinsicsCache.get(vm) ?? captureInspectorIntrinsics(vm);
}

/** Invoke a captured method with an explicit receiver, returning a string. */
function callToString(
  method: JSValueHandle,
  receiver: JSValueHandle
): string | undefined {
  try {
    return receiver.vm
      .callFunction(method, receiver)
      .consume((result) => result.toString());
  } catch {
    return undefined;
  }
}

/**
 * Reads an own data property without invoking accessors or proxy traps.
 * Returns undefined for accessor properties, missing properties, and
 * proxies — callers decide what to display instead.
 */
function readOwnData(
  handle: JSValueHandle,
  key: string
): JSValueHandle | undefined {
  if (handle.isProxy) return undefined;
  let descriptor: ReturnType<JSValueHandle['getOwnPropertyDescriptor']>;
  try {
    descriptor = handle.getOwnPropertyDescriptor(key);
  } catch {
    return undefined;
  }
  if (!descriptor) return undefined;
  if (descriptor.get || descriptor.set) {
    descriptor.get?.dispose();
    descriptor.set?.dispose();
    return undefined;
  }
  return descriptor.value;
}

// Synthetic property names used to render a Proxy's internals
// (mirrors Chrome DevTools' presentation) without firing any traps.
const PROXY_INTERNALS = ['[[Target]]', '[[Handler]]'] as const;

const jsValueAccessor: DataAccessor = {
  typeof(value: unknown): string {
    return (value as JSValueHandle).typeof;
  },

  toString(value: unknown): string {
    const h = value as JSValueHandle;
    // toString() on a Proxy would fire get/apply traps
    if (h.isProxy) return 'Proxy';
    // For objects, `handle.toString()` performs a JavaScript string
    // conversion, which dispatches through the guest's (patchable)
    // `toString`/`valueOf`. Use the captured intrinsic for the branded
    // types the inspector renders this way — same output, unpatchable
    // lookup. Primitives convert without running any guest code.
    if (h.isObject) {
      const i = intrinsics(h.vm);
      if (h.isDate) return callToString(i.dateToString, h) ?? 'Invalid Date';
      if (h.isRegExp) return callToString(i.regExpToString, h) ?? 'RegExp';
    } else if (h.isSymbol) {
      return callToString(intrinsics(h.vm).symbolToString, h) ?? 'Symbol()';
    }
    return h.toString();
  },

  isNull(value: unknown): boolean {
    return (value as JSValueHandle).isNull;
  },

  isArray(value: unknown): boolean {
    return (value as JSValueHandle).isArray;
  },

  isDate(value: unknown): boolean {
    // Engine brand check: trap-free and unspoofable, unlike the previous
    // constructorName === 'Date' lookup (which fired getters/traps and
    // was fooled by `{ constructor: Date }`).
    return (value as JSValueHandle).isDate;
  },

  isRegExp(value: unknown): boolean {
    return (value as JSValueHandle).isRegExp;
  },

  isIterable(value: unknown): boolean {
    const h = value as JSValueHandle;
    if (!h.isObject) return false;
    // Arrays are iterable but react-inspector handles them separately
    if (h.isArray) return false;
    // Never probe a Proxy — it renders via [[Target]]/[[Handler]] instead
    if (h.isProxy) return false;
    // Genuine Map/Set: trust the brand, skip the probing call below
    if (h.isMap || h.isSet) return true;
    const sym = intrinsics(h.vm).symbolIterator;
    const method = h.vm.getProp(h, sym);
    if (!method.isFunction) {
      method.dispose();
      return false;
    }
    // Verify the iterator actually works — prototype objects have
    // Symbol.iterator but throw when called without instance data.
    try {
      const iterator = h.vm.callFunction(method, h);
      iterator.dispose();
      method.dispose();
      return true;
    } catch {
      method.dispose();
      return false;
    }
  },

  iterate(value: unknown): Iterable<unknown> {
    const h = value as JSValueHandle;

    // Genuine Map/Set: iterate with the captured `forEach`, which reads the
    // internal entry list directly. The iterator protocol is never touched,
    // so a patched `Map.prototype[Symbol.iterator]` (or a patched
    // `%MapIteratorPrototype%.next`) cannot run — or lie — while rendering.
    if (h.isMap || h.isSet) {
      const i = intrinsics(h.vm);
      const entries: JSValueHandle[] = [];
      // Ephemeral: the callback unregisters when the handle is disposed, so
      // re-rendering a tree of Maps doesn't accumulate host callbacks.
      const visitor = h.vm.newEphemeralFunction((entryValue, entryKey) => {
        if (h.isMap) {
          // react-inspector renders Map entries as [key, value] pairs
          const pair = h.vm.newArray();
          pair.setProp('0', entryKey);
          pair.setProp('1', entryValue);
          entries.push(pair);
        } else {
          entries.push(entryValue.dup());
        }
        return h.vm.undefined;
      });
      try {
        h.vm
          .callFunction(h.isMap ? i.mapForEach : i.setForEach, h, visitor)
          .dispose();
      } catch {
        // fall through to an empty rendering
      } finally {
        visitor.dispose();
      }
      return entries;
    }

    const sym = intrinsics(h.vm).symbolIterator;
    const method = h.vm.getProp(h, sym);
    if (!method.isFunction) {
      method.dispose();
      return [];
    }
    // Calling Symbol.iterator on a prototype object (rather than an instance)
    // will throw because there is no opaque instance data. Catch and bail out.
    try {
      const iterator = h.vm.callFunction(method, h);
      method.dispose();
      const entries: JSValueHandle[] = [];
      const nextFn = iterator.getProp('next');
      for (;;) {
        const result = h.vm.callFunction(nextFn, iterator);
        const doneProp = result.getProp('done');
        const done = doneProp.toString() === 'true';
        doneProp.dispose();
        if (done) {
          result.dispose();
          break;
        }
        const val = result.getProp('value');
        entries.push(val.dup());
        val.dispose();
        result.dispose();
      }
      nextFn.dispose();
      iterator.dispose();
      return entries;
    } catch {
      method.dispose();
      return [];
    }
  },

  length(value: unknown): number {
    const h = value as JSValueHandle;
    // `handle.length` is a [[Get]]; read the own data property instead so a
    // `length` accessor is not invoked just to size the preview.
    const length = readOwnData(h, 'length');
    if (!length) return 0;
    return length.consume((n) => (n.isNumber ? n.toNumber() : 0));
  },

  getOwnPropertyNames(value: unknown): string[] {
    const h = value as JSValueHandle;
    // Enumerating a Proxy fires its ownKeys trap; render the internal
    // slots instead (like DevTools' Proxy view).
    if (h.isProxy) return [...PROXY_INTERNALS];
    return h.getOwnPropertyNames();
  },

  keys(value: unknown): string[] {
    const h = value as JSValueHandle;
    if (h.isProxy) return [...PROXY_INTERNALS];
    return h.keys();
  },

  hasOwnProperty(value: unknown, prop: string): boolean {
    const h = value as JSValueHandle;
    if (h.isProxy) return (PROXY_INTERNALS as readonly string[]).includes(prop);
    return h.hasOwnProperty(prop);
  },

  propertyIsEnumerable(value: unknown, prop: string): boolean {
    const h = value as JSValueHandle;
    if (h.isProxy) return (PROXY_INTERNALS as readonly string[]).includes(prop);
    return h.propertyIsEnumerable(prop);
  },

  getProperty(value: unknown, prop: string): unknown {
    const h = value as JSValueHandle;
    if (h.isProxy) {
      // Trap-free engine access to the proxy's internal slots
      if (prop === '[[Target]]') return h.getProxyTarget();
      if (prop === '[[Handler]]') return h.getProxyHandler();
      return h.vm.getUndefined();
    }
    return h.getProp(prop);
  },

  getOwnPropertyDescriptor(value: unknown, prop: string): InspectedPropertyDescriptor | undefined {
    const h = value as JSValueHandle;
    if (h.isProxy) {
      // The synthetic [[Target]]/[[Handler]] rows are plain data —
      // resolved through engine internals, no traps fired.
      if (prop === '[[Target]]') {
        return { value: h.getProxyTarget(), enumerable: true, configurable: false };
      }
      if (prop === '[[Handler]]') {
        return { value: h.getProxyHandler(), enumerable: true, configurable: false };
      }
      return undefined;
    }
    let desc;
    try {
      // Engine-level descriptor read: never invokes getters
      desc = h.getOwnPropertyDescriptor(prop);
    } catch {
      return undefined; // fall back to getProperty
    }
    if (!desc) return undefined;
    if (desc.get || desc.set) {
      // Accessor property. react-inspector keys off the truthiness of
      // `get`, so translate a guest `undefined` handle (truthy on the
      // host!) to host undefined — and dispose the discarded handle.
      let get = desc.get;
      if (get?.isUndefined) {
        get.dispose();
        get = undefined;
      }
      let set = desc.set;
      if (set?.isUndefined) {
        set.dispose();
        set = undefined;
      }
      return {
        get,
        set,
        enumerable: desc.enumerable,
        configurable: desc.configurable,
      };
    }
    return {
      value: desc.value,
      writable: desc.writable,
      enumerable: desc.enumerable,
      configurable: desc.configurable,
    };
  },

  getPrototypeOf(value: unknown): unknown {
    const h = value as JSValueHandle;
    // Object.getPrototypeOf on a Proxy fires its getPrototypeOf trap
    if (h.isProxy) return h.vm.getNull();
    return h.getPrototypeOf();
  },

  getConstructorName(value: unknown): string | undefined {
    const h = value as JSValueHandle;
    // Reading .constructor.name on a Proxy would fire its get trap. The
    // engine registers the Proxy class as "Object", so this must come
    // before the className read.
    if (h.isProxy) return 'Proxy';

    // Prefer the engine's class table: `className` is a trap-free,
    // unspoofable read that labels every registered class — including the
    // typed arrays and extension-defined classes (URL, Headers,
    // TextEncoder, …) the previous hand-rolled brand ladder missed.
    // Generic names fall through: "Object"/"Function" so user classes get
    // their real name from the prototype, and "Error" so TypeError
    // instances (all native errors share the one Error class) do too.
    const className = h.className;
    if (
      className !== undefined &&
      className !== 'Object' &&
      className !== 'Function' &&
      className !== 'Error'
    ) {
      return className;
    }

    // Unbranded: take the constructor from the *prototype*, never from the
    // value's own properties — `{ constructor: Map }` would otherwise be
    // labelled "Map". This matches how DevTools derives the label, keeps
    // real class instances reporting their class, and both hops are
    // descriptor reads so neither invokes an accessor.
    const ctor = h
      .getPrototypeOf()
      .consume((proto) =>
        proto.isObject ? readOwnData(proto, 'constructor') : undefined
      );
    if (!ctor) return undefined;
    return ctor.consume((c) => {
      const name = readOwnData(c, 'name');
      return name?.consume((n) => (n.isString ? n.toString() : undefined));
    });
  },

  getFunctionName(value: unknown): string {
    const h = value as JSValueHandle;
    // Reading .name on a proxied function would fire its get trap
    if (h.isProxy) return '';
    const name = readOwnData(h, 'name');
    return name?.consume((n) => (n.isString ? n.toString() : '')) ?? '';
  },

  isBuffer(value: unknown): boolean {
    return (value as JSValueHandle).isArrayBuffer;
  },

  hasChildren(value: unknown): boolean {
    const h = value as JSValueHandle;
    return h.isObject || h.isFunction;
  },

  isObjectPrototype(value: unknown): boolean {
    const h = value as JSValueHandle;
    // Compare heap-value identity, not `.ptr`: `.ptr` is this handle's own
    // JSValue box, so it differs for every handle — including two handles
    // to `Object.prototype` — which silently disabled this guard.
    return h.identity === intrinsics(h.vm).objectPrototypeIdentity;
  },
};

// ─── localStorage helpers ────────────────────────────────────────────────────

const STORAGE_KEYS = {
  code: 'qjs-playground:code',
  urlExt: 'qjs-playground:urlExt',
  encodingExt: 'qjs-playground:encodingExt',
  headersExt: 'qjs-playground:headersExt',
  structuredCloneExt: 'qjs-playground:structuredCloneExt',
  cryptoExt: 'qjs-playground:cryptoExt',
  vim: 'qjs-playground:vim',
} as const;

function loadString(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === 'true';
  } catch {
    return fallback;
  }
}

function save(key: string, value: string | boolean) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}

// ─── DOMException type definitions (built-in QuickJS-NG intrinsic) ───────────

const DOMEXCEPTION_TYPE_DEFS = `
/** The DOMException interface represents an abnormal event related to accessing a web API. */
declare class DOMException {
  constructor(message?: string, name?: string);
  /** The name of the error (e.g. "NotFoundError", "InvalidCharacterError"). */
  readonly name: string;
  /** A human-readable error message. */
  readonly message: string;
  /** A legacy numeric error code. */
  readonly code: number;

  static readonly INDEX_SIZE_ERR: 1;
  static readonly DOMSTRING_SIZE_ERR: 2;
  static readonly HIERARCHY_REQUEST_ERR: 3;
  static readonly WRONG_DOCUMENT_ERR: 4;
  static readonly INVALID_CHARACTER_ERR: 5;
  static readonly NO_DATA_ALLOWED_ERR: 6;
  static readonly NO_MODIFICATION_ALLOWED_ERR: 7;
  static readonly NOT_FOUND_ERR: 8;
  static readonly NOT_SUPPORTED_ERR: 9;
  static readonly INUSE_ATTRIBUTE_ERR: 10;
  static readonly INVALID_STATE_ERR: 11;
  static readonly SYNTAX_ERR: 12;
  static readonly INVALID_MODIFICATION_ERR: 13;
  static readonly NAMESPACE_ERR: 14;
  static readonly INVALID_ACCESS_ERR: 15;
  static readonly VALIDATION_ERR: 16;
  static readonly TYPE_MISMATCH_ERR: 17;
  static readonly SECURITY_ERR: 18;
  static readonly NETWORK_ERR: 19;
  static readonly ABORT_ERR: 20;
  static readonly URL_MISMATCH_ERR: 21;
  static readonly QUOTA_EXCEEDED_ERR: 22;
  static readonly TIMEOUT_ERR: 23;
  static readonly INVALID_NODE_TYPE_ERR: 24;
  static readonly DATA_CLONE_ERR: 25;

  readonly INDEX_SIZE_ERR: 1;
  readonly DOMSTRING_SIZE_ERR: 2;
  readonly HIERARCHY_REQUEST_ERR: 3;
  readonly WRONG_DOCUMENT_ERR: 4;
  readonly INVALID_CHARACTER_ERR: 5;
  readonly NO_DATA_ALLOWED_ERR: 6;
  readonly NO_MODIFICATION_ALLOWED_ERR: 7;
  readonly NOT_FOUND_ERR: 8;
  readonly NOT_SUPPORTED_ERR: 9;
  readonly INUSE_ATTRIBUTE_ERR: 10;
  readonly INVALID_STATE_ERR: 11;
  readonly SYNTAX_ERR: 12;
  readonly INVALID_MODIFICATION_ERR: 13;
  readonly NAMESPACE_ERR: 14;
  readonly INVALID_ACCESS_ERR: 15;
  readonly VALIDATION_ERR: 16;
  readonly TYPE_MISMATCH_ERR: 17;
  readonly SECURITY_ERR: 18;
  readonly NETWORK_ERR: 19;
  readonly ABORT_ERR: 20;
  readonly URL_MISMATCH_ERR: 21;
  readonly QUOTA_EXCEEDED_ERR: 22;
  readonly TIMEOUT_ERR: 23;
  readonly INVALID_NODE_TYPE_ERR: 24;
  readonly DATA_CLONE_ERR: 25;
}
`;

// ─── URL / URLSearchParams type definitions ──────────────────────────────────

const URL_TYPE_DEFS = `
/** The URL interface represents an object providing static methods for creating object URLs. */
declare class URL {
  constructor(url: string | URL, base?: string | URL);
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  username: string;
  toString(): string;
  toJSON(): string;
  static canParse(url: string | URL, base?: string): boolean;
}

/** The URLSearchParams interface defines utility methods to work with the query string of a URL. */
declare class URLSearchParams {
  constructor(init?: string | URLSearchParams | Record<string, string> | [string, string][]);
  readonly size: number;
  append(name: string, value: string): void;
  delete(name: string, value?: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string, value?: string): boolean;
  set(name: string, value: string): void;
  sort(): void;
  toString(): string;
  forEach(callbackfn: (value: string, key: string, parent: URLSearchParams) => void, thisArg?: any): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
}
`;

// ─── TextEncoder / TextDecoder type definitions ─────────────────────────────

const ENCODING_TYPE_DEFS = `
/** The TextEncoder interface encodes a string into a Uint8Array containing UTF-8 encoded text. */
declare class TextEncoder {
  constructor();
  readonly encoding: "utf-8";
  encode(input?: string): Uint8Array;
  encodeInto(source: string, destination: Uint8Array): { read: number; written: number };
}

/** The TextDecoder interface decodes bytes into a string using a specified encoding. */
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string;
}
`;

// ─── atob / btoa + Uint8Array base64/hex type definitions ───────────────────
//
// These APIs are built-in to quickjs-ng v0.15.0+ — `atob`, `btoa` are global
// functions and the Uint8Array methods are part of the TypedArrays intrinsic.
// We always surface their types in Monaco so users get autocomplete.

const BASE64_TYPE_DEFS = `
/** Encodes a binary string (each char code 0-255) to base64. */
declare function btoa(data: string): string;
/** Decodes a base64-encoded string to a binary string. */
declare function atob(data: string): string;

interface Uint8ArrayBase64Options {
  alphabet?: "base64" | "base64url";
}
interface Uint8ArrayFromBase64Options extends Uint8ArrayBase64Options {
  lastChunkHandling?: "loose" | "strict" | "stop-before-partial";
}
interface Uint8ArraySetFromResult {
  read: number;
  written: number;
}
interface Uint8Array {
  /** Encodes the byte data as a base64 string. */
  toBase64(options?: Uint8ArrayBase64Options & { omitPadding?: boolean }): string;
  /** Encodes the byte data as a lowercase hex string. */
  toHex(): string;
  /** Writes bytes decoded from a base64 string into this array. */
  setFromBase64(base64: string, options?: Uint8ArrayFromBase64Options): Uint8ArraySetFromResult;
  /** Writes bytes decoded from a hex string into this array. */
  setFromHex(hex: string): Uint8ArraySetFromResult;
}
interface Uint8ArrayConstructor {
  /** Creates a new Uint8Array from a base64-encoded string. */
  fromBase64(base64: string, options?: Uint8ArrayFromBase64Options): Uint8Array;
  /** Creates a new Uint8Array from a hex-encoded string. */
  fromHex(hex: string): Uint8Array;
}
`;

// ─── Headers type definitions ─────────────────────────────────────────────────

const HEADERS_TYPE_DEFS = `
/** The Headers interface of the Fetch API allows you to perform various actions on HTTP request and response headers. */
declare class Headers {
  constructor(init?: HeadersInit);
  append(name: string, value: string): void;
  delete(name: string): void;
  get(name: string): string | null;
  getSetCookie(): string[];
  has(name: string): boolean;
  set(name: string, value: string): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  forEach(callbackfn: (value: string, key: string, parent: Headers) => void, thisArg?: any): void;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}
type HeadersInit = Headers | Record<string, string> | [string, string][];
`;

// ─── structuredClone type definitions ─────────────────────────────────────────

const STRUCTUREDCLONE_TYPE_DEFS = `
/** Creates a deep clone of a value using the structured clone algorithm. */
declare function structuredClone<T>(value: T): T;
`;

// ─── Web Crypto API type definitions ──────────────────────────────────────────

const CRYPTO_TYPE_DEFS = `
/** The CryptoKey interface represents a cryptographic key. */
declare class CryptoKey {
  private constructor();
  readonly type: "secret" | "public" | "private";
  readonly extractable: boolean;
  readonly algorithm: KeyAlgorithm;
  readonly usages: KeyUsage[];
}
interface KeyAlgorithm { name: string; [key: string]: any; }
type KeyUsage = "encrypt" | "decrypt" | "sign" | "verify" | "deriveKey" | "deriveBits" | "wrapKey" | "unwrapKey";
type KeyFormat = "raw" | "pkcs8" | "spki" | "jwk";
interface CryptoKeyPair { publicKey: CryptoKey; privateKey: CryptoKey; }
interface Algorithm { name: string; [key: string]: any; }

/** The SubtleCrypto interface provides cryptographic primitives. */
declare class SubtleCrypto {
  private constructor();
  digest(algorithm: string | Algorithm, data: BufferSource): Promise<ArrayBuffer>;
  generateKey(algorithm: any, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey | CryptoKeyPair>;
  importKey(format: KeyFormat, keyData: BufferSource, algorithm: any, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey>;
  exportKey(format: KeyFormat, key: CryptoKey): Promise<ArrayBuffer>;
  sign(algorithm: string | Algorithm, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
  verify(algorithm: string | Algorithm, key: CryptoKey, signature: BufferSource, data: BufferSource): Promise<boolean>;
  encrypt(algorithm: any, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
  decrypt(algorithm: any, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
  deriveBits(algorithm: any, baseKey: CryptoKey, length: number): Promise<ArrayBuffer>;
  deriveKey(algorithm: any, baseKey: CryptoKey, derivedKeyType: any, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey>;
  wrapKey(format: KeyFormat, key: CryptoKey, wrappingKey: CryptoKey, wrapAlgorithm: any): Promise<ArrayBuffer>;
  unwrapKey(format: KeyFormat, wrappedKey: BufferSource, unwrappingKey: CryptoKey, unwrapAlgorithm: any, unwrappedKeyAlgorithm: any, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey>;
}

/** The Crypto interface provides basic cryptography features. */
declare class Crypto {
  private constructor();
  readonly subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  randomUUID(): string;
}

declare var crypto: Crypto;
`;

// ─── Extension Toggle component ──────────────────────────────────────────────

function ExtensionToggle({
  checked,
  onToggle,
  icon: Icon,
  label,
  tooltip,
}: {
  checked: boolean;
  onToggle: (checked: boolean) => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  tooltip: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger>
        <div className="flex items-center gap-2">
          <Switch
            checked={checked}
            onCheckedChange={onToggle}
            aria-label={`Enable ${label} extension`}
          />
          <label
            className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none"
            onClick={() => onToggle(!checked)}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </label>
        </div>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** Helper: renders an MDN link with <code> styling. */
function MdnLink({
  path,
  children,
}: {
  path: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={`https://developer.mozilla.org/en-US/docs/Web/API/${path}`}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
    >
      <code>{children}</code>
    </a>
  );
}

// ─── Constants ───────────────────────────────────────────────────────────────

const inspectorTheme = {
  ...chromeDark,
  BASE_FONT_FAMILY: 'var(--font-mono)',
  BASE_FONT_SIZE: '13px',
  BASE_BACKGROUND_COLOR: 'transparent',
  TREENODE_FONT_FAMILY: 'var(--font-mono)',
  TREENODE_FONT_SIZE: '13px',
} as unknown as string;

type OutputResult = { type: 'result'; value: JSValueHandle };
type OutputLog = { type: 'log'; values: JSValueHandle[] };
type OutputError = { type: 'error'; text: string };
type OutputEntry = OutputResult | OutputLog | OutputError;

const DEFAULT_CODE = `// Try any JavaScript \u2014 it runs in a sandboxed QuickJS VM
const obj = {
  name: "QuickJS",
  version: "2024.2",
  features: ["ES2023", "modules", "BigInt"],
  nested: { a: 1, b: [2, 3, { c: true }] },
};

console.log("Hello from QuickJS!", obj);
obj;`;

// ─── Output rendering ────────────────────────────────────────────────────────

function OutputEntryView({ entry }: { entry: OutputEntry }) {
  if (entry.type === 'result') {
    return (
      <div className="flex gap-2 py-0.5">
        <span className="text-emerald-400 select-none shrink-0">&larr;</span>
        <div className="text-emerald-400 min-w-0">
          <ObjectInspector
            data={entry.value}
            theme={inspectorTheme}
            expandLevel={1}
            dataAccessor={jsValueAccessor}
          />
        </div>
      </div>
    );
  }

  if (entry.type === 'log') {
    return (
      <div className="flex gap-2 py-0.5 text-muted-foreground">
        <span className="select-none shrink-0">&gt;</span>
        <div className="min-w-0">
          {entry.values.map((v, i) => (
            <span key={i} className="align-top">
              {i > 0 && ' '}
              <ObjectInspector
                data={v}
                theme={inspectorTheme}
                expandLevel={0}
                dataAccessor={jsValueAccessor}
              />
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (entry.type === 'error') {
    return (
      <div className="flex gap-2 py-0.5">
        <span className="text-destructive select-none shrink-0">!</span>
        <span className="text-destructive whitespace-pre-wrap">
          {entry.text}
        </span>
      </div>
    );
  }

  return null;
}

// ─── App ─────────────────────────────────────────────────────────────────────

const URL_TYPES_URI = 'ts:url-extension/url.d.ts';
const ENCODING_TYPES_URI = 'ts:encoding-extension/encoding.d.ts';
const BASE64_TYPES_URI = 'ts:quickjs-env/base64.d.ts';
const HEADERS_TYPES_URI = 'ts:headers-extension/headers.d.ts';
const STRUCTUREDCLONE_TYPES_URI =
  'ts:structured-clone-extension/structured-clone.d.ts';
const CRYPTO_TYPES_URI = 'ts:crypto-extension/crypto.d.ts';

function App() {
  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<OutputEntry[]>([]);
  const vmRef = useRef<QuickJS | null>(null);
  const [wasmReady, setWasmReady] = useState(false);
  const [urlExtEnabled, setUrlExtEnabled] = useState(() =>
    loadBool(STORAGE_KEYS.urlExt, false),
  );
  const [encodingExtEnabled, setEncodingExtEnabled] = useState(() =>
    loadBool(STORAGE_KEYS.encodingExt, false),
  );
  const [headersExtEnabled, setHeadersExtEnabled] = useState(() =>
    loadBool(STORAGE_KEYS.headersExt, false),
  );
  const [structuredCloneExtEnabled, setStructuredCloneExtEnabled] = useState(
    () => loadBool(STORAGE_KEYS.structuredCloneExt, false),
  );
  const [cryptoExtEnabled, setCryptoExtEnabled] = useState(() =>
    loadBool(STORAGE_KEYS.cryptoExt, false),
  );
  const [vimEnabled, setVimEnabled] = useState(() =>
    loadBool(STORAGE_KEYS.vim, false),
  );
  const wasmModuleRef = useRef<WebAssembly.Module | null>(null);
  const urlExtBytesRef = useRef<ArrayBuffer | null>(null);
  const encodingExtBytesRef = useRef<ArrayBuffer | null>(null);
  const headersExtBytesRef = useRef<ArrayBuffer | null>(null);
  const structuredCloneExtBytesRef = useRef<ArrayBuffer | null>(null);
  const cryptoExtBytesRef = useRef<ArrayBuffer | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const vimModeRef = useRef<ReturnType<typeof initVimMode> | null>(null);
  const vimStatusRef = useRef<HTMLDivElement | null>(null);
  const urlTypesDisposableRef = useRef<{ dispose(): void } | null>(null);
  const encodingTypesDisposableRef = useRef<{ dispose(): void } | null>(null);
  const headersTypesDisposableRef = useRef<{ dispose(): void } | null>(null);
  const structuredCloneTypesDisposableRef = useRef<{ dispose(): void } | null>(
    null,
  );
  const cryptoTypesDisposableRef = useRef<{ dispose(): void } | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);

  // Persist checkbox states
  useEffect(() => {
    save(STORAGE_KEYS.urlExt, urlExtEnabled);
  }, [urlExtEnabled]);
  useEffect(() => {
    save(STORAGE_KEYS.encodingExt, encodingExtEnabled);
  }, [encodingExtEnabled]);
  useEffect(() => {
    save(STORAGE_KEYS.headersExt, headersExtEnabled);
  }, [headersExtEnabled]);
  useEffect(() => {
    save(STORAGE_KEYS.structuredCloneExt, structuredCloneExtEnabled);
  }, [structuredCloneExtEnabled]);
  useEffect(() => {
    save(STORAGE_KEYS.cryptoExt, cryptoExtEnabled);
  }, [cryptoExtEnabled]);
  useEffect(() => {
    save(STORAGE_KEYS.vim, vimEnabled);
  }, [vimEnabled]);

  // Auto-scroll output to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  // Load WASM on mount (and URL extension binary if persisted as enabled)
  useEffect(() => {
    async function init() {
      try {
        const fetches: Promise<ArrayBuffer>[] = [
          fetch('/quickjs.wasm').then((r) => r.arrayBuffer()),
        ];
        // Pre-fetch extensions if they were enabled in a previous session
        if (urlExtEnabled && !urlExtBytesRef.current) {
          fetches.push(fetch('/url.so').then((r) => r.arrayBuffer()));
        }
        if (encodingExtEnabled && !encodingExtBytesRef.current) {
          fetches.push(fetch('/encoding.so').then((r) => r.arrayBuffer()));
        }
        if (headersExtEnabled && !headersExtBytesRef.current) {
          fetches.push(fetch('/headers.so').then((r) => r.arrayBuffer()));
        }
        if (structuredCloneExtEnabled && !structuredCloneExtBytesRef.current) {
          fetches.push(
            fetch('/structured-clone.so').then((r) => r.arrayBuffer()),
          );
        }
        if (cryptoExtEnabled && !cryptoExtBytesRef.current) {
          fetches.push(fetch('/crypto.so').then((r) => r.arrayBuffer()));
        }
        const [wasmBytes, ...extBytes] = await Promise.all(fetches);
        wasmModuleRef.current = await WebAssembly.compile(wasmBytes);
        let extIdx = 0;
        if (urlExtEnabled && !urlExtBytesRef.current && extBytes[extIdx]) {
          urlExtBytesRef.current = extBytes[extIdx++];
        }
        if (
          encodingExtEnabled &&
          !encodingExtBytesRef.current &&
          extBytes[extIdx]
        ) {
          encodingExtBytesRef.current = extBytes[extIdx++];
        }
        if (
          headersExtEnabled &&
          !headersExtBytesRef.current &&
          extBytes[extIdx]
        ) {
          headersExtBytesRef.current = extBytes[extIdx++];
        }
        if (
          structuredCloneExtEnabled &&
          !structuredCloneExtBytesRef.current &&
          extBytes[extIdx]
        ) {
          structuredCloneExtBytesRef.current = extBytes[extIdx++];
        }
        if (
          cryptoExtEnabled &&
          !cryptoExtBytesRef.current &&
          extBytes[extIdx]
        ) {
          cryptoExtBytesRef.current = extBytes[extIdx++];
        }
        setWasmReady(true);
        setStatus(
          `WASM loaded (${(wasmBytes.byteLength / 1024).toFixed(0)} KB)`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus(`Failed to load WASM: ${message}`);
        setOutput([{ type: 'error', text: `Error loading WASM: ${message}` }]);
      }
    }
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- urlExtEnabled read only for initial value

  // Vim mode: managed entirely via editorMounted + vimEnabled
  // We track editorMounted as state so this effect re-runs once the editor is ready.
  const [editorMounted, setEditorMounted] = useState(false);

  useEffect(() => {
    if (!editorRef.current) return;
    if (vimEnabled) {
      vimModeRef.current = initVimMode(editorRef.current, vimStatusRef.current);
    } else {
      vimModeRef.current?.dispose();
      vimModeRef.current = null;
    }
    return () => {
      vimModeRef.current?.dispose();
      vimModeRef.current = null;
    };
  }, [vimEnabled, editorMounted]);

  // URL extension types: add/remove type definitions in Monaco
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;

    if (urlExtEnabled) {
      // Add URL type definitions as an extra lib
      urlTypesDisposableRef.current =
        monaco.languages.typescript.javascriptDefaults.addExtraLib(
          URL_TYPE_DEFS,
          URL_TYPES_URI,
        );
    } else {
      urlTypesDisposableRef.current?.dispose();
      urlTypesDisposableRef.current = null;
    }

    return () => {
      urlTypesDisposableRef.current?.dispose();
      urlTypesDisposableRef.current = null;
    };
  }, [urlExtEnabled]);

  // Encoding extension types: add/remove type definitions in Monaco
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;

    if (encodingExtEnabled) {
      encodingTypesDisposableRef.current =
        monaco.languages.typescript.javascriptDefaults.addExtraLib(
          ENCODING_TYPE_DEFS,
          ENCODING_TYPES_URI,
        );
    } else {
      encodingTypesDisposableRef.current?.dispose();
      encodingTypesDisposableRef.current = null;
    }

    return () => {
      encodingTypesDisposableRef.current?.dispose();
      encodingTypesDisposableRef.current = null;
    };
  }, [encodingExtEnabled]);

  // Headers extension types: add/remove type definitions in Monaco
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;

    if (headersExtEnabled) {
      headersTypesDisposableRef.current =
        monaco.languages.typescript.javascriptDefaults.addExtraLib(
          HEADERS_TYPE_DEFS,
          HEADERS_TYPES_URI,
        );
    } else {
      headersTypesDisposableRef.current?.dispose();
      headersTypesDisposableRef.current = null;
    }

    return () => {
      headersTypesDisposableRef.current?.dispose();
      headersTypesDisposableRef.current = null;
    };
  }, [headersExtEnabled]);

  // structuredClone extension types: add/remove type definitions in Monaco
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;

    if (structuredCloneExtEnabled) {
      structuredCloneTypesDisposableRef.current =
        monaco.languages.typescript.javascriptDefaults.addExtraLib(
          STRUCTUREDCLONE_TYPE_DEFS,
          STRUCTUREDCLONE_TYPES_URI,
        );
    } else {
      structuredCloneTypesDisposableRef.current?.dispose();
      structuredCloneTypesDisposableRef.current = null;
    }

    return () => {
      structuredCloneTypesDisposableRef.current?.dispose();
      structuredCloneTypesDisposableRef.current = null;
    };
  }, [structuredCloneExtEnabled]);

  // Crypto extension types: add/remove type definitions in Monaco
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;

    if (cryptoExtEnabled) {
      cryptoTypesDisposableRef.current =
        monaco.languages.typescript.javascriptDefaults.addExtraLib(
          CRYPTO_TYPE_DEFS,
          CRYPTO_TYPES_URI,
        );
    } else {
      cryptoTypesDisposableRef.current?.dispose();
      cryptoTypesDisposableRef.current = null;
    }

    return () => {
      cryptoTypesDisposableRef.current?.dispose();
      cryptoTypesDisposableRef.current = null;
    };
  }, [cryptoExtEnabled]);

  // Lazily fetch the URL extension binary on first enable
  const handleUrlExtToggle = useCallback(async (checked: boolean) => {
    setUrlExtEnabled(checked);
    if (checked && !urlExtBytesRef.current) {
      try {
        const response = await fetch('/url.so');
        urlExtBytesRef.current = await response.arrayBuffer();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setOutput([
          { type: 'error', text: `Failed to load URL extension: ${message}` },
        ]);
        setUrlExtEnabled(false);
      }
    }
  }, []);

  // Lazily fetch the Encoding extension binary on first enable
  const handleEncodingExtToggle = useCallback(async (checked: boolean) => {
    setEncodingExtEnabled(checked);
    if (checked && !encodingExtBytesRef.current) {
      try {
        const response = await fetch('/encoding.so');
        encodingExtBytesRef.current = await response.arrayBuffer();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setOutput([
          {
            type: 'error',
            text: `Failed to load Encoding extension: ${message}`,
          },
        ]);
        setEncodingExtEnabled(false);
      }
    }
  }, []);

  // Lazily fetch the Headers extension binary on first enable
  const handleHeadersExtToggle = useCallback(async (checked: boolean) => {
    setHeadersExtEnabled(checked);
    if (checked && !headersExtBytesRef.current) {
      try {
        const response = await fetch('/headers.so');
        headersExtBytesRef.current = await response.arrayBuffer();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setOutput([
          {
            type: 'error',
            text: `Failed to load Headers extension: ${message}`,
          },
        ]);
        setHeadersExtEnabled(false);
      }
    }
  }, []);

  // Lazily fetch the structuredClone extension binary on first enable
  const handleStructuredCloneExtToggle = useCallback(
    async (checked: boolean) => {
      setStructuredCloneExtEnabled(checked);
      if (checked && !structuredCloneExtBytesRef.current) {
        try {
          const response = await fetch('/structured-clone.so');
          structuredCloneExtBytesRef.current = await response.arrayBuffer();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setOutput([
            {
              type: 'error',
              text: `Failed to load structuredClone extension: ${message}`,
            },
          ]);
          setStructuredCloneExtEnabled(false);
        }
      }
    },
    [],
  );

  // Lazily fetch the Crypto extension binary on first enable
  const handleCryptoExtToggle = useCallback(async (checked: boolean) => {
    setCryptoExtEnabled(checked);
    if (checked && !cryptoExtBytesRef.current) {
      try {
        const response = await fetch('/crypto.so');
        cryptoExtBytesRef.current = await response.arrayBuffer();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setOutput([
          {
            type: 'error',
            text: `Failed to load Crypto extension: ${message}`,
          },
        ]);
        setCryptoExtEnabled(false);
      }
    }
  }, []);

  // Use a ref so that the Monaco keybinding action always calls the latest
  // version of run() without needing to re-register the action on every render.
  const runRef = useRef<() => void>(() => {});

  function pushError(
    entries: OutputEntry[],
    vm: QuickJS,
    handle: JSValueHandle,
  ) {
    const dumped = vm.dump(handle);
    if (dumped instanceof Error) {
      entries.push({
        type: 'error',
        text: `${dumped.name}: ${dumped.message}`,
      });
      if (dumped.stack) entries.push({ type: 'error', text: dumped.stack });
    } else {
      entries.push({ type: 'error', text: String(dumped) });
    }
  }

  const run = useCallback(async () => {
    const code = editorRef.current?.getValue();
    if (!code) return;
    setOutput([]);
    setRunning(true);

    // Dispose the previous VM (invalidates all previous JSValueHandle references)
    if (vmRef.current) {
      vmRef.current.dispose();
      vmRef.current = null;
    }

    const entries: OutputEntry[] = [];
    const start = performance.now();

    try {
      const execStart = Date.now();
      const extensions: { name: string; wasm: Uint8Array; initFn?: string }[] =
        [];
      if (urlExtEnabled && urlExtBytesRef.current) {
        extensions.push({
          name: 'url',
          wasm: new Uint8Array(urlExtBytesRef.current),
        });
      }
      if (encodingExtEnabled && encodingExtBytesRef.current) {
        extensions.push({
          name: 'encoding',
          wasm: new Uint8Array(encodingExtBytesRef.current),
        });
      }
      if (headersExtEnabled && headersExtBytesRef.current) {
        extensions.push({
          name: 'headers',
          wasm: new Uint8Array(headersExtBytesRef.current),
        });
      }
      if (structuredCloneExtEnabled && structuredCloneExtBytesRef.current) {
        extensions.push({
          name: 'structured-clone',
          wasm: new Uint8Array(structuredCloneExtBytesRef.current),
          initFn: 'qjs_ext_structured_clone_init',
        });
      }
      if (cryptoExtEnabled && cryptoExtBytesRef.current) {
        extensions.push({
          name: 'crypto',
          wasm: new Uint8Array(cryptoExtBytesRef.current),
        });
      }
      const vm = await QuickJS.create({
        wasm: wasmModuleRef.current!,
        memoryLimit: 8 * 1024 * 1024,
        interruptHandler: () => Date.now() - execStart > 5000,
        extensions,
      });

      // Capture the values the inspector renders with *before* running any
      // user code, so patching `Date.prototype.toString`,
      // `Map.prototype[Symbol.iterator]`, etc. cannot affect (or be
      // triggered by) rendering.
      captureInspectorIntrinsics(vm);

      // Provide console.log / console.error
      {
        const log = vm.newFunction(
          'log',
          function (this: JSValueHandle, ...args: JSValueHandle[]) {
            // Dup handles so they survive after the host function returns
            const values = args.map((a) => a.dup());
            entries.push({ type: 'log', values });
            return vm.undefined;
          },
        );
        const error = vm.newFunction(
          'error',
          function (this: JSValueHandle, ...args: JSValueHandle[]) {
            const text = args
              .map((a) => vm.dump(a))
              .map(String)
              .join(' ');
            entries.push({ type: 'error', text });
            return vm.undefined;
          },
        );
        const consoleObj = vm.newObject();
        consoleObj.setProp('log', log);
        consoleObj.setProp('error', error);
        // Match browser: console is writable + configurable, but NOT enumerable
        vm.defineProp(vm.global, 'console', consoleObj, {
          writable: true,
          configurable: true,
        });
        log.dispose();
        error.dispose();
        consoleObj.dispose();
      }

      // Evaluate with ASYNC flag — result is always a Promise (supports top-level await)
      try {
        const result = vm.evalCode(code, '<eval>', EvalFlags.ASYNC);
        vm.executePendingJobs();
        const resolved = await vm.resolvePromise(result);
        result.dispose();
        vm.executePendingJobs();
        if ('value' in resolved) {
          // ASYNC flag wraps the completion value in { value: <actual> }
          // Dup the handle so it survives for the inspector to traverse
          const value = resolved.value.getProp('value');
          entries.push({ type: 'result', value });
          resolved.value.dispose();
        } else {
          pushError(entries, vm, resolved.error);
          resolved.error.dispose();
        }
      } catch (evalErr) {
        if (evalErr instanceof JSException) {
          pushError(entries, vm, evalErr.handle);
          evalErr.handle.dispose();
        } else {
          throw evalErr;
        }
      }

      const elapsed = (performance.now() - start).toFixed(1);
      setStatus(`${elapsed}ms`);

      // Keep the VM alive so the inspector can traverse JSValueHandle objects.
      vmRef.current = vm;
      setOutput(entries);
      setRunning(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entries.push({ type: 'error', text: `Host error: ${message}` });
      setStatus('Execution failed');
      setOutput(entries);
      setRunning(false);
    }
  }, [
    urlExtEnabled,
    encodingExtEnabled,
    headersExtEnabled,
    structuredCloneExtEnabled,
    cryptoExtEnabled,
  ]);

  // Keep the ref in sync with the latest run callback
  runRef.current = run;

  // Configure Monaco before it mounts: strip down to barebones JS (no DOM, no Node)
  const handleEditorWillMount: BeforeMount = useCallback((monaco) => {
    monacoRef.current = monaco;

    const jsDefaults = monaco.languages.typescript.javascriptDefaults;

    // Include core ES lib types (String, Array, Promise, Map, etc.)
    // but exclude DOM and Node types since this is a QuickJS sandbox
    jsDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2022,
      lib: ['es2022'],
      allowJs: true,
      checkJs: false,
      allowNonTsExtensions: true,
    });

    // Add console declaration (not part of ES spec, provided by our host)
    jsDefaults.addExtraLib(
      `
      declare var console: {
        log(...args: any[]): void;
        error(...args: any[]): void;
      };
      `,
      'ts:quickjs-env/globals.d.ts',
    );

    // Add DOMException (built-in QuickJS-NG intrinsic, always available)
    jsDefaults.addExtraLib(
      DOMEXCEPTION_TYPE_DEFS,
      'ts:quickjs-env/domexception.d.ts',
    );

    // Add atob/btoa + Uint8Array base64/hex types (built-in QuickJS-NG, always available)
    jsDefaults.addExtraLib(BASE64_TYPE_DEFS, BASE64_TYPES_URI);

    // If extensions were persisted as enabled, add types immediately
    if (loadBool(STORAGE_KEYS.urlExt, false)) {
      urlTypesDisposableRef.current = jsDefaults.addExtraLib(
        URL_TYPE_DEFS,
        URL_TYPES_URI,
      );
    }
    if (loadBool(STORAGE_KEYS.encodingExt, false)) {
      encodingTypesDisposableRef.current = jsDefaults.addExtraLib(
        ENCODING_TYPE_DEFS,
        ENCODING_TYPES_URI,
      );
    }
    if (loadBool(STORAGE_KEYS.headersExt, false)) {
      headersTypesDisposableRef.current = jsDefaults.addExtraLib(
        HEADERS_TYPE_DEFS,
        HEADERS_TYPES_URI,
      );
    }
    if (loadBool(STORAGE_KEYS.structuredCloneExt, false)) {
      structuredCloneTypesDisposableRef.current = jsDefaults.addExtraLib(
        STRUCTUREDCLONE_TYPE_DEFS,
        STRUCTUREDCLONE_TYPES_URI,
      );
    }
    if (loadBool(STORAGE_KEYS.cryptoExt, false)) {
      cryptoTypesDisposableRef.current = jsDefaults.addExtraLib(
        CRYPTO_TYPE_DEFS,
        CRYPTO_TYPES_URI,
      );
    }

    // Disable validation noise for a playground
    jsDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    });
  }, []);

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Cmd/Ctrl+Enter to run - calls through ref so it always uses the latest run()
    editor.addAction({
      id: 'run-code',
      label: 'Run Code',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => {
        runRef.current();
      },
    });

    // Save editor content to localStorage on change (debounced)
    let saveTimer: ReturnType<typeof setTimeout>;
    editor.onDidChangeModelContent(() => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        save(STORAGE_KEYS.code, editor.getValue());
      }, 500);
    });

    // Signal that the editor is ready so the vim effect can run
    setEditorMounted(true);
  }, []);

  const savedCode = loadString(STORAGE_KEYS.code, DEFAULT_CODE);

  return (
    <TooltipProvider delay={300}>
      <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 mb-2">
              <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 text-primary">
                <Terminal className="w-5 h-5" />
              </div>
              <h1
                className="text-2xl tracking-tight"
                style={{ fontFamily: "'Geist Pixel', monospace" }}
              >
                quickjs-wasi
              </h1>
            </div>
            <a
              href="https://github.com/vercel-labs/quickjs-wasi"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="View on GitHub"
            >
              <Github className="w-5 h-5" />
            </a>
          </div>
          <p className="text-sm text-muted-foreground">
            QuickJS running in the browser via WebAssembly
          </p>
        </div>

        {/* Editor Card */}
        <div className="rounded-xl border border-border bg-card overflow-hidden shadow-lg">
          {/* Editor Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card/80">
            <span className="text-sm font-medium text-muted-foreground">
              Editor
            </span>
            <div className="flex items-center gap-4">
              {/* Vim Toggle */}
              <Tooltip>
                <TooltipTrigger>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={vimEnabled}
                      onCheckedChange={setVimEnabled}
                      aria-label="Enable Vim mode"
                    />
                    <label
                      className="text-xs text-muted-foreground cursor-pointer select-none"
                      onClick={() => setVimEnabled(!vimEnabled)}
                    >
                      Vim
                    </label>
                  </div>
                </TooltipTrigger>
                <TooltipContent>Enable Vim keybindings</TooltipContent>
              </Tooltip>
              <span className="text-xs text-muted-foreground/60 hidden sm:inline">
                {navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}+Enter
                to run
              </span>
            </div>
          </div>

          {/* Monaco Editor */}
          <Editor
            height="280px"
            defaultLanguage="javascript"
            defaultValue={savedCode}
            theme="vs-dark"
            beforeMount={handleEditorWillMount}
            onMount={handleEditorMount}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: "'Geist Mono', 'SF Mono', 'Fira Code', monospace",
              fontLigatures: true,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              padding: { top: 12, bottom: 12 },
              renderLineHighlight: 'none',
              overviewRulerLanes: 0,
              hideCursorInOverviewRuler: true,
              overviewRulerBorder: false,
              scrollbar: {
                vertical: 'hidden',
                horizontal: 'hidden',
              },
              tabSize: 2,
              wordWrap: 'on',
              automaticLayout: true,
            }}
          />

          {/* Vim status bar (hidden unless vim mode enabled) */}
          <div
            ref={vimStatusRef}
            className={`px-4 py-1 font-mono text-xs text-muted-foreground border-t border-border bg-background ${vimEnabled ? '' : 'hidden'}`}
          />

          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-t border-border bg-card/80">
            <Button
              onClick={run}
              disabled={!wasmReady || running}
              size="sm"
              className="gap-1.5"
            >
              {running ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              {wasmReady ? 'Run' : 'Loading...'}
            </Button>

            {/* Divider */}
            <div className="h-5 w-px bg-border" />

            {/* Extension toggles */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <ExtensionToggle
                checked={structuredCloneExtEnabled}
                onToggle={handleStructuredCloneExtToggle}
                icon={Copy}
                label="Clone"
                tooltip={
                  <>
                    Adds{' '}
                    <MdnLink path="Window/structuredClone">
                      structuredClone()
                    </MdnLink>
                  </>
                }
              />
              <ExtensionToggle
                checked={encodingExtEnabled}
                onToggle={handleEncodingExtToggle}
                icon={Type}
                label="Encoding"
                tooltip={
                  <>
                    Adds <MdnLink path="TextEncoder">TextEncoder</MdnLink> and{' '}
                    <MdnLink path="TextDecoder">TextDecoder</MdnLink>
                  </>
                }
              />
              <ExtensionToggle
                checked={headersExtEnabled}
                onToggle={handleHeadersExtToggle}
                icon={FileText}
                label="Headers"
                tooltip={
                  <>
                    Adds the <MdnLink path="Headers">Headers</MdnLink> class
                  </>
                }
              />
              <ExtensionToggle
                checked={urlExtEnabled}
                onToggle={handleUrlExtToggle}
                icon={Globe}
                label="URL"
                tooltip={
                  <>
                    Adds <MdnLink path="URL">URL</MdnLink> and{' '}
                    <MdnLink path="URLSearchParams">URLSearchParams</MdnLink>
                  </>
                }
              />
              <ExtensionToggle
                checked={cryptoExtEnabled}
                onToggle={handleCryptoExtToggle}
                icon={Lock}
                label="Crypto"
                tooltip={
                  <>
                    Adds <MdnLink path="Crypto">crypto</MdnLink> and{' '}
                    <MdnLink path="SubtleCrypto">SubtleCrypto</MdnLink>
                  </>
                }
              />
            </div>

            {/* Spacer + status */}
            <div className="flex-1" />
            {status && (
              <Badge
                variant="secondary"
                className="text-[10px] font-mono shrink-0"
              >
                {status}
              </Badge>
            )}
          </div>
        </div>

        {/* Output */}
        {output.length > 0 && (
          <div className="mt-4 rounded-xl border border-border bg-card overflow-hidden shadow-lg">
            <div className="px-4 py-2.5 border-b border-border bg-card/80">
              <span className="text-sm font-medium text-muted-foreground">
                Output
              </span>
            </div>
            <div
              ref={outputRef}
              className="p-4 font-mono text-[13px] leading-relaxed max-h-96 overflow-y-auto"
            >
              {output.map((entry, i) => (
                <OutputEntryView key={i} entry={entry} />
              ))}
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById('app')!).render(<App />);
