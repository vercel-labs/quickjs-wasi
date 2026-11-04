---
"quickjs-wasi": patch
---

Propagate guest allocation and property write exceptions from host data construction instead of returning exception handles or partially populated values. Release partial conversions and preserve native exceptions across host callbacks, module loaders, and handle-scope boundaries.
