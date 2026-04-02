---
"quickjs-wasi": minor
---

Add introspection methods to `JSValueHandle` for inspecting QuickJS values without dumping them to host values. New type-checking getters: `isBool`, `isNumber`, `isString`, `isSymbol`, `isBigInt`, `isObject`, `isArray`, `isFunction`, `isError`, `isPromise`, `isArrayBuffer`. New convenience properties: `typeof`, `length`, `constructorName`. New methods: `keys()`, `getOwnPropertyNames()`, `hasOwnProperty()`, `propertyIsEnumerable()`, `getPrototypeOf()`.
