---
'quickjs-wasi': minor
---

Add trap-free introspection primitives: `isProxy`, `isMap`, `isSet`, `isDate`, `isRegExp`, `isWeakRef`, `isWeakMap`, `isWeakSet`, `isDataView`, and `classId` brand checks; `getProxyTarget()`/`getProxyHandler()` for trap-free Proxy internals access; `getOwnPropertyKeys()` (Reflect.ownKeys semantics, string + symbol keys); and `getOwnPropertyDescriptor()` which reads property descriptors without invoking getters. All primitives are engine-level checks that never execute guest code and cannot be spoofed by prototype/constructor mutation.
