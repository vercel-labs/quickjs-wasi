---
'quickjs-wasi': minor
---

Add `handle.className`: the engine-level class name of a value (e.g. `"Map"`, `"Date"`, `"URL"`) read trap-free from the class table — unlike `constructorName`, it executes no guest code and cannot be spoofed by prototype/constructor reassignment.
