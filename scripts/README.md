# scripts/

Executable entry points for repository-level workflows. GitHub Actions are thin
wrappers around these, so every CI step can be reproduced locally with the same
command.

| Script                   | Run it when                 | Called by                                                         |
| ------------------------ | --------------------------- | ----------------------------------------------------------------- |
| [release.sh](release.sh) | publishing `@yorm/*` to npm | [.github/workflows/release.yml](../.github/workflows/release.yml) |

Day-to-day checks are npm scripts, not scripts here: `pnpm run ci` (build →
lint → test → `publint`/`attw`) is what [ci.yml](../.github/workflows/ci.yml)
runs.

See [release-plan.md](../release-plan.md) for the release process and the
decisions behind it.
