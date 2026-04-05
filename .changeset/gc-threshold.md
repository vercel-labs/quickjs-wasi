---
"quickjs-wasi": minor
---

Add `vm.gcThreshold` getter/setter for controlling when automatic garbage collection triggers. When allocated memory exceeds the threshold, GC runs automatically. Set to 0 to disable.
