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
tag (`bun add -g tokenhud@next`, `npm install -g tokenhud@next`). `next` only moves forward:
a prerelease older than the one on `next`, such as a candidate for a fix to an older line
(`0.1.2-rc.1` while `next` is `0.2.0-rc.1`), goes under `next-<major>.<minor>` instead
(`next-0.1`: `bun add -g tokenhud@next-0.1`), and the job's summary says so. A release moves
`tokenhud`'s `next` up to it too when it is newer than `next`, so `next` is never older than
`latest`; a `next` already on the following release's candidates stays. The platform
packages' tags don't matter: `tokenhud` names their exact version. `tokenhud update` on a bun or npm
install of a release candidate follows `next` while `next` is no older than it, and never
installs an older version unless given `--allow-downgrade`.

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
   - publishes the npm packages (`scripts/publish-npm.ts`): the platform packages first; then
     it waits until every one's tarball downloads from npm and matches its integrity,
     checking every 20 s for up to 30 min; and only then `tokenhud`, so a `tokenhud` on npm
     never lacks its binary. If the wait runs out, the job fails without publishing
     `tokenhud`; re-run it. A release then moves `tokenhud`'s `next` tag up to it (see
     above). The release is out by then, so if npm refuses, the job only warns, and its
     summary gives the command to run by hand (`npm dist-tag add tokenhud@X.Y.Z next`). Pull requests that touch the release path run `npm publish --dry-run` for
     every package, and CI installs and updates the packages with bun and with npm from a
     registry on localhost on Linux, macOS and Windows, and publishes them to one that
     serves a tarball late.

   No npm token is needed, nor any secret. npm authenticates the workflow as a trusted
   publisher (OIDC), which is set on npmjs.com in each package's settings: repository
   `ZhuoQiuMcgill/tokenhud`, workflow `release.yml`, no environment. The eight
   `@tokenhud/*` packages need to be allowed to publish; `tokenhud` also to set dist-tags
   ("Allow npm dist-tag"). If npm refuses, the job's error names the package whose
   settings to check. Setting a dist-tag this way takes npm 11.21.0 or later (12.2.0 on npm
   12), which the job pins; it checks npm's version before it publishes anything.

A run that failed for a passing reason (a runner outage, a network error) can be re-run
as it is: a release that already exists gets its assets replaced, and npm packages already
published are skipped. A run that failed because of the code needs a fix on `main` and a
new version; the next release candidate (`-rc.2`) is the usual way.
