---
"quickjs-wasi": minor
---

Add `JSException` class that extends `Error` and is thrown by `unwrapResult()`. It exposes a `handle` property — a live `JSValueHandle` to the QuickJS exception value — allowing direct inspection of custom properties on the thrown error. Also fixes a bug where errors thrown from host callbacks were returned as regular values instead of being propagated as QuickJS exceptions.
