#!/usr/bin/env bash
#
# The one sanctioned way to publish @yorm/* to npm.
#
# .github/workflows/release.yml is a thin wrapper around this script, so a
# release can always be reproduced locally:
#
#   ./scripts/release.sh --dry-run   # build + verify, publish nothing
#   ./scripts/release.sh             # the real thing (needs NODE_AUTH_TOKEN)
#
set -euo pipefail

cd "$(dirname "$0")/.."

DRY_RUN=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
  shift
fi
if [[ $# -gt 0 ]]; then
  echo "usage: $0 [--dry-run]" >&2
  exit 2
fi

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

step "Working tree check"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  if [[ "${ALLOW_DIRTY:-}" == "1" ]]; then
    echo "  dirty tree, continuing because ALLOW_DIRTY=1"
  else
    git status --short
    echo "error: refusing to publish from a dirty tree (set ALLOW_DIRTY=1 to override)" >&2
    exit 1
  fi
fi

step "Install (frozen lockfile)"
pnpm install --frozen-lockfile

# Stale-`dist` guard (release-plan Decision #6). `files` ships `dist`, so a
# leftover build from an older source tree would be published verbatim. A
# `prepack` hook would rebuild once per package; deleting and rebuilding here
# is one pass and covers every package at once.
step "Stale-dist guard: rebuild from scratch"
rm -rf packages/*/dist packages/*/*.tsbuildinfo
pnpm build

step "CI gate (lint, tests, publint, attw)"
pnpm run lint
pnpm test
pnpm run check:packages

step "Verify every publishable package emitted a dist"
for manifest in packages/*/package.json; do
  package_dir="$(dirname "$manifest")"
  if [[ ! -f "$package_dir/dist/index.js" || ! -f "$package_dir/dist/index.d.ts" ]]; then
    echo "error: $package_dir has no dist/index.{js,d.ts} after a full build" >&2
    exit 1
  fi
done

step "Publish${DRY_RUN:+ (dry run)}"
# pnpm publishes in topological order, so @yorm/core lands before its
# dependents and `workspace:*` ranges are rewritten to real versions.
# --no-git-checks: the tree check above is ours, and CI publishes from a
# detached-ish checkout that pnpm would otherwise reject.
# shellcheck disable=SC2086 # $DRY_RUN is an intentional word-split flag
pnpm --filter "./packages/*" publish --access public --no-git-checks $DRY_RUN

step "Done"
