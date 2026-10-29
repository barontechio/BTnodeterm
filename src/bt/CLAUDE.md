# Working in src/bt (BTnodeterm fork)

Read `/FORK.md` first. Rules: fork features are `BtExtension`s registered in `core/registry.ts`;
reusable logic in `core/` (no electron, both shells), shell-only glue in `server/` or `main/`;
never import fork code from upstream files except through the seams in FORK.md;
`src/bt/boundary.test.ts` must stay green. Upstream's own rules (root CLAUDE.md) still apply.
