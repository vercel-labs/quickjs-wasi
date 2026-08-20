---
'quickjs-wasi': patch
---

`memoryLimit` exhaustion throws `InternalError: out of memory` again instead of a bare `null` (regression in 3.3.1). Once allocation accounting became real, a guest at the limit left no room for the engine to allocate the "out of memory" InternalError itself, so quickjs fell back to throwing `JS_NULL` — in-guest `catch (e)` received `null` and the host `JSException` had name/message `"<null>"`. The limit is now enforced in the WASI malloc layer with reserved headroom below `memoryLimit` for constructing (and inspecting) the OOM error; the configured `memoryLimit` remains a hard ceiling.
