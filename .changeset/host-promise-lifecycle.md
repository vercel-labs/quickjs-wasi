---
"quickjs-wasi": patch
---

Terminate the VM and reject its host Promise observers when automatic host-Promise settlement or draining fails. Preserve the original host failure, ignore late completions after disposal, and keep private resolver handles alive across scope exit. Ordinary guest rejection remains a resolved error result; synchronous failures remain recoverable.
