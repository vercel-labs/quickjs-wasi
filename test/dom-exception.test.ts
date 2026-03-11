import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const domExcExtBytes = readFileSync(resolve(__dirname, '..', 'extensions', 'dom-exception', 'dom-exception.so'));

async function createVM() {
  return QuickJS.create({
    wasm: wasmBytes,
    extensions: [{ name: 'dom-exception', wasm: domExcExtBytes, initFn: 'qjs_ext_dom_exception_init' }],
  });
}

async function evalStr(code: string) {
  using vm = await createVM();
  const result = vm.evalCode(code);
  const str = result.toString();
  result.dispose();
  return str;
}

async function evalJSON(code: string) {
  using vm = await createVM();
  const result = vm.evalCode(`JSON.stringify(${code})`);
  const parsed = JSON.parse(result.toString());
  result.dispose();
  return parsed;
}

describe('DOMException constructor', () => {
  it('should be available as a global constructor', async () => {
    expect(await evalStr('typeof DOMException')).toBe('function');
  });

  it('should have constructor.name === "DOMException"', async () => {
    expect(await evalStr('new DOMException().constructor.name')).toBe('DOMException');
  });

  it('should default message to empty string', async () => {
    expect(await evalStr('new DOMException().message')).toBe('');
  });

  it('should default name to "Error"', async () => {
    expect(await evalStr('new DOMException().name')).toBe('Error');
  });

  it('should accept message argument', async () => {
    expect(await evalStr("new DOMException('test msg').message")).toBe('test msg');
  });

  it('should accept name argument', async () => {
    expect(await evalStr("new DOMException('msg', 'NotFoundError').name")).toBe('NotFoundError');
  });

  it('should accept message and name', async () => {
    const r = await evalJSON(`
      (() => {
        var e = new DOMException('bad', 'InvalidStateError');
        return { name: e.name, message: e.message, code: e.code };
      })()
    `);
    expect(r.name).toBe('InvalidStateError');
    expect(r.message).toBe('bad');
    expect(r.code).toBe(11);
  });
});

describe('DOMException prototype chain', () => {
  it('should be an instance of DOMException', async () => {
    expect(await evalStr('new DOMException() instanceof DOMException ? "true" : "false"')).toBe('true');
  });

  it('should be an instance of Error', async () => {
    expect(await evalStr('new DOMException() instanceof Error ? "true" : "false"')).toBe('true');
  });

  it('should have stack property', async () => {
    expect(await evalStr("typeof new DOMException().stack")).toBe('string');
  });
});

describe('DOMException.code', () => {
  const codeTests: [string, number][] = [
    ['IndexSizeError', 1],
    ['HierarchyRequestError', 3],
    ['WrongDocumentError', 4],
    ['InvalidCharacterError', 5],
    ['NoModificationAllowedError', 7],
    ['NotFoundError', 8],
    ['NotSupportedError', 9],
    ['InUseAttributeError', 10],
    ['InvalidStateError', 11],
    ['SyntaxError', 12],
    ['InvalidModificationError', 13],
    ['NamespaceError', 14],
    ['InvalidAccessError', 15],
    ['TypeMismatchError', 17],
    ['SecurityError', 18],
    ['NetworkError', 19],
    ['AbortError', 20],
    ['URLMismatchError', 21],
    ['QuotaExceededError', 22],
    ['TimeoutError', 23],
    ['InvalidNodeTypeError', 24],
    ['DataCloneError', 25],
  ];

  for (const [name, code] of codeTests) {
    it(`${name} should have code ${code}`, async () => {
      expect(await evalStr(`new DOMException('', '${name}').code`)).toBe(String(code));
    });
  }

  it('should return 0 for unknown names', async () => {
    expect(await evalStr("new DOMException('', 'UnknownError').code")).toBe('0');
  });

  it('should return 0 for default name "Error"', async () => {
    expect(await evalStr('new DOMException().code')).toBe('0');
  });

  it('should return 0 for newer error names without legacy codes', async () => {
    expect(await evalStr("new DOMException('', 'NotAllowedError').code")).toBe('0');
  });
});

describe('DOMException legacy constants', () => {
  const constants: [string, number][] = [
    ['INDEX_SIZE_ERR', 1],
    ['DOMSTRING_SIZE_ERR', 2],
    ['HIERARCHY_REQUEST_ERR', 3],
    ['WRONG_DOCUMENT_ERR', 4],
    ['INVALID_CHARACTER_ERR', 5],
    ['NO_DATA_ALLOWED_ERR', 6],
    ['NO_MODIFICATION_ALLOWED_ERR', 7],
    ['NOT_FOUND_ERR', 8],
    ['NOT_SUPPORTED_ERR', 9],
    ['INUSE_ATTRIBUTE_ERR', 10],
    ['INVALID_STATE_ERR', 11],
    ['SYNTAX_ERR', 12],
    ['INVALID_MODIFICATION_ERR', 13],
    ['NAMESPACE_ERR', 14],
    ['INVALID_ACCESS_ERR', 15],
    ['VALIDATION_ERR', 16],
    ['TYPE_MISMATCH_ERR', 17],
    ['SECURITY_ERR', 18],
    ['NETWORK_ERR', 19],
    ['ABORT_ERR', 20],
    ['URL_MISMATCH_ERR', 21],
    ['QUOTA_EXCEEDED_ERR', 22],
    ['TIMEOUT_ERR', 23],
    ['INVALID_NODE_TYPE_ERR', 24],
    ['DATA_CLONE_ERR', 25],
  ];

  for (const [name, value] of constants) {
    it(`DOMException.${name} === ${value}`, async () => {
      expect(await evalStr(`DOMException.${name}`)).toBe(String(value));
    });

    it(`DOMException.prototype.${name} === ${value}`, async () => {
      expect(await evalStr(`DOMException.prototype.${name}`)).toBe(String(value));
    });

    it(`instance.${name} === ${value}`, async () => {
      expect(await evalStr(`new DOMException().${name}`)).toBe(String(value));
    });
  }
});

describe('DOMException.toString()', () => {
  it('should return "Name: message" format', async () => {
    expect(await evalStr("new DOMException('bad thing', 'NotFoundError').toString()")).toBe('NotFoundError: bad thing');
  });

  it('should return just name for empty message', async () => {
    expect(await evalStr("new DOMException('', 'TypeError').toString()")).toBe('TypeError');
  });

  it('should return "Error" for defaults', async () => {
    expect(await evalStr('new DOMException().toString()')).toBe('Error');
  });
});

describe('DOMException used with base64 extension', () => {
  it('btoa should throw DOMException when both extensions loaded', async () => {
    const base64ExtBytes = readFileSync(resolve(__dirname, '..', 'extensions', 'base64', 'base64.so'));
    using vm = await QuickJS.create({
      wasm: wasmBytes,
      extensions: [
        { name: 'dom-exception', wasm: domExcExtBytes, initFn: 'qjs_ext_dom_exception_init' },
        { name: 'base64', wasm: base64ExtBytes },
      ],
    });

    const r = vm.evalCode(`
      try {
        btoa('\\u0100');
        'no error';
      } catch(e) {
        JSON.stringify({
          isDOMException: e instanceof DOMException,
          name: e.name,
          code: e.code,
        });
      }
    `);
    const parsed = JSON.parse(r.toString());
    r.dispose();
    expect(parsed.isDOMException).toBe(true);
    expect(parsed.name).toBe('InvalidCharacterError');
    expect(parsed.code).toBe(5);
  });
});
