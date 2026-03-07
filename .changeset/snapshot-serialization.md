---
"quickjs-wasi": minor
---

Add `QuickJS.serializeSnapshot()` and `QuickJS.deserializeSnapshot()` for converting snapshots to/from a versioned binary format suitable for persistent storage (S3, databases, etc.). The format includes a magic header and version number for forward compatibility. Apply your own compression (gzip, zstd) on top for best results.
