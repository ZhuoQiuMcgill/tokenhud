# Versioning

tokenhud follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). Versions
are `MAJOR.MINOR.PATCH`; the git tag is the version with a `v` in front (`v0.1.0`).

## While the version is 0.x

Until 1.0.0, the minor number plays the major's part:

| Change | Example |
|---|---|
| Breaking (see below) | 0.1.4 → 0.2.0 |
| New features, fixes, price corrections | 0.1.4 → 0.1.5 |

Read every 0.x minor release's changelog entry before you update scripts or agents that use
tokenhud.

## What counts as breaking

Anything that makes a working setup stop working:

- **The store.** A release that can't open the `tokenhud.db` an earlier release wrote,
  without migrating it in place. A migration that keeps all history is not breaking.
- **`tokenhud json` and `tokenhud doctor --json` output.** Removing or renaming a field, or
  changing its type or meaning. Such a change comes with a new `schema` number
  ([docs-public/JSON.md](docs-public/JSON.md)). Adding fields is not breaking.
- **The MCP tools.** Removing or renaming a tool or an argument, changing what an argument
  means, or removing or changing a field in a tool's result. Adding a tool, an optional
  argument or a result field is not breaking.
- **The command line.** Removing or renaming a command or an option, or changing an exit
  code's meaning.
- **Config files.** A `config.json` or `pricing.overrides.json` an earlier release accepted
  that this one rejects or reads differently.

Not breaking: the TUI's layout and keys, new or corrected prices (they reprice all history,
which is the point), and the numbers changing because of a counting fix the changelog
explains.

## Prereleases

A release candidate is `X.Y.Z-rc.N`, an earlier preview `X.Y.Z-beta.N`. A prerelease sorts
before its release (`0.1.0-rc.2` < `0.1.0`). Prereleases are published as GitHub
prereleases, which `install.sh`, `install.ps1` and `tokenhud update` install only when asked
(`TOKENHUD_VERSION=0.1.0-rc.2`, `tokenhud update --prerelease`), and on npm under the `next`
tag (`bun add -g tokenhud@next`, `npm install -g tokenhud@next`). A release moves `next` up
to it too, so `next` is never older than `latest`.

## Making a release

The version lives in `package.json` (the binary reads it at build time). The plugin's
`plugin/.claude-plugin/plugin.json` carries the same version.

1. In a pull request: set the version in both files, and in [CHANGELOG.md](CHANGELOG.md)
   move the `[Unreleased]` entries under `## [X.Y.Z] - YYYY-MM-DD`. Title it
   `chore(release): vX.Y.Z`.
2. After it merges, tag that commit on `main` and push the tag:

   ```sh
   git switch main && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

3. The Release workflow (`.github/workflows/release.yml`) does the rest:
   - checks that the tag is `v` + the package version, and stops otherwise;
   - builds all eight binaries and smoke-tests each on a machine that can run it;
   - checks the macOS signatures, re-signing ad hoc where `codesign --verify` fails;
   - runs `install.sh`, `install.ps1` and `tokenhud update` end to end on Linux, macOS and
     Windows;
   - creates the GitHub Release with the binaries and `SHA256SUMS`, as a prerelease when the
     tag has a suffix;
   - publishes the npm packages when the repository has an `NPM_TOKEN` secret, the platform
     packages first and then `tokenhud`, and otherwise logs `npm publish skipped (no
     NPM_TOKEN)`. Pull requests that touch the release path run `npm publish --dry-run` for
     every package, and CI installs and updates the packages with bun and with npm from a
     registry on localhost on Linux, macOS and Windows.

A run that failed for a passing reason (a runner outage, a network error) can be re-run
as it is: a release that already exists gets its assets replaced, and npm packages already
published are skipped. A run that failed because of the code needs a fix on `main` and a
new version; the next release candidate (`-rc.2`) is the usual way.
