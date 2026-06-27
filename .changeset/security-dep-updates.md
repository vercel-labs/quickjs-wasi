---
"quickjs-wasi": patch
---

Resolve Dependabot security advisories by updating dev/demo dependencies and
adding pnpm `overrides` for transitive packages pinned to vulnerable versions.
Also move the repo-only pnpm configuration (`overrides`, `onlyBuiltDependencies`)
out of `package.json` and into `pnpm-workspace.yaml` so it is no longer included
in the published package. The published artifact has no JS dependencies, so this
does not affect consumers at runtime.
