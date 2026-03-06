---
"quickjs-wasi": patch
---

Fix handle leaks on VM dispose: free cached singleton handles and internally-owned handles (unresolved promise resolve/reject functions). Make `Deferred.settled` lazy to avoid unnecessary QuickJS object allocation.
