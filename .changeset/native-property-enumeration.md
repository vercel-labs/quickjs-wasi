---
"quickjs-wasi": patch
---

Replace JSON.stringify hack in `dump()` with native property enumeration via `JS_GetOwnPropertyNames`. Handles circular references gracefully (returns `undefined`). Functions now dump as `undefined` instead of empty objects.
