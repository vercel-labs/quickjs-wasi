---
'quickjs-wasi': patch
---

Exceeding `memoryLimit` throws `InternalError: out of memory` again instead of a bare `null` (regression in 3.3.1): the limit is now enforced in the WASI malloc layer, which reserves headroom below the limit so the OOM error object can always be constructed.
