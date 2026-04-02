---
"quickjs-wasi": minor
---

Add `timezoneOffset` option to `QuickJS.create()` for configuring the timezone used by `Date` inside the sandbox. Defaults to `'host'` which mirrors the host environment's timezone. Can also be set to a fixed offset in minutes or a callback for DST-aware logic.
