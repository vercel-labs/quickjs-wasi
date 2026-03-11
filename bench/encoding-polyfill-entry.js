// Bundle entry point: fast-text-encoding polyfill
// fast-text-encoding assigns to `window`, `global`, or `exports`.
// In QuickJS none of those exist, so we set up `global` as an alias
// for `globalThis` before loading the polyfill.
globalThis.global = globalThis;
require("fast-text-encoding");
