/**
 * Minimal WASI shim for running QuickJS in any WebAssembly environment.
 *
 * Only implements the subset of WASI snapshot_preview1 that QuickJS actually uses:
 *   - clock_time_get (for Date.now())
 *   - fd_write (for console output via printf/fprintf)
 *   - fd_close (stub)
 *   - fd_fdstat_get (stub)
 *   - fd_seek (stub)
 *   - random_get (for Math.random / crypto.getRandomValues)
 */

/** Returns a wasi_snapshot_preview1 import object for WASM instantiation. */
export function createWasiShim(memoryAccessor: () => WebAssembly.Memory) {
  // WASI error codes
  const ERRNO_SUCCESS = 0;
  const ERRNO_BADF = 8;
  const ERRNO_NOSYS = 52;

  // Clock IDs
  const CLOCK_REALTIME = 0;
  const CLOCK_MONOTONIC = 1;

  return {
    clock_time_get(clockId: number, _precision: bigint, resultPtr: number): number {
      const mem = memoryAccessor();
      const view = new DataView(mem.buffer);
      let timeNs: bigint;
      if (clockId === CLOCK_REALTIME) {
        timeNs = BigInt(Date.now()) * 1_000_000n;
      } else if (clockId === CLOCK_MONOTONIC) {
        // Use Date.now() as a fallback for monotonic clock
        // (performance.now() isn't available in all contexts)
        timeNs = BigInt(Date.now()) * 1_000_000n;
      } else {
        return ERRNO_NOSYS;
      }
      view.setBigUint64(resultPtr, timeNs, true);
      return ERRNO_SUCCESS;
    },

    fd_write(fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
      const mem = memoryAccessor();
      const view = new DataView(mem.buffer);
      const bytes = new Uint8Array(mem.buffer);
      let totalWritten = 0;

      for (let i = 0; i < iovsLen; i++) {
        const bufPtr = view.getUint32(iovsPtr + i * 8, true);
        const bufLen = view.getUint32(iovsPtr + i * 8 + 4, true);
        const chunk = bytes.slice(bufPtr, bufPtr + bufLen);
        const text = new TextDecoder().decode(chunk);

        if (fd === 1) {
          // stdout
          if (typeof process !== 'undefined' && process.stdout) {
            process.stdout.write(text);
          } else {
            console.log(text);
          }
        } else if (fd === 2) {
          // stderr
          if (typeof process !== 'undefined' && process.stderr) {
            process.stderr.write(text);
          } else {
            console.error(text);
          }
        } else {
          return ERRNO_BADF;
        }
        totalWritten += bufLen;
      }

      view.setUint32(nwrittenPtr, totalWritten, true);
      return ERRNO_SUCCESS;
    },

    fd_close(_fd: number): number {
      return ERRNO_NOSYS;
    },

    fd_fdstat_get(fd: number, statPtr: number): number {
      const mem = memoryAccessor();
      const view = new DataView(mem.buffer);
      // Fill in a minimal fdstat structure
      // filetype: FILETYPE_CHARACTER_DEVICE (2) for stdout/stderr
      if (fd === 1 || fd === 2) {
        view.setUint8(statPtr, 2); // fs_filetype = CHARACTER_DEVICE
        view.setUint16(statPtr + 2, 0, true); // fs_flags
        view.setBigUint64(statPtr + 8, 0n, true); // fs_rights_base
        view.setBigUint64(statPtr + 16, 0n, true); // fs_rights_inheriting
        return ERRNO_SUCCESS;
      }
      return ERRNO_BADF;
    },

    fd_seek(_fd: number, _offset: bigint, _whence: number, _resultPtr: number): number {
      return ERRNO_NOSYS;
    },

    random_get(bufPtr: number, bufLen: number): number {
      const mem = memoryAccessor();
      const bytes = new Uint8Array(mem.buffer, bufPtr, bufLen);
      // Use crypto.getRandomValues if available (works in browsers and modern Node.js)
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(bytes);
      } else {
        // Fallback: pseudo-random (not cryptographically secure)
        for (let i = 0; i < bufLen; i++) {
          bytes[i] = Math.floor(Math.random() * 256);
        }
      }
      return ERRNO_SUCCESS;
    },
  };
}
