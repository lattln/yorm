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

Locally, `release.sh` is only useful with `--dry-run`. Every package sets
`publishConfig.provenance: true`, which npm can only satisfy from a CI runner's
OIDC identity — a real publish from a workstation fails with
`EUSAGE … provider: null`, and `publishConfig` outranks any `--no-provenance`
flag or environment variable. Publish from
[release.yml](../.github/workflows/release.yml).

See [release-plan.md](../release-plan.md) for the release process and the
decisions behind it.
