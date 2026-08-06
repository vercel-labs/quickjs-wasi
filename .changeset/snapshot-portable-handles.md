---
'quickjs-wasi': minor
---

`vm.exportHandle(handle)` / `vm.importHandle(token)`: turn a live handle into a snapshot-portable token and re-materialize it — on the same VM or on any VM restored from a snapshot taken while the handle was alive. Enables boot-time capture of pristine intrinsics before user code runs, without re-executing capture code in restored VMs.
