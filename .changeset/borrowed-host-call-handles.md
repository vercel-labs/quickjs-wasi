---
'quickjs-wasi': patch
---

Host-callback `this`/argument handles are now "borrowed": exempt from `withScope()` tracking and `dispose()` is a no-op. Their pointers are owned by the C trampoline (which frees them after the call returns), so a scope active around guest execution — or an explicit dispose inside a callback — previously double-freed the guest values and corrupted the heap. Callbacks retain arguments past their invocation via `dup()`, which takes an owned reference and behaves normally.
