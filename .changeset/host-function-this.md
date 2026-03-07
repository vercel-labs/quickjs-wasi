---
"quickjs-wasi": minor
---

**Breaking:** `HostFunction` type now uses TypeScript's `this` parameter instead of a leading `_this` argument. The `this` value from QuickJS is bound as the native `this` of the callback.

Before:
```typescript
vm.newFunction('add', (_this, ...args) => {
  return vm.newNumber(args[0].toNumber() + args[1].toNumber());
});
```

After:
```typescript
vm.newFunction('add', (...args) => {
  return vm.newNumber(args[0].toNumber() + args[1].toNumber());
});
```

To access `this`, use a regular function declaration:
```typescript
vm.newFunction('method', function (...args) {
  // `this` is the JSValueHandle for the QuickJS `this` value
  return this.getProp('name');
});
```
