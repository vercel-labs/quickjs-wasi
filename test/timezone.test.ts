import { describe, it, expect } from 'vitest';
import { QuickJS } from '../src/index.ts';
import { wasmBytes } from './helpers.ts';

describe('timezoneOffset option', () => {
  describe('default (host timezone)', () => {
    it('should match the host getTimezoneOffset()', async () => {
      using vm = await QuickJS.create({ wasm: wasmBytes });
      using result = vm.evalCode('new Date().getTimezoneOffset()');
      expect(result.toNumber()).toBe(new Date().getTimezoneOffset());
    });

    it('should produce correct local time strings', async () => {
      using vm = await QuickJS.create({ wasm: wasmBytes });
      // Compare getHours() for a known UTC time
      using result = vm.evalCode('new Date("2025-06-15T12:00:00Z").getHours()');
      const expected = new Date('2025-06-15T12:00:00Z').getHours();
      expect(result.toNumber()).toBe(expected);
    });
  });

  describe('fixed offset (number)', () => {
    it('should return 0 for UTC', async () => {
      using vm = await QuickJS.create({ wasm: wasmBytes, timezoneOffset: 0 });
      using result = vm.evalCode('new Date().getTimezoneOffset()');
      expect(result.toNumber()).toBe(0);
    });

    it('should return 480 for UTC-8', async () => {
      using vm = await QuickJS.create({ wasm: wasmBytes, timezoneOffset: 480 });
      using result = vm.evalCode('new Date().getTimezoneOffset()');
      expect(result.toNumber()).toBe(480);
    });

    it('should return -60 for UTC+1', async () => {
      using vm = await QuickJS.create({ wasm: wasmBytes, timezoneOffset: -60 });
      using result = vm.evalCode('new Date().getTimezoneOffset()');
      expect(result.toNumber()).toBe(-60);
    });

    it('should return -540 for UTC+9 (Tokyo)', async () => {
      using vm = await QuickJS.create({ wasm: wasmBytes, timezoneOffset: -540 });
      using result = vm.evalCode('new Date().getTimezoneOffset()');
      expect(result.toNumber()).toBe(-540);
    });

    it('should return 330 for UTC-5:30', async () => {
      using vm = await QuickJS.create({ wasm: wasmBytes, timezoneOffset: 330 });
      using result = vm.evalCode('new Date().getTimezoneOffset()');
      expect(result.toNumber()).toBe(330);
    });

    it('should affect getHours() for UTC-8', async () => {
      using vm = await QuickJS.create({ wasm: wasmBytes, timezoneOffset: 480 });
      // Midnight UTC -> 4pm previous day in UTC-8
      using result = vm.evalCode('new Date("2025-01-15T00:00:00Z").getHours()');
      expect(result.toNumber()).toBe(16);
    });

    it('should affect getHours() for UTC+9', async () => {
      using vm = await QuickJS.create({ wasm: wasmBytes, timezoneOffset: -540 });
      // Midnight UTC -> 9am same day in UTC+9
      using result = vm.evalCode('new Date("2025-01-15T00:00:00Z").getHours()');
      expect(result.toNumber()).toBe(9);
    });

    it('should affect toString() output', async () => {
      using vm = await QuickJS.create({ wasm: wasmBytes, timezoneOffset: 480 });
      using result = vm.evalCode('new Date("2025-01-15T00:00:00Z").toString()');
      const str = result.toString();
      expect(str).toContain('GMT-0800');
      expect(str).toContain('Jan 14 2025');
      expect(str).toContain('16:00:00');
    });

    it('should affect Date constructor with local time components', async () => {
      using vm = await QuickJS.create({ wasm: wasmBytes, timezoneOffset: 0 });
      // new Date(2025, 0, 15, 12, 0, 0) uses local time; with UTC offset it should equal UTC noon
      using result = vm.evalCode('new Date(2025, 0, 15, 12, 0, 0).toISOString()');
      expect(result.toString()).toBe('2025-01-15T12:00:00.000Z');
    });
  });

  describe('callback', () => {
    it('should use the callback return value as the offset in minutes', async () => {
      using vm = await QuickJS.create({ wasm: wasmBytes, timezoneOffset: () => 300 });
      using result = vm.evalCode('new Date().getTimezoneOffset()');
      expect(result.toNumber()).toBe(300);
    });

    it('should pass the time in seconds to the callback', async () => {
      const calls: number[] = [];
      using vm = await QuickJS.create({
        wasm: wasmBytes,
        timezoneOffset: (timeSecs: number) => {
          calls.push(timeSecs);
          return 0;
        },
      });
      using result = vm.evalCode('new Date(1700000000000).getTimezoneOffset()');
      expect(result.toNumber()).toBe(0);
      // The callback should have been invoked with time around the queried date
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.some(t => Math.abs(t - 1700000000) < 86400)).toBe(true);
    });

    it('should support negative offsets from callback', async () => {
      using vm = await QuickJS.create({ wasm: wasmBytes, timezoneOffset: () => -540 });
      using result = vm.evalCode('new Date().getTimezoneOffset()');
      expect(result.toNumber()).toBe(-540);
    });
  });
});
