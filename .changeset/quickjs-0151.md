---
'quickjs-wasi': patch
---

Update QuickJS-ng from v0.15.0 to v0.15.1. This is an upstream bug-fix release: uncaught error dumps now walk the `cause` chain, and growable `SharedArrayBuffer`s are rejected when no SAB hooks are configured. No public API changes.
