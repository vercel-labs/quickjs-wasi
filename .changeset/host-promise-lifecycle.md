---
"quickjs-wasi": patch
---

Terminate the VM and reject its host Promise observers when automatic host-Promise settlement or draining fails. Preserve the original host failure, ignore late completions after disposal, and keep private resolver handles alive across scope exit. Ordinary guest rejection remains a resolved error result; synchronous failures and `interruptHandler` interrupts remain recoverable.

`executePendingJobs()` now throws the job's original exception as a `JSException` (for example, message `interrupted`) instead of a plain `Error` with a `Job execution error: ...` message.
