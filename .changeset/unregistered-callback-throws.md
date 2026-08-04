---
'quickjs-wasi': patch
---

Calling a guest function whose host callback is not registered now throws inside the guest (catchable, or surfaced as a host exception when uncaught), as the `newEphemeralFunction` and `unregisterHostCallback` docs already promised — previously it silently returned `undefined`, masking bugs like un-re-registered callbacks after a snapshot restore.
