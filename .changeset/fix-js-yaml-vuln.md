---
---

Resolve the remaining Dependabot advisory (js-yaml quadratic-complexity DoS,
GHSA-h67p-54hq-rp68) by overriding the transitive `read-yaml-file` dependency
to `^2.1.0`, which uses the patched `js-yaml@4` while keeping the same CJS API
that `@manypkg/get-packages` (a `@changesets/cli` dependency) relies on. This is
a repo-only tooling change and does not affect the published package.
