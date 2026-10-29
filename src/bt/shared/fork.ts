/**
 * Identity of the BTnodeterm fork. Pure data: importable from every layer (core, server, main,
 * renderer). `UPSTREAM_BASE` is the upstream tag this branch was last synced to; the sync script
 * (scripts/bt/sync-upstream.sh) rewrites it, so do not reformat the line.
 */
export const FORK_NAME = 'BTnodeterm'
export const UPSTREAM_REPO = 'https://github.com/eneskirca/nodeterm'
export const UPSTREAM_BASE = 'v0.4.5'
