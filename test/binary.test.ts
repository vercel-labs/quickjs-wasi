import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('ArrayBuffer', () => {
  it('should create an ArrayBuffer from host data', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using ab = vm.newArrayBuffer(new Uint8Array([1, 2, 3, 4]).buffer);
    vm.setProp(vm.global, 'buf', ab);
    expect(vm.evalCode('buf instanceof ArrayBuffer').consume(h => vm.dump(h))).toBe(true);
    expect(vm.evalCode('buf.byteLength').consume(h => vm.dump(h))).toBe(4);
  });

  it('should accept Uint8Array as input to newArrayBuffer', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using ab = vm.newArrayBuffer(new Uint8Array([10, 20, 30]));
    vm.setProp(vm.global, 'buf', ab);
    expect(vm.evalCode('buf.byteLength').consume(h => vm.dump(h))).toBe(3);
    expect(vm.evalCode('new Uint8Array(buf)[0]').consume(h => vm.dump(h))).toBe(10);
  });

  it('should extract an ArrayBuffer to host', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using ab = vm.evalCode('new ArrayBuffer(4)');
    const hostBuf = ab.toArrayBuffer();
    expect(hostBuf).toBeInstanceOf(ArrayBuffer);
    expect(hostBuf.byteLength).toBe(4);
  });

  it('should round-trip ArrayBuffer data', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const original = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    using ab = vm.newArrayBuffer(original);
    vm.setProp(vm.global, 'buf', ab);

    // Modify in QuickJS
    vm.evalCode('new Uint8Array(buf)[1] = 0xFF').dispose();

    // Read back
    using result = vm.evalCode('buf');
    const hostBuf = new Uint8Array(result.toArrayBuffer());
    expect(hostBuf[0]).toBe(0xDE);
    expect(hostBuf[1]).toBe(0xFF); // modified
    expect(hostBuf[2]).toBe(0xBE);
    expect(hostBuf[3]).toBe(0xEF);
  });

  it('should dump() ArrayBuffer values', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using ab = vm.evalCode('new ArrayBuffer(3)');
    const dumped = vm.dump(ab);
    expect(dumped).toBeInstanceOf(ArrayBuffer);
    expect((dumped as ArrayBuffer).byteLength).toBe(3);
  });
});

describe('Uint8Array', () => {
  it('should create a Uint8Array from host data', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using u8 = vm.newUint8Array(new Uint8Array([5, 6, 7]));
    vm.setProp(vm.global, 'arr', u8);
    expect(vm.evalCode('arr instanceof Uint8Array').consume(h => vm.dump(h))).toBe(true);
    expect(vm.evalCode('arr.length').consume(h => vm.dump(h))).toBe(3);
    expect(vm.evalCode('arr[0]').consume(h => vm.dump(h))).toBe(5);
    expect(vm.evalCode('arr[2]').consume(h => vm.dump(h))).toBe(7);
  });

  it('should extract a Uint8Array to host', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using u8 = vm.evalCode('new Uint8Array([10, 20, 30])');
    const hostArr = u8.toUint8Array();
    expect(hostArr).toBeInstanceOf(Uint8Array);
    expect(Array.from(hostArr)).toEqual([10, 20, 30]);
  });

  it('should round-trip Uint8Array data', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const original = new Uint8Array([1, 2, 3, 4, 5]);
    using u8 = vm.newUint8Array(original);
    vm.setProp(vm.global, 'arr', u8);

    // Reverse in QuickJS
    vm.evalCode('arr.reverse()').dispose();

    // Read back
    using result = vm.evalCode('arr');
    const hostArr = result.toUint8Array();
    expect(Array.from(hostArr)).toEqual([5, 4, 3, 2, 1]);
  });

  it('should dump() Uint8Array values', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using u8 = vm.evalCode('new Uint8Array([1, 2, 3])');
    const dumped = vm.dump(u8);
    expect(dumped).toBeInstanceOf(Uint8Array);
    expect(Array.from(dumped as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('should handle empty Uint8Array', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using u8 = vm.newUint8Array(new Uint8Array(0));
    vm.setProp(vm.global, 'arr', u8);
    expect(vm.evalCode('arr.length').consume(h => vm.dump(h))).toBe(0);
    const hostArr = u8.toUint8Array();
    expect(hostArr.length).toBe(0);
  });

  it('should handle large Uint8Array', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const large = new Uint8Array(65536);
    for (let i = 0; i < large.length; i++) large[i] = i & 0xFF;
    using u8 = vm.newUint8Array(large);
    vm.setProp(vm.global, 'arr', u8);
    expect(vm.evalCode('arr.length').consume(h => vm.dump(h))).toBe(65536);
    expect(vm.evalCode('arr[0]').consume(h => vm.dump(h))).toBe(0);
    expect(vm.evalCode('arr[255]').consume(h => vm.dump(h))).toBe(255);
    expect(vm.evalCode('arr[256]').consume(h => vm.dump(h))).toBe(0);
  });
});

describe('hostToHandle with binary data', () => {
  it('should convert ArrayBuffer via hostToHandle', async () => {
    using vm = await QuickJS.create(wasmBytes);
    const buf = new ArrayBuffer(4);
    new Uint8Array(buf).set([1, 2, 3, 4]);
    using handle = vm.hostToHandle(buf);
    vm.setProp(vm.global, 'buf', handle);
    expect(vm.evalCode('buf instanceof ArrayBuffer').consume(h => vm.dump(h))).toBe(true);
    expect(vm.evalCode('new Uint8Array(buf)[2]').consume(h => vm.dump(h))).toBe(3);
  });

  it('should convert Uint8Array via hostToHandle', async () => {
    using vm = await QuickJS.create(wasmBytes);
    using handle = vm.hostToHandle(new Uint8Array([10, 20, 30]));
    vm.setProp(vm.global, 'arr', handle);
    expect(vm.evalCode('arr instanceof Uint8Array').consume(h => vm.dump(h))).toBe(true);
    expect(vm.evalCode('arr[1]').consume(h => vm.dump(h))).toBe(20);
  });
});
