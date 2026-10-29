#!/bin/sh
# Merge an upstream nodeterm release tag into bt/main on a review branch.
#   scripts/bt/sync-upstream.sh v0.4.6
# Leaves bt/sync-<tag> checked out; bt/main is only fast-forwarded by you after review.
set -eu
tag="${1:?usage: $0 <upstream tag, e.g. v0.4.6>}"
case "$tag" in v[0-9]*) ;; *) echo "not a release tag: $tag" >&2; exit 2 ;; esac

git diff --quiet && git diff --cached --quiet || { echo "working tree not clean" >&2; exit 1; }
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream https://github.com/eneskirca/nodeterm.git
git config rerere.enabled true   # remember conflict resolutions in the seams across syncs
git fetch --no-tags upstream "refs/tags/$tag:refs/tags/$tag"

git switch -c "bt/sync-$tag" bt/main
if ! git merge --no-ff --no-edit -m "Merge upstream $tag into BTnodeterm" "$tag"; then
  echo "Conflicts: resolve them (seams are listed in FORK.md), then 'git commit' and re-run the checks below." >&2
  exit 1
fi

sed -i.bak "s/^export const UPSTREAM_BASE = '.*'/export const UPSTREAM_BASE = '$tag'/" src/bt/shared/fork.ts && rm -f src/bt/shared/fork.ts.bak
git commit -q -am "bt: upstream base is now $tag"

npm run typecheck
npx vitest run src/bt src/server src/core/no-electron.test.ts
echo "OK. Review, then: git switch bt/main && git merge --ff-only bt/sync-$tag"
