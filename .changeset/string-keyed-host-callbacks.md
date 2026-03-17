---
"quickjs-wasi": major
---

Replace opaque integer callback IDs with string names for host callbacks. `registerHostCallback()` now takes the function name instead of a numeric ID, making restore order-independent and self-documenting. `newFunction()` enforces unique names to prevent silent conflicts.
