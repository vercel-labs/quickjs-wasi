---
"quickjs-wasi": patch
---

Release both deferred promise resolvers after the first settlement so the unused resolver does not retain the promise and its payload until VM disposal.
